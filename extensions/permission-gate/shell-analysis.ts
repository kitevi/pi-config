import { resolve } from "node:path";

type ScriptLanguage = "python" | "javascript" | "ruby" | "perl" | "php" | "awk";
type ScriptEffect = "mutate" | "exec" | "network";
export type PathEffect = { path: string; cwd: string };
type PipelineStage = { executable: string; elevated: boolean };

/** One resolved command: `env FOO=1 sudo rm -rf x` resolves to executable `sudo`. */
export type Invocation = {
	/** Lowercased basename of the executable, with a nushell `^` prefix removed. */
	executable: string;
	/** Executable exactly as written, so `./pi` stays distinguishable from `pi`. */
	raw: string;
	/** Arguments after the executable. */
	args: string[];
	/** The full lexed command, wrappers included. */
	words: string[];
};

/** Everything the rules need to know about one shell tool call. */
export type ShellAnalysis = {
	/** Every command found, including nested and interpreter-spawned ones. */
	commands: Invocation[];
	/** Inline interpreter bodies (`-c`, `-e`, heredoc, stdin). */
	scripts: Array<{ language: ScriptLanguage; code: string }>;
	/** Command text plus every nested string, for credential path scanning. */
	texts: string[];
	/** Resolved stages connected by an actual shell pipe. */
	pipelines: PipelineStage[][];
	/** Paths the call executes, resolved relative to the cwd active at that point. */
	executed: PathEffect[];
	/** Paths the call creates or overwrites, with their effective cwd. */
	written: PathEffect[];
};


export const HOME = process.env.HOME ? resolve(process.env.HOME) : undefined;

// ─── shell lexing ────────────────────────────────────────────────────────────

// This deliberately recognizes only the shell structures needed to identify
// process launches; it is behavior shaping, not a security sandbox. One lexer
// handles command boundaries, words, quoting, and nested command substitutions
// so those rules cannot drift apart.
type LexedCommand = { words: string[]; substitutions: ShellLexResult[] };
type ShellLexResult = { commands: LexedCommand[]; pipelines: LexedCommand[][]; endIndex: number };

const recoveredLookupWord = (commands: LexedCommand[], fallback: string) => {
	if (commands.length !== 1) return fallback;
	const [executable, ...args] = commands[0].words;
	if (executable.toLowerCase() === "which" && args.length === 1 && !args[0].startsWith("-")) return args[0];
	if (executable.toLowerCase() === "command" && args.length === 2 && args[0] === "-v") return args[1];
	return fallback;
};

const lexShellCommands = (source: string, startIndex = 0, terminator?: ")" | "`"): ShellLexResult => {
	const commands: LexedCommand[] = [];
	const pipelines: LexedCommand[][] = [];
	let pipeline: LexedCommand[] = [];
	let substitutions: ShellLexResult[] = [];
	let words: string[] = [];
	let current = "";
	let wordStarted = false;
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let afterPipe = false;

	const pushWord = () => {
		if (wordStarted) words.push(current);
		current = "";
		wordStarted = false;
	};
	const pushCommand = () => {
		pushWord();
		if (words.length > 0) {
			const command = { words, substitutions };
			commands.push(command);
			pipeline.push(command);
		}
		words = [];
		substitutions = [];
	};
	const finishPipeline = () => {
		pushCommand();
		if (pipeline.length > 1) pipelines.push(pipeline);
		pipeline = [];
		afterPipe = false;
	};

	for (let index = startIndex; index < source.length; index++) {
		const character = source[index];

		if (escaped) {
			current += character;
			wordStarted = true;
			escaped = false;
			afterPipe = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			if (source[index + 1] === "\n") {
				index++;
				continue;
			}
			if (source[index + 1] === "\r" && source[index + 2] === "\n") {
				index += 2;
				continue;
			}
			escaped = true;
			wordStarted = true;
			continue;
		}
		if (!quote && terminator && character === terminator) {
			finishPipeline();
			return { commands, pipelines, endIndex: index };
		}
		if (quote === "'") {
			if (character === "'") quote = undefined;
			else current += character;
			wordStarted = true;
			afterPipe = false;
			continue;
		}
		if (quote === '"' && character === '"') {
			quote = undefined;
			wordStarted = true;
			afterPipe = false;
			continue;
		}
		if (character === "$" && source[index + 1] === "(") {
			const nested = lexShellCommands(source, index + 2, ")");
			substitutions.push(nested);
			current += recoveredLookupWord(nested.commands, "$()");
			wordStarted = true;
			afterPipe = false;
			index = nested.endIndex;
			continue;
		}
		if (character === "`") {
			const nested = lexShellCommands(source, index + 1, "`");
			substitutions.push(nested);
			current += recoveredLookupWord(nested.commands, "``");
			wordStarted = true;
			afterPipe = false;
			index = nested.endIndex;
			continue;
		}
		if (quote) {
			current += character;
			wordStarted = true;
			afterPipe = false;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			wordStarted = true;
			afterPipe = false;
			continue;
		}
		if (character === "|" && source[index + 1] === "|") {
			finishPipeline();
			index++;
			continue;
		}
		if (character === "|") {
			pushCommand();
			afterPipe = true;
			if (source[index + 1] === "&") index++;
			continue;
		}
		if (character === "\n") {
			if (!afterPipe) finishPipeline();
			continue;
		}
		if (character === ";" || character === "&" || character === "(" || character === ")") {
			finishPipeline();
			if ((character === ";" || character === "&") && source[index + 1] === character) index++;
			continue;
		}
		if (/\s/.test(character)) {
			pushWord();
			continue;
		}

		current += character;
		wordStarted = true;
		afterPipe = false;
	}

	finishPipeline();
	return { commands, pipelines, endIndex: source.length };
};
export const normalize = (value: string) => value.replaceAll("\\", "/").toLowerCase();
// Nushell calls external commands as `^python`; the caret is not part of the name.
const executableBasename = (value: string) => (normalize(value).split("/").at(-1) ?? "").replace(/^\^/, "");
const isEnvironmentAssignment = (value: string) => /^[a-z_][a-z0-9_]*=/i.test(value);
const SHELL_CONTROL_PREFIXES = new Set(["!", "{", "do", "elif", "else", "if", "then", "time", "until", "while"]);
const OPTION_ONLY_PREFIXES = new Set(["exec", "nohup", "setsid", "stdbuf", "nice", "ionice"]);

type ResolvedCommandWords = { words: string[]; executableIndex: number };

/** A private normalized copy with shell prefixes removed and env -S expanded. */
const resolveCommandWords = (inputWords: string[]): ResolvedCommandWords | undefined => {
	const words = [...inputWords];
	let index = 0;

	while (index < words.length) {
		while (index < words.length && SHELL_CONTROL_PREFIXES.has(words[index])) index++;
		while (index < words.length && isEnvironmentAssignment(words[index])) index++;
		if (index >= words.length) return undefined;

		const executable = executableBasename(words[index]);
		if (executable === "command") {
			if (words[index + 1] === "-v" || words[index + 1] === "-V") return undefined;
			index++;
			while (words[index]?.startsWith("-")) index++;
			continue;
		}
		if (OPTION_ONLY_PREFIXES.has(executable)) {
			index++;
			while (words[index]?.startsWith("-") || /^\d+$/.test(words[index] ?? "")) index++;
			continue;
		}
		if (executable === "env") {
			index++;
			while (index < words.length) {
				const word = words[index];
				if (word === "-S" || word === "--split-string") {
					const splitWords = lexShellCommands(words[index + 1] ?? "").commands.at(0)?.words ?? [];
					words.splice(index, 2, ...splitWords);
					continue;
				}
				if (word.startsWith("--split-string=")) {
					const splitWords = lexShellCommands(word.slice("--split-string=".length)).commands.at(0)?.words ?? [];
					words.splice(index, 1, ...splitWords);
					continue;
				}
				if (word === "--") {
					index++;
					break;
				}
				if (isEnvironmentAssignment(word)) {
					index++;
					continue;
				}
				if (word.startsWith("-")) {
					index++;
					if (["-u", "--unset", "-C", "--chdir"].includes(word)) index++;
					continue;
				}
				break;
			}
			continue;
		}
		if (executable === "timeout") {
			index++;
			while (words[index]?.startsWith("-")) {
				const option = words[index++];
				if (["-s", "--signal", "-k", "--kill-after"].includes(option)) index++;
			}
			if (index < words.length) index++; // duration
			continue;
		}

		return { words, executableIndex: index };
	}

	return undefined;
};

// Wrappers that run another program as a subcommand. Unlike `sudo`, they carry no
// risk of their own, so the wrapped command replaces them entirely.
const RUNNER_WRAPPERS = new Map<string, { subcommand: string; valueOptions: Set<string> }>([
	["uv", { subcommand: "run", valueOptions: new Set(["--with", "--python", "-p", "--directory", "--project", "--extra", "--group", "--index"]) }],
	["poetry", { subcommand: "run", valueOptions: new Set(["-C", "--directory"]) }],
	["pipenv", { subcommand: "run", valueOptions: new Set([]) }],
	["rye", { subcommand: "run", valueOptions: new Set([]) }],
	["pdm", { subcommand: "run", valueOptions: new Set(["-p", "--project"]) }],
	["hatch", { subcommand: "run", valueOptions: new Set(["-e", "--env"]) }],
	["mise", { subcommand: "exec", valueOptions: new Set(["-C", "--cd"]) }],
]);

const skipWrapperOptions = (args: string[], valueOptions: Set<string>) => {
	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		if (arg === "--") return args.slice(index + 1);
		if (!arg.startsWith("-")) break;
		index += valueOptions.has(arg) ? 2 : 1;
	}
	return args.slice(index);
};

const resolveInvocation = (words: string[]): Invocation | undefined => {
	let current = words;

	for (let round = 0; round < 4; round++) {
		const resolved = resolveCommandWords(current);
		if (!resolved) return undefined;

		const { words: commandWords, executableIndex } = resolved;
		const raw = commandWords[executableIndex];
		const executable = executableBasename(raw);
		const args = commandWords.slice(executableIndex + 1);
		const wrapper = RUNNER_WRAPPERS.get(executable);
		if (wrapper && args[0] === wrapper.subcommand) {
			const rest = skipWrapperOptions(args.slice(1), wrapper.valueOptions);
			if (rest.length > 0) {
				current = rest;
				continue;
			}
		}
		return { executable, raw, args, words };
	}

	return undefined;
};

// ─── command model ───────────────────────────────────────────────────────────

const MAX_NESTING_DEPTH = 3;

export const PRIVILEGE_EXECUTABLES = new Set(["sudo", "doas", "pkexec"]);
const SHELL_EXECUTABLES = new Set(["bash", "sh", "zsh", "dash", "fish", "nu", "ksh", "ash"]);

type Interpreter = {
	pattern: RegExp;
	language: ScriptLanguage;
	inlineFlags: Set<string>;
	/** awk takes its program as the first positional argument instead of behind a flag. */
	positionalCode?: boolean;
	/** Options that consume the next word, so their value is not mistaken for code. */
	valueOptions?: Set<string>;
};

const INTERPRETERS: Interpreter[] = [
	{ pattern: /^(?:python|python2|python3(?:\.\d+)?|py|pypy|pypy3)$/, language: "python", inlineFlags: new Set(["-c"]) },
	{ pattern: /^(?:node|nodejs|bun|deno|tsx|ts-node)$/, language: "javascript", inlineFlags: new Set(["-e", "--eval", "-p", "--print"]) },
	{ pattern: /^(?:ruby|jruby)$/, language: "ruby", inlineFlags: new Set(["-e"]) },
	{ pattern: /^perl$/, language: "perl", inlineFlags: new Set(["-e", "-E"]) },
	{ pattern: /^php$/, language: "php", inlineFlags: new Set(["-r"]) },
	{
		pattern: /^(?:awk|gawk|mawk|nawk)$/,
		language: "awk",
		inlineFlags: new Set([]),
		positionalCode: true,
		valueOptions: new Set(["-v", "-f", "--file", "--assign"]),
	},
];

const interpreterFor = (executable: string) => INTERPRETERS.find((entry) => entry.pattern.test(executable));

const XARGS_OPTIONS_WITH_VALUES = new Set([
	"--arg-file",
	"--delimiter",
	"--eof",
	"--max-args",
	"--max-chars",
	"--max-lines",
	"--max-procs",
	"--replace",
	"-E",
	"-I",
	"-L",
	"-P",
	"-a",
	"-d",
	"-n",
	"-s",
]);

const xargsCommandArgs = (args: string[]) => {
	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		if (arg === "--") return args.slice(index + 1);
		if (XARGS_OPTIONS_WITH_VALUES.has(arg)) {
			index += 2;
			continue;
		}
		if (arg.startsWith("-")) {
			index++;
			continue;
		}
		return args.slice(index);
	}
	return [];
};

/** `find . -exec rm {} +` hides a command behind an option. */
const findExecCommands = (args: string[]) => {
	const commands: string[][] = [];
	for (let index = 0; index < args.length; index++) {
		if (args[index] !== "-exec" && args[index] !== "-execdir" && args[index] !== "-ok") continue;
		const command: string[] = [];
		for (let cursor = index + 1; cursor < args.length; cursor++) {
			if (args[cursor] === ";" || args[cursor] === "+" || args[cursor] === "\\;") break;
			command.push(args[cursor]);
		}
		if (command.length > 0) commands.push(command);
	}
	return commands;
};

const HEREDOC_PATTERN = /<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1[ \t]*\r?\n([\s\S]*?)(?:\r?\n[ \t]*\2(?![A-Za-z0-9_])|$)/g;

/** Pull heredoc bodies out of the text and remember which command they feed. */
const extractHeredocs = (source: string) => {
	const segments: Array<{ owner: string; body: string }> = [];
	let stripped = "";
	let lastIndex = 0;

	for (const match of source.matchAll(HEREDOC_PATTERN)) {
		const start = match.index ?? 0;
		const lineStart = source.lastIndexOf("\n", start) + 1;
		segments.push({ owner: source.slice(lineStart, start), body: match[3] ?? "" });
		stripped += source.slice(lastIndex, start);
		lastIndex = start + match[0].length;
	}
	stripped += source.slice(lastIndex);

	return { stripped, segments };
};

const REDIRECTION_WORD = /^(?:\d*|&)>{1,2}(.*)$/;
const isDevNull = (path: string) => /^\/?dev\/null$/i.test(path);

const redirectionTargets = (words: string[]) => {
	const targets: string[] = [];
	for (let index = 0; index < words.length; index++) {
		const match = words[index].match(REDIRECTION_WORD);
		if (!match) continue;
		const target = match[1] || words[++index];
		if (target && !target.startsWith("&") && !isDevNull(target)) targets.push(target);
	}
	return targets;
};

// Command strings embedded in interpreter code. The list form of subprocess is
// already a word array, so it is captured separately.
const SCRIPT_COMMAND_STRINGS = [
	/\bos\.(?:system|popen)\s*\(\s*(["'])([\s\S]*?)\1/g,
	/\bsubprocess\.(?:run|call|check_call|check_output|Popen)\s*\(\s*(["'])([\s\S]*?)\1/g,
	/\b(?:execSync|execFileSync|exec|spawnSync|spawn)\s*\(\s*(["'`])([\s\S]*?)\1/g,
	/\b(?:system|shell_exec|passthru)\s*\(\s*(["'])([\s\S]*?)\1/g,
	/\bIO\.popen\s*\(\s*(["'])([\s\S]*?)\1/g,
];
const SCRIPT_COMMAND_LISTS = /\b(?:subprocess\.(?:run|call|check_call|check_output|Popen)|execFileSync|spawnSync|spawn)\s*\(\s*\[([^\]]*)\]/g;
const QUOTED_LIST_ITEM = /(["'])((?:\\.|(?!\1)[^\\])*)\1/g;

const SCRIPT_EFFECTS: Array<{ kind: ScriptEffect; languages?: ScriptLanguage[]; pattern: RegExp }> = [
	// python
	{ kind: "mutate", languages: ["python"], pattern: /\bopen\s*\([^)]*,\s*(["'])[^"']*[wax+][^"']*\1/ },
	{ kind: "mutate", languages: ["python"], pattern: /\b(?:write_text|write_bytes|writelines)\s*\(/ },
	{ kind: "mutate", languages: ["python"], pattern: /\bos\.(?:remove|unlink|rmdir|removedirs|rename|replace|truncate|chmod|chown)\s*\(/ },
	{ kind: "mutate", languages: ["python"], pattern: /\bshutil\.(?:rmtree|move|chown|copystat)\s*\(/ },
	// Deliberately not `.rename(` or `.replace(`: those are ordinary string and
	// dataframe methods, and asking on them would make the rule noise.
	{ kind: "mutate", languages: ["python"], pattern: /\.\s*(?:unlink|rmdir|chmod)\s*\(/ },
	{ kind: "exec", languages: ["python"], pattern: /\b(?:subprocess|os\.system|os\.popen|os\.exec|pty\.spawn)\b/ },
	// Decoding then running a payload is never an innocent one-liner.
	{ kind: "exec", languages: ["python"], pattern: /\b(?:exec|eval)\s*\(/ },
	{ kind: "exec", languages: ["python"], pattern: /\b(?:b64decode|marshal\.loads|pickle\.loads|codecs\.decode)\b/ },
	{ kind: "network", languages: ["python"], pattern: /\b(?:requests|httpx)\.(?:post|put|patch|delete)\s*\(/ },
	{ kind: "network", languages: ["python"], pattern: /\b(?:urllib\.request|http\.client|ftplib|smtplib|paramiko|boto3|socket)\b/ },
	// javascript
	{ kind: "mutate", languages: ["javascript"], pattern: /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|truncate|truncateSync|copyFile|copyFileSync|renameSync|rename|chmodSync|chownSync)\s*\(/ },
	{ kind: "mutate", languages: ["javascript"], pattern: /\b(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\s*\(/ },
	{ kind: "exec", languages: ["javascript"], pattern: /\b(?:child_process|execSync|execFileSync|spawnSync|Bun\.spawn|Deno\.Command)\b/ },
	{ kind: "network", languages: ["javascript"], pattern: /\b(?:fetch\s*\(|axios\.(?:post|put|patch|delete)|https?\.request|net\.(?:connect|Socket))/ },
	// ruby / perl / php
	{ kind: "mutate", languages: ["ruby"], pattern: /\b(?:File\.(?:write|delete|unlink|rename|chmod)|FileUtils\.(?:rm|rm_rf|rm_r|mv|chmod)|IO\.write)\b/ },
	{ kind: "exec", languages: ["ruby"], pattern: /\b(?:system\s*\(|IO\.popen|Process\.spawn|`)/ },
	{ kind: "network", languages: ["ruby"], pattern: /\b(?:Net::HTTP|open-uri|Socket)\b/ },
	{ kind: "mutate", languages: ["perl"], pattern: /\b(?:unlink|rename|chmod|truncate)\b|\bopen\s*\([^,]*,\s*(["'])\s*>{1,2}/ },
	{ kind: "exec", languages: ["perl"], pattern: /\b(?:system\s*\(|exec\s*\(|qx\{|`)/ },
	{ kind: "network", languages: ["perl"], pattern: /\b(?:LWP|HTTP::Request|IO::Socket)\b/ },
	{ kind: "mutate", languages: ["php"], pattern: /\b(?:file_put_contents|unlink|rename|chmod|ftruncate)\s*\(/ },
	{ kind: "exec", languages: ["php"], pattern: /\b(?:exec|shell_exec|system|passthru|proc_open)\s*\(/ },
	{ kind: "network", languages: ["php"], pattern: /\b(?:curl_exec|file_get_contents\s*\(\s*["']https?:|fsockopen)/ },
	// awk: `{print $1}` is everyday text processing, redirecting or shelling out is not.
	{ kind: "mutate", languages: ["awk"], pattern: /\bprintf?\b[^;{}]*>\s*["(]/ },
	{ kind: "exec", languages: ["awk"], pattern: /\bsystem\s*\(|\|\s*&?\s*"?\s*(?:sh|bash|zsh)\b/ },
];

// SSH key material assembled from parts never appears as a path mention. The
// filenames themselves are specific enough to act on inside interpreter code.
const SSH_KEY_TOKEN = /\bid_(?:rsa|dsa|ecdsa|ed25519|ed25519_sk|ecdsa_sk)\b/;
export const scriptNamesPrivateKey = (analysis: ShellAnalysis) => analysis.scripts.some((script) => SSH_KEY_TOKEN.test(script.code));

export type AnalyzedScript = ShellAnalysis["scripts"][number];

export const effectsForScript = (script: AnalyzedScript): Set<ScriptEffect> => {
	const effects = new Set<ScriptEffect>();
	for (const effect of SCRIPT_EFFECTS) {
		if (effect.languages && !effect.languages.includes(script.language)) continue;
		if (effect.pattern.test(script.code)) effects.add(effect.kind);
	}
	return effects;
};

export const scriptEffects = (analysis: ShellAnalysis): Set<ScriptEffect> => {
	const effects = new Set<ScriptEffect>();
	for (const script of analysis.scripts) {
		for (const effect of effectsForScript(script)) effects.add(effect);
	}
	return effects;
};

const emptyAnalysis = (): ShellAnalysis => ({ commands: [], scripts: [], texts: [], pipelines: [], executed: [], written: [] });

export const analyzeShellCommand = (source: string): ShellAnalysis => {
	const analysis = emptyAnalysis();
	collectSource(source, analysis, 0, process.cwd());
	return analysis;
};

const workingDirectoryAfter = (words: string[], cwd: string) => {
	const invocation = resolveInvocation(words);
	if (invocation?.executable !== "cd") return cwd;
	const target = invocation.args.find((arg) => !arg.startsWith("-")) ?? HOME;
	return target ? resolve(cwd, expandPath(target)) : cwd;
};

function collectLexedCommands(lexed: ShellLexResult, analysis: ShellAnalysis, depth: number, cwd: string) {
	if (depth > MAX_NESTING_DEPTH) return cwd;

	for (const pipeline of lexed.pipelines) {
		const stages = pipeline
			.map((command) => resolvePipelineStage(command.words))
			.filter((stage): stage is PipelineStage => stage !== undefined);
		if (stages.length > 1) analysis.pipelines.push(stages);
	}

	let currentCwd = cwd;
	for (const command of lexed.commands) {
		for (const substitution of command.substitutions) {
			collectLexedCommands(substitution, analysis, depth + 1, currentCwd);
		}
		analysis.written.push(...redirectionTargets(command.words).map((path) => ({ path, cwd: currentCwd })));
		collectCommand(command.words, analysis, depth, currentCwd);
		currentCwd = workingDirectoryAfter(command.words, currentCwd);
	}
	return currentCwd;
}

function collectSource(source: string, analysis: ShellAnalysis, depth: number, cwd: string) {
	const text = source.trim();
	if (text.length === 0 || depth > MAX_NESTING_DEPTH) return;

	analysis.texts.push(text);

	const { stripped, segments } = extractHeredocs(text);
	const currentCwd = collectLexedCommands(lexShellCommands(stripped), analysis, depth, cwd);
	for (const segment of segments) {
		collectHeredoc(segment, analysis, depth, currentCwd);
	}
}
function collectHeredoc(segment: { owner: string; body: string }, analysis: ShellAnalysis, depth: number, cwd: string) {
	const ownerWords = lexShellCommands(segment.owner).commands.at(-1)?.words ?? [];
	const invocation = resolveInvocation(ownerWords);
	const interpreter = invocation ? interpreterFor(invocation.executable) : undefined;

	if (interpreter) {
		collectScript(interpreter.language, segment.body, analysis, depth, cwd);
		return;
	}
	if (invocation && SHELL_EXECUTABLES.has(invocation.executable)) {
		collectSource(segment.body, analysis, depth + 1, cwd);
		return;
	}
	// Anything else (`cat > file <<EOF`) is data, but it can still name a
	// credential path, so keep it scannable.
	analysis.texts.push(segment.body);
}

function collectCommand(words: string[], analysis: ShellAnalysis, depth: number, cwd: string) {
	if (words.length === 0 || depth > MAX_NESTING_DEPTH) return;

	const invocation = resolveInvocation(words);
	if (!invocation) return;
	analysis.commands.push(invocation);

	const { executable, args } = invocation;

	if (PRIVILEGE_EXECUTABLES.has(executable)) {
		collectCommand(stripPrivilegeOptions(args), analysis, depth + 1, cwd);
		return;
	}
	if (SHELL_EXECUTABLES.has(executable)) {
		collectShellInvocation(args, analysis, depth, cwd);
		return;
	}
	if (executable === "source" || executable === ".") {
		const path = args.find((arg) => !arg.startsWith("-"));
		if (path) analysis.executed.push({ path, cwd });
		return;
	}
	if (executable === "eval") {
		collectSource(args.join(" "), analysis, depth + 1, cwd);
		return;
	}
	if (executable === "xargs") {
		collectCommand(xargsCommandArgs(args), analysis, depth + 1, cwd);
		return;
	}
	if (executable === "find") {
		for (const nested of findExecCommands(args)) collectCommand(nested, analysis, depth + 1, cwd);
		return;
	}
	if (executable === "tee") {
		analysis.written.push(...args.filter((arg) => !arg.startsWith("-") && !isDevNull(arg)).map((path) => ({ path, cwd })));
		return;
	}
	if (executable === "curl" || executable === "wget") {
		analysis.written.push(...downloadTargets(args).map((path) => ({ path, cwd })));
		return;
	}

	const interpreter = interpreterFor(executable);
	if (interpreter) {
		collectInterpreter(interpreter, args, analysis, depth, cwd);
		return;
	}
	if (looksLikePath(invocation.raw)) {
		analysis.executed.push({ path: invocation.raw, cwd });
	}
}

const PRIVILEGE_OPTIONS_WITH_VALUES = new Set([
	"-u",
	"--user",
	"-g",
	"--group",
	"-p",
	"--prompt",
	"-C",
	"--close-from",
	"-D",
	"--chdir",
]);

const stripPrivilegeOptions = (args: string[]) => {
	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		if (arg === "--") return args.slice(index + 1);
		if (!arg.startsWith("-")) break;
		index += PRIVILEGE_OPTIONS_WITH_VALUES.has(arg) ? 2 : 1;
	}
	return args.slice(index);
};

const resolvePipelineStage = (words: string[]): PipelineStage | undefined => {
	let invocation = resolveInvocation(words);
	let elevated = false;
	for (let depth = 0; invocation && PRIVILEGE_EXECUTABLES.has(invocation.executable) && depth < MAX_NESTING_DEPTH; depth++) {
		elevated = true;
		invocation = resolveInvocation(stripPrivilegeOptions(invocation.args));
	}
	return invocation ? { executable: invocation.executable, elevated } : undefined;
};

const collectShellInvocation = (args: string[], analysis: ShellAnalysis, depth: number, cwd: string) => {
	let sawInlineFlag = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--command" || arg === "-c" || /^-[a-z]*c[a-z]*$/i.test(arg)) {
			const body = args[index + 1];
			if (body) {
				collectSource(body, analysis, depth + 1, cwd);
				sawInlineFlag = true;
				index++;
			}
			continue;
		}
		if (arg.startsWith("-")) continue;
		if (!sawInlineFlag) analysis.executed.push({ path: arg, cwd });
		break;
	}
};

const DOWNLOAD_OPTIONS = new Set(["-o", "--output", "-O", "--output-document"]);

const downloadTargets = (args: string[]) =>
	args
		.map((arg, index) => (DOWNLOAD_OPTIONS.has(arg) ? args[index + 1] : undefined))
		.filter((target): target is string => typeof target === "string" && target.length > 0 && !isDevNull(target));

const collectInterpreter = (interpreter: Interpreter, args: string[], analysis: ShellAnalysis, depth: number, cwd: string) => {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];

		if (interpreter.inlineFlags.has(arg)) {
			const code = args[index + 1];
			if (code) collectScript(interpreter.language, code, analysis, depth, cwd);
			index++;
			continue;
		}
		// `python -c'code'` lexes to a single word.
		const attached = [...interpreter.inlineFlags].find((flag) => arg.length > flag.length && arg.startsWith(flag));
		if (attached) {
			collectScript(interpreter.language, arg.slice(attached.length), analysis, depth, cwd);
			continue;
		}
		if (interpreter.valueOptions?.has(arg)) {
			index++;
			continue;
		}
		if (arg === "-" || arg.startsWith("-")) continue;
		if (interpreter.positionalCode) {
			if (isEnvironmentAssignment(arg)) continue;
			collectScript(interpreter.language, arg, analysis, depth, cwd);
			return;
		}

		analysis.executed.push({ path: arg, cwd });
		return;
	}
};

function collectScript(language: ScriptLanguage, code: string, analysis: ShellAnalysis, depth: number, cwd: string) {
	if (code.trim().length === 0 || depth > MAX_NESTING_DEPTH) return;

	analysis.scripts.push({ language, code });
	analysis.texts.push(code);

	for (const pattern of SCRIPT_COMMAND_STRINGS) {
		for (const match of code.matchAll(pattern)) {
			collectSource(match[2] ?? "", analysis, depth + 1, cwd);
		}
	}
	for (const match of code.matchAll(SCRIPT_COMMAND_LISTS)) {
		const words = [...(match[1] ?? "").matchAll(QUOTED_LIST_ITEM)].map(([, , item]) => item);
		collectCommand(words, analysis, depth + 1, cwd);
	}
}

const looksLikePath = (value: string) => value.includes("/") || /\.(?:sh|bash|zsh|fish|nu|py|js|mjs|cjs|ts|rb|pl|php)$/i.test(value);

export const expandPath = (path: string) => path.replace(/^~(?=\/|$)/, HOME ?? "~");
export const normalizedPath = (path: string) => normalize(resolve(expandPath(path)));
