/**
 * Permission Gate Extension
 *
 * Runtime note:
 * - This file is intentionally written as plain-Node-runnable, erasable TypeScript.
 * - Keep TypeScript syntax to forms Node can strip directly: `type`, `import type`,
 *   const assertions, etc.
 * - Avoid enums, namespaces, decorators, parameter properties, or other TS constructs
 *   requiring transpilation.
 * - Tests live in tests/permission-gate.test.ts and run with `npm test`.
 *
 * Purpose:
 * - This is a behavior-shaping guardrail, not a sandbox.
 * - It allows normal agent work, including reads/writes outside the workspace and /tmp.
 * - It interrupts dangerous shell/tool calls with explicit rule-based decisions.
 * - It does not use risk scoring. Rules either allow, ask, or block.
 * - Block rules always win over ask rules.
 *
 * HOW A SHELL CALL IS READ:
 * - One lexer recovers every command in the call, not just the top-level text:
 *   pipelines, command substitutions, heredocs, `sh -c` bodies, `eval`, `xargs`,
 *   `find -exec`, privilege wrappers (`sudo`), runner wrappers (`uv run`,
 *   `mise exec`), and the command strings embedded in inline interpreter code
 *   (`python -c "os.system(...)"`, `node -e "execSync(...)"`).
 * - Rules match on resolved executables and lexed words, so quoting alone cannot
 *   hide a command from them: `sh -c 'rm -rf x'` is seen as `rm`.
 * - Inline interpreter bodies are additionally scanned for file mutation, process
 *   spawning, and outbound network calls.
 * - A script is Turing-complete and this is static text matching. The gate raises
 *   the cost of an accidental bypass. It cannot stop a determined one; for that,
 *   run Pi in a container.
 *
 * BLOCKS:
 * 1. Credential/private material reads or writes:
 *    - SSH private keys and known credential files
 *    - GPG material
 *    - private key/cert files: .pem, .key, .p12, .pfx
 *    - cloud/container credential files such as AWS, gcloud, Azure, Docker auth
 *    - NOTE: .env, .envrc, .npmrc, .netrc are intentionally NOT blocked
 * 2. Catastrophic disk/system commands:
 *    - mkfs
 *    - dd writing to /dev/*
 *    - sudo rm
 *    - chmod -R 777 / or equivalent root-wide permission changes
 *    - curl/wget piped into sudo shell execution
 * 3. Writes to pseudo-filesystems:
 *    - /dev, /proc, /sys
 * 4. Agent-controlled nested Pi agent runs through bash/nu:
 *    - blocks print/JSON modes and interactive startup with an initial prompt
 *    - allows Pi management, export, diagnostics, and promptless startup for troubleshooting
 *    - does not affect Pi launched directly by the user from a terminal or with `!`
 * 5. Git commands using --no-verify to bypass hooks.
 *
 * ASKS:
 * 1. Any command that deletes files: rm, rmdir, shred, `find -delete`.
 * 2. Shell-side file mutation via chmod, chown, tee, truncate, dd, in-place
 *    `sed -i`/`perl -pi`, and nushell `save`.
 * 3. Inline interpreter code (python, node, ruby, perl, php, awk) that writes
 *    files, spawns processes, sends data, or runs a decoded payload.
 * 4. Running a script this session created (write/edit tool, redirection, tee).
 * 5. Sudo/elevated commands unless already blocked.
 * 6. Destructive Git commands: reset --hard, clean -f, checkout -- ., restore ., force push.
 * 7. Commits.
 * 8. Mutating package manager commands across npm/pnpm/yarn/bun, pip/uv/pipx/poetry,
 *    cargo, go, gem, brew, and system package managers.
 * 9. Network upload, push, remote execution, or credentialed network calls:
 *    - git push, ssh, scp, rsync, nc, socat
 *    - curl/wget upload, data, auth-header, or mutating-method flags
 *    - curl/wget piped into a shell
 *    - NOTE: download-to-file (curl -o, wget -O) is intentionally NOT asked.
 *
 * ALLOWS:
 * 1. Normal structured reads/writes, including outside the workspace and /tmp.
 * 2. Tests, builds, lints, typechecks.
 * 3. Plain network fetches/searches.
 * 4. Reading documentation, dependencies, and generated scratch files.
 * 5. .env, .envrc, .npmrc, .netrc files (low-stakes project config).
 * 6. Basic shell operations: touch, mkdir, mv, cp, file redirections, npx, bunx.
 * 7. Inline interpreter code with no detected side effect.
 * 8. Non-agent Pi CLI operations: management, export, diagnostics, and promptless startup.
 *
 * ASK OUTCOMES:
 * - Allowed: the call runs.
 * - Declined (explicit "no" or dismissal): the call is blocked and the turn is
 *   aborted, so the model cannot immediately try another form.
 * - Timed out (nobody answered): the call is blocked and the turn is aborted
 *   too — the user stepped away, so unattended work stops there rather than
 *   continuing without permission. The model gets timeout wording, not the
 *   decline wording: "nobody answered" is not "you said no".
 * - In every blocked case the reason is delivered to the model twice: as the tool
 *   result, and as a next-turn message. The second delivery matters because pi's
 *   agent loop checks the abort signal before the block reason, so an aborted
 *   turn would otherwise show the model a bare "Operation aborted".
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";

// ─── policy surface ──────────────────────────────────────────────────────────

type Decision = "allow" | "ask" | "block";
type ToolInput = Record<string, unknown>;

type ScriptLanguage = "python" | "javascript" | "ruby" | "perl" | "php" | "awk";
type ScriptEffect = "mutate" | "exec" | "network";

/** One resolved command: `env FOO=1 sudo rm -rf x` resolves to executable `sudo`. */
type Invocation = {
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
type ShellAnalysis = {
	/** Every command found, including nested and interpreter-spawned ones. */
	commands: Invocation[];
	/** Inline interpreter bodies (`-c`, `-e`, heredoc, stdin). */
	scripts: Array<{ language: ScriptLanguage; code: string }>;
	/** Command text plus every nested string, for path scanning. */
	texts: string[];
	/** Paths the call executes: script arguments, `./script`, `bash script.sh`. */
	executed: string[];
	/** Paths the call creates or overwrites: redirections, tee, curl -o. */
	written: string[];
};

type ToolCall = {
	toolName: string;
	input: ToolInput;
	/** Present only for shell tools. */
	shell?: ShellAnalysis;
};

type Match = {
	id: string;
	decision: Exclude<Decision, "allow">;
	description: string;
	guidance: string;
};

type Rule = {
	id: string;
	decision: Exclude<Decision, "allow">;
	description: string;
	guidance: string;
	matches: (call: ToolCall) => boolean;
};

type Assessment = {
	decision: Decision;
	matches: Match[];
	target: string;
};

// Kept short and imperative on purpose. Small models follow "do X instead"
// better than they follow an explanation of why the rule exists.
const GUIDANCE = {
	credentials: "Credential material is blocked. Ask the user for a redacted value instead.",
	catastrophic: "System-destroying command. Stop; do not retry it in another form.",
	nestedPi:
		"No nested Pi agents. Do the work in this context, or say the subagent tool is unavailable. Non-agent Pi commands still work. For deliberate nested-agent testing the user relaunches the parent as `PI_PERMISSION_GATE_ALLOW_NESTED_PI=1 pi`; setting that variable inside the child command does not opt in.",
	pseudoFs: "Do not write to /dev, /proc, or /sys. Ask the user to do it manually.",
	rm: "This deletes files. Confirm only if deletion is intended.",
	shellWrite: "This mutates files from the shell. Prefer the edit/write tools.",
	inlineScript: "Inline interpreter code that writes files, spawns processes, or sends data. Prefer the edit/write tools, or a script file the user can read first.",
	generatedScript: "This runs a script created during this session. Say what the script does before running it.",
	sudo: "This uses elevated privileges. Confirm only if necessary.",
	gitDestructive: "This can discard work or rewrite remote history.",
	gitCommit: "This creates a commit. Confirm before writing history.",
	noVerify: "Do not bypass git hooks. Fix what makes the hook fail, or ask the user.",
	packageManager: "This changes dependencies or runs downloaded code.",
	networkRisk: "This sends data out, pushes, or executes remote content.",
} as const;

const READ_TOOLS = new Set(["read", "grep", "find", "ls", "ast_search"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
const SHELL_TOOLS = new Set(["bash", "nu"]);

// ─── environment ─────────────────────────────────────────────────────────────

const HOME = process.env.HOME ? resolve(process.env.HOME) : undefined;

// Ask dialogs auto-dismiss after this many ms. Override with PI_GATE_ASK_TIMEOUT_MS.
// Read per ask, not at module load, so tests can shorten the countdown and a
// mid-session env change takes effect without a restart.
const askTimeoutMs = () => {
	const override = Number(process.env.PI_GATE_ASK_TIMEOUT_MS);
	return override > 0 ? override : 60000;
};
// Backstop abort in case the host dialog ignores its own timeout, plus the slack
// used to tell "the countdown ran out" from "the user dismissed it at the end".
const ASK_TIMEOUT_BACKSTOP_MS = 2000;
const ASK_TIMEOUT_SLACK_MS = 500;

const ASK_ALLOW = "Yes, allow once";
const ASK_DENY = "No, block it";

const NESTED_PI_OVERRIDE_ENV = "PI_PERMISSION_GATE_ALLOW_NESTED_PI";
const nestedPiOverrideEnabled = () => /^(?:1|true|yes|on)$/i.test(process.env[NESTED_PI_OVERRIDE_ENV]?.trim() ?? "");

// ─── shell lexing ────────────────────────────────────────────────────────────

// This deliberately recognizes only the shell structures needed to identify
// process launches; it is behavior shaping, not a security sandbox. One lexer
// handles command boundaries, words, quoting, and nested command substitutions
// so those rules cannot drift apart.
type ShellLexResult = { commands: string[][]; endIndex: number };

const lexShellCommands = (source: string, startIndex = 0, terminator?: ")" | "`"): ShellLexResult => {
	const commands: string[][] = [];
	let words: string[] = [];
	let current = "";
	let wordStarted = false;
	let quote: "'" | '"' | undefined;
	let escaped = false;

	const pushWord = () => {
		if (wordStarted) words.push(current);
		current = "";
		wordStarted = false;
	};
	const pushCommand = () => {
		pushWord();
		if (words.length > 0) commands.push(words);
		words = [];
	};

	for (let index = startIndex; index < source.length; index++) {
		const character = source[index];

		if (escaped) {
			current += character;
			wordStarted = true;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			wordStarted = true;
			continue;
		}
		if (!quote && terminator && character === terminator) {
			pushCommand();
			return { commands, endIndex: index };
		}
		if (quote === "'") {
			if (character === "'") quote = undefined;
			else current += character;
			wordStarted = true;
			continue;
		}
		if (quote === '"' && character === '"') {
			quote = undefined;
			wordStarted = true;
			continue;
		}
		if (character === "$" && source[index + 1] === "(") {
			const nested = lexShellCommands(source, index + 2, ")");
			commands.push(...nested.commands);
			current += "$()";
			wordStarted = true;
			index = nested.endIndex;
			continue;
		}
		if (character === "`") {
			const nested = lexShellCommands(source, index + 1, "`");
			commands.push(...nested.commands);
			current += "``";
			wordStarted = true;
			index = nested.endIndex;
			continue;
		}
		if (quote) {
			current += character;
			wordStarted = true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			wordStarted = true;
			continue;
		}
		if (character === "\n" || /[;|&()]/.test(character)) {
			pushCommand();
			continue;
		}
		if (/\s/.test(character)) {
			pushWord();
			continue;
		}

		current += character;
		wordStarted = true;
	}

	pushCommand();
	return { commands, endIndex: source.length };
};

const normalize = (value: string) => value.replaceAll("\\", "/").toLowerCase();
// Nushell calls external commands as `^python`; the caret is not part of the name.
const executableBasename = (value: string) => (normalize(value).split("/").at(-1) ?? "").replace(/^\^/, "");
const isEnvironmentAssignment = (value: string) => /^[a-z_][a-z0-9_]*=/i.test(value);
const SHELL_CONTROL_PREFIXES = new Set(["!", "{", "do", "elif", "else", "if", "then", "time", "until", "while"]);
const OPTION_ONLY_PREFIXES = new Set(["exec", "nohup", "setsid", "stdbuf", "nice", "ionice"]);

/** Index of the word that actually names the process, after shell noise. */
const commandExecutableIndex = (words: string[]): number => {
	let index = 0;

	while (index < words.length) {
		while (index < words.length && SHELL_CONTROL_PREFIXES.has(words[index])) index++;
		while (index < words.length && isEnvironmentAssignment(words[index])) index++;
		if (index >= words.length) return -1;

		const executable = executableBasename(words[index]);
		if (executable === "command") {
			if (words[index + 1] === "-v" || words[index + 1] === "-V") return -1;
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

		return index;
	}

	return -1;
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
		const index = commandExecutableIndex(current);
		if (index < 0) return undefined;

		const raw = current[index];
		const executable = executableBasename(raw);
		const args = current.slice(index + 1);
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

const PRIVILEGE_EXECUTABLES = new Set(["sudo", "doas", "pkexec"]);
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

const REDIRECTION_PATTERN = /(?:^|[\s;|&])\d?>{1,2}\s*("[^"]*"|'[^']*'|[^\s;|&<>)]+)/g;
const isDevNull = (path: string) => /^\/?dev\/null$/i.test(path);

const redirectionTargets = (source: string) =>
	[...source.matchAll(REDIRECTION_PATTERN)]
		.map(([, target]) => target.replace(/^["']|["']$/g, ""))
		.filter((target) => target.length > 0 && !isDevNull(target));

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
const scriptNamesPrivateKey = (analysis: ShellAnalysis) => analysis.scripts.some((script) => SSH_KEY_TOKEN.test(script.code));

const scriptEffects = (analysis: ShellAnalysis): Set<ScriptEffect> => {
	const effects = new Set<ScriptEffect>();
	for (const script of analysis.scripts) {
		for (const effect of SCRIPT_EFFECTS) {
			if (effect.languages && !effect.languages.includes(script.language)) continue;
			if (effect.pattern.test(script.code)) effects.add(effect.kind);
		}
	}
	return effects;
};

const emptyAnalysis = (): ShellAnalysis => ({ commands: [], scripts: [], texts: [], executed: [], written: [] });

const analyzeShellCommand = (source: string): ShellAnalysis => {
	const analysis = emptyAnalysis();
	collectSource(source, analysis, 0);
	return analysis;
};

function collectSource(source: string, analysis: ShellAnalysis, depth: number) {
	const text = source.trim();
	if (text.length === 0 || depth > MAX_NESTING_DEPTH) return;

	analysis.texts.push(text);

	const { stripped, segments } = extractHeredocs(text);
	analysis.written.push(...redirectionTargets(stripped));

	for (const words of lexShellCommands(stripped).commands) {
		collectCommand(words, analysis, depth);
	}
	for (const segment of segments) {
		collectHeredoc(segment, analysis, depth);
	}
}

function collectHeredoc(segment: { owner: string; body: string }, analysis: ShellAnalysis, depth: number) {
	const ownerWords = lexShellCommands(segment.owner).commands.at(-1) ?? [];
	const invocation = resolveInvocation(ownerWords);
	const interpreter = invocation ? interpreterFor(invocation.executable) : undefined;

	if (interpreter) {
		collectScript(interpreter.language, segment.body, analysis, depth);
		return;
	}
	if (invocation && SHELL_EXECUTABLES.has(invocation.executable)) {
		collectSource(segment.body, analysis, depth + 1);
		return;
	}
	// Anything else (`cat > file <<EOF`) is data, but it can still name a
	// credential path, so keep it scannable.
	analysis.texts.push(segment.body);
}

function collectCommand(words: string[], analysis: ShellAnalysis, depth: number) {
	if (words.length === 0 || depth > MAX_NESTING_DEPTH) return;

	const invocation = resolveInvocation(words);
	if (!invocation) return;
	analysis.commands.push(invocation);

	const { executable, args } = invocation;

	if (PRIVILEGE_EXECUTABLES.has(executable)) {
		collectCommand(stripPrivilegeOptions(args), analysis, depth + 1);
		return;
	}
	if (SHELL_EXECUTABLES.has(executable)) {
		collectShellInvocation(args, analysis, depth);
		return;
	}
	if (executable === "eval") {
		collectSource(args.join(" "), analysis, depth + 1);
		return;
	}
	if (executable === "xargs") {
		collectCommand(xargsCommandArgs(args), analysis, depth + 1);
		return;
	}
	if (executable === "find") {
		for (const nested of findExecCommands(args)) collectCommand(nested, analysis, depth + 1);
		return;
	}
	if (executable === "tee") {
		analysis.written.push(...args.filter((arg) => !arg.startsWith("-") && !isDevNull(arg)));
		return;
	}
	if (executable === "curl" || executable === "wget") {
		analysis.written.push(...downloadTargets(args));
		return;
	}

	const interpreter = interpreterFor(executable);
	if (interpreter) {
		collectInterpreter(interpreter, args, analysis, depth);
		return;
	}
	if (looksLikePath(invocation.raw)) {
		analysis.executed.push(invocation.raw);
	}
}

const PRIVILEGE_OPTIONS_WITH_VALUES = new Set(["-u", "--user", "-g", "--group", "-p", "--prompt", "-C", "--close-from"]);

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

const collectShellInvocation = (args: string[], analysis: ShellAnalysis, depth: number) => {
	let sawInlineFlag = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--command" || arg === "-c" || /^-[a-z]*c[a-z]*$/i.test(arg)) {
			const body = args[index + 1];
			if (body) {
				collectSource(body, analysis, depth + 1);
				sawInlineFlag = true;
				index++;
			}
			continue;
		}
		if (arg.startsWith("-")) continue;
		if (!sawInlineFlag) analysis.executed.push(arg);
		break;
	}
};

const DOWNLOAD_OPTIONS = new Set(["-o", "--output", "-O", "--output-document"]);

const downloadTargets = (args: string[]) =>
	args
		.map((arg, index) => (DOWNLOAD_OPTIONS.has(arg) ? args[index + 1] : undefined))
		.filter((target): target is string => Boolean(target) && !isDevNull(target as string));

const collectInterpreter = (interpreter: Interpreter, args: string[], analysis: ShellAnalysis, depth: number) => {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];

		if (interpreter.inlineFlags.has(arg)) {
			const code = args[index + 1];
			if (code) collectScript(interpreter.language, code, analysis, depth);
			index++;
			continue;
		}
		// `python -c'code'` lexes to a single word.
		const attached = [...interpreter.inlineFlags].find((flag) => arg.length > flag.length && arg.startsWith(flag));
		if (attached) {
			collectScript(interpreter.language, arg.slice(attached.length), analysis, depth);
			continue;
		}
		if (interpreter.valueOptions?.has(arg)) {
			index++;
			continue;
		}
		if (arg === "-" || arg.startsWith("-")) continue;
		if (interpreter.positionalCode) {
			if (isEnvironmentAssignment(arg)) continue;
			collectScript(interpreter.language, arg, analysis, depth);
			return;
		}

		analysis.executed.push(arg);
		return;
	}
};

function collectScript(language: ScriptLanguage, code: string, analysis: ShellAnalysis, depth: number) {
	if (code.trim().length === 0 || depth > MAX_NESTING_DEPTH) return;

	analysis.scripts.push({ language, code });
	analysis.texts.push(code);

	for (const pattern of SCRIPT_COMMAND_STRINGS) {
		for (const match of code.matchAll(pattern)) {
			collectSource(match[2] ?? "", analysis, depth + 1);
		}
	}
	for (const match of code.matchAll(SCRIPT_COMMAND_LISTS)) {
		const words = [...(match[1] ?? "").matchAll(QUOTED_LIST_ITEM)].map(([, , item]) => item);
		collectCommand(words, analysis, depth + 1);
	}
}

const looksLikePath = (value: string) => value.includes("/") || /\.(?:sh|bash|zsh|fish|nu|py|js|mjs|cjs|ts|rb|pl|php)$/i.test(value);

// ─── path helpers ────────────────────────────────────────────────────────────

const expandPath = (path: string) => path.replace(/^~(?=\/|$)/, HOME ?? "~");
const normalizedPath = (path: string) => normalize(resolve(expandPath(path)));

// .env, .envrc, .npmrc, .netrc are intentionally allowed (low-stakes project config)
const isEnvTemplatePath = (path: string) => /(^|\/)(?:\.(?:env|envrc|npmrc|netrc))(?:\.|$)/i.test(path);

const isCredentialPath = (path: string) => {
	const normalized = normalize(path);
	if (isEnvTemplatePath(normalized)) return false;

	return [
		/(^|\/)\.ssh\/[^/]*(?:_key|id_[a-z0-9]+)$/,
		/(^|\/)\.gnupg(\/|$)/,
		/\.(pem|key|p12|pfx)$/,
		/(^|\/)\.aws\/credentials$/,
		/(^|\/)\.config\/gcloud(\/|$)/,
		/(^|\/)\.azure(\/|$)/,
		/(^|\/)\.docker\/config\.json$/,
	].some((pattern) => pattern.test(normalized));
};

const isPseudoFsPath = (path: string) => {
	const normalized = normalizedPath(path);
	return (
		normalized === "/dev" ||
		normalized.startsWith("/dev/") ||
		normalized === "/proc" ||
		normalized.startsWith("/proc/") ||
		normalized === "/sys" ||
		normalized.startsWith("/sys/")
	);
};

const pathMentionPattern = /(^|[^a-z0-9_])((?:~|\.\.?|\/)[^\s'";&|)=]+)/gi;
const extractPathMentions = (text: string): string[] => [...text.matchAll(pathMentionPattern)].map(([, , path]) => path);

const quotedShellArg = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/;
const hasCommandSubstitution = (value: string) => /\$\(|`/.test(value);

// A commit message is prose, not a path reference; `git commit -m "rotate cert.pem"`
// should not read as credential access.
const stripGitCommitMessageArgs = (command: string) => {
	if (!/\bgit\s+commit\b/i.test(command)) return command;

	return command.replace(
		/\s(?:-m|--message)(?:=|\s+)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;|&]+)/gi,
		(match, messageArg: string) => {
			if (quotedShellArg.test(messageArg) && !hasCommandSubstitution(messageArg)) return "";
			return match;
		},
	);
};

const mentionsCredentialPath = (text: string) => {
	const scanText = stripGitCommitMessageArgs(text);
	const normalized = normalize(scanText);
	const mentions = extractPathMentions(scanText);
	const candidates =
		scanText.includes("/") || scanText.includes("~") || scanText.includes(".")
			? [normalized, ...mentions.map((path) => normalize(path)), ...mentions.map((path) => normalizedPath(path))]
			: [normalized];

	return candidates.some((path) => isCredentialPath(path));
};

const invocationMentionsCredential = (invocation: Invocation) => {
	const isCommitMessage = (index: number) =>
		invocation.executable === "git" && (invocation.args[index - 1] === "-m" || invocation.args[index - 1] === "--message");

	return invocation.args.some((arg, index) => {
		if (isCommitMessage(index)) return false;
		if (!arg.includes("/") && !arg.includes("~") && !arg.includes(".")) return false;
		return isCredentialPath(normalize(arg)) || isCredentialPath(normalizedPath(arg));
	});
};

// ─── session state ───────────────────────────────────────────────────────────

// Writing a script and then running it defeats every command-level rule, because
// the payload never appears in a shell command. Remember what this session
// created so the run can be surfaced.
const sessionWrittenPaths = new Set<string>();

// Repeating the same rule is the signature failure of a weaker model: it retries
// the blocked action in a new shape instead of stopping. Count hits so the reason
// can say so explicitly. Reset per agent run.
const ruleHits = new Map<string, number>();

// Pi's extension selector host mounts exactly one dialog at a time. A second
// concurrent ask unmounts the first without disposing it or settling its
// promise: the orphaned ask then sits invisible until its countdown expires and
// looks like a no-show. Serialize asks so parallel gated calls queue instead.
let askSlot: Promise<void> = Promise.resolve();

const rememberWrittenPath = (path: string) => {
	if (!path) return;
	sessionWrittenPaths.add(normalizedPath(path));
};

const resetGateState = () => {
	sessionWrittenPaths.clear();
	ruleHits.clear();
};

const runsGeneratedScript = (shell: ShellAnalysis) => {
	const writtenHere = new Set(shell.written.map((path) => normalizedPath(path)));
	return shell.executed.some((path) => {
		const normalized = normalizedPath(path);
		return sessionWrittenPaths.has(normalized) || writtenHere.has(normalized);
	});
};

// ─── predicates ──────────────────────────────────────────────────────────────

const executablesIn = (shell: ShellAnalysis, names: Set<string>) => shell.commands.filter((command) => names.has(command.executable));
const usesExecutable = (shell: ShellAnalysis, names: Set<string>) => executablesIn(shell, names).length > 0;
const anyText = (shell: ShellAnalysis, pattern: RegExp) => shell.texts.some((text) => pattern.test(text));

const DELETE_EXECUTABLES = new Set(["rm", "rmdir", "shred", "srm", "unlink"]);
const hasDelete = (shell: ShellAnalysis) =>
	usesExecutable(shell, DELETE_EXECUTABLES) ||
	executablesIn(shell, new Set(["find"])).some((command) => command.args.includes("-delete"));

const hasSudo = (shell: ShellAnalysis) => usesExecutable(shell, PRIVILEGE_EXECUTABLES);

// `save` is nushell's write. touch, mkdir, mv, cp and plain redirections stay out.
const MUTATING_EXECUTABLES = new Set(["tee", "chmod", "chown", "chgrp", "truncate", "install", "dd", "save"]);
// `sed -i` and `perl -pi` edit files in place, which is the same thing as an edit
// tool call but without a reviewable diff.
const editsInPlace = (shell: ShellAnalysis) =>
	executablesIn(shell, new Set(["sed", "gsed", "perl", "ruby"])).some((command) =>
		command.args.some((arg) => /^-[a-z]*i/.test(arg) || arg.startsWith("--in-place")),
	);

const hasShellWrite = (shell: ShellAnalysis) => usesExecutable(shell, MUTATING_EXECUTABLES) || editsInPlace(shell);

const hasInlineScriptEffect = (shell: ShellAnalysis) => scriptEffects(shell).size > 0;

const isCatastrophic = (shell: ShellAnalysis) =>
	shell.commands.some((command) => /^mkfs(?:\.[a-z0-9]+)?$/.test(command.executable)) ||
	executablesIn(shell, new Set(["dd"])).some((command) => command.args.some((arg) => /^of=\/dev\//i.test(arg))) ||
	(hasSudo(shell) && hasDelete(shell)) ||
	executablesIn(shell, new Set(["chmod"])).some(
		(command) =>
			command.args.some((arg) => /^-{1,2}(?:r|recursive)$/i.test(arg) || /^-[a-z]*r[a-z]*$/i.test(arg)) &&
			command.args.includes("777") &&
			command.args.some((arg) => arg === "/" || arg === "~" || arg === "$HOME" || arg === HOME),
	) ||
	anyText(shell, /\b(?:curl|wget)\b[^\n]*\|[^\n]*\b(?:sudo|doas)\b[^\n]*\b(?:sh|bash|zsh)\b/i);

const shellWritesPseudoFs = (shell: ShellAnalysis) =>
	shell.written.some((path) => isPseudoFsPath(path)) ||
	anyText(shell, /(?:^|[\s;|&])(?:\d?>{1,2})(?!&|\d)\s*\/?(?:proc\/|sys\/|dev\/(?!null(?:\s|$|[;&|)])))/i) ||
	anyText(shell, /\b(?:tee|dd|cp|mv|touch|mkdir|chmod|chown)\b[^\n]*(?:\s|=)\/?(?:proc\/|sys\/|dev\/(?!null(?:\s|$|[;&|)])))/i);

const mentionsCredentials = (shell: ShellAnalysis) =>
	shell.texts.some((text) => mentionsCredentialPath(text)) ||
	shell.commands.some((command) => invocationMentionsCredential(command)) ||
	scriptNamesPrivateKey(shell);

// ─── git ─────────────────────────────────────────────────────────────────────

const GIT_GLOBAL_OPTIONS_WITH_VALUES = new Set([
	"-C",
	"-c",
	"--config-env",
	"--git-dir",
	"--namespace",
	"--super-prefix",
	"--work-tree",
]);

const gitSubcommand = (command: Invocation): string | undefined => {
	if (command.executable !== "git") return undefined;

	let index = 0;
	while (index < command.args.length) {
		const argument = command.args[index];
		if (argument === "--") return command.args[index + 1];
		if (!argument.startsWith("-")) return argument.toLowerCase();

		const [option] = argument.split("=", 1);
		index += GIT_GLOBAL_OPTIONS_WITH_VALUES.has(option) && !argument.includes("=") ? 2 : 1;
	}

	return undefined;
};

const gitCommands = (shell: ShellAnalysis, subcommand: string) =>
	shell.commands.filter((command) => gitSubcommand(command) === subcommand);

const hasShortFlag = (args: string[], flag: string) =>
	args.some((arg) => /^-[a-z]+$/i.test(arg) && arg.slice(1).includes(flag));

const isDestructiveGit = (shell: ShellAnalysis) =>
	gitCommands(shell, "reset").some((command) => command.args.includes("--hard")) ||
	gitCommands(shell, "clean").some((command) => command.args.includes("--force") || hasShortFlag(command.args, "f")) ||
	gitCommands(shell, "checkout").some((command) => command.args.includes("--") && command.args.at(-1) === ".") ||
	gitCommands(shell, "restore").some((command) => command.args.includes(".")) ||
	gitCommands(shell, "push").some(
		(command) => command.args.includes("--force") || command.args.includes("--force-with-lease") || hasShortFlag(command.args, "f"),
	);

const isGitCommit = (shell: ShellAnalysis) => gitCommands(shell, "commit").length > 0;

const bypassesGitHooks = (shell: ShellAnalysis) =>
	shell.commands.some((command) => command.executable === "git" && command.args.includes("--no-verify"));

// ─── package managers ────────────────────────────────────────────────────────

const MUTATING_PACKAGE_COMMANDS = new Map<string, RegExp>([
	["npm", /^(?:install|i|add|remove|rm|uninstall|update|upgrade|audit|exec|link|publish)$/],
	["pnpm", /^(?:install|i|add|remove|rm|uninstall|update|upgrade|audit|exec|dlx|link|publish)$/],
	["yarn", /^(?:install|add|remove|up|upgrade|dlx|link|publish)$/],
	["bun", /^(?:install|i|add|remove|rm|update|link|publish)$/],
	["pip", /^(?:install|uninstall|download)$/],
	["pip3", /^(?:install|uninstall|download)$/],
	["pipx", /^(?:install|uninstall|upgrade|inject|run)$/],
	["uv", /^(?:add|remove|sync|tool (?:install|uninstall|upgrade)|pip (?:install|uninstall|sync))$/],
	["poetry", /^(?:add|remove|install|update|publish)$/],
	["cargo", /^(?:install|uninstall|add|remove|publish)$/],
	["go", /^(?:install|get)$/],
	["gem", /^(?:install|uninstall|update|push)$/],
	["brew", /^(?:install|uninstall|reinstall|upgrade|tap|link)$/],
	["apt", /^(?:install|remove|purge|upgrade|full-upgrade)$/],
	["apt-get", /^(?:install|remove|purge|upgrade|dist-upgrade)$/],
	["dnf", /^(?:install|remove|upgrade|update)$/],
	["yum", /^(?:install|remove|upgrade|update)$/],
	["pacman", /^-[a-z]*[su][a-z]*$/i],
	["apk", /^(?:add|del|upgrade)$/],
	["composer", /^(?:require|remove|install|update)$/],
]);

const isMutatingPackageManager = (shell: ShellAnalysis) =>
	shell.commands.some((command) => {
		const pattern = MUTATING_PACKAGE_COMMANDS.get(command.executable);
		if (!pattern) return false;
		// pacman spells its subcommand as a flag group: `pacman -Syu`.
		if (command.executable === "pacman") return command.args.some((arg) => pattern.test(arg));

		// Match the subcommand and, for two-word forms like `uv pip install`, the
		// pair. Later positionals are package names, not subcommands.
		const positional = command.args.filter((arg) => !arg.startsWith("-")).slice(0, 2);
		return positional.some((_, index) => pattern.test(positional.slice(0, index + 1).join(" ")));
	});

// ─── network ─────────────────────────────────────────────────────────────────

const NETWORK_EXECUTABLES = new Set(["ssh", "scp", "rsync", "sftp", "nc", "ncat", "netcat", "socat", "telnet"]);
const CURL_UPLOAD_OPTIONS = new Set(["-T", "--upload-file", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "-F", "--form"]);
const CURL_MUTATING_METHODS = /^(?:POST|PUT|PATCH|DELETE)$/i;

const curlSendsData = (command: Invocation) =>
	command.args.some((arg, index) => {
		if (CURL_UPLOAD_OPTIONS.has(arg)) return true;
		if (arg.startsWith("--data")) return true;
		if ((arg === "-X" || arg === "--request") && CURL_MUTATING_METHODS.test(command.args[index + 1] ?? "")) return true;
		if ((arg === "-H" || arg === "--header") && /authorization:/i.test(command.args[index + 1] ?? "")) return true;
		if (arg === "-u" || arg === "--user") return true;
		return false;
	});

const isRiskyNetwork = (shell: ShellAnalysis) =>
	usesExecutable(shell, NETWORK_EXECUTABLES) ||
	gitCommands(shell, "push").length > 0 ||
	executablesIn(shell, new Set(["curl"])).some((command) => curlSendsData(command)) ||
	executablesIn(shell, new Set(["wget"])).some((command) => command.args.some((arg) => arg.startsWith("--post"))) ||
	// nushell: `http post https://... $payload`
	executablesIn(shell, new Set(["http"])).some((command) => /^(?:post|put|patch|delete)$/i.test(command.args[0] ?? "")) ||
	scriptEffects(shell).has("network") ||
	anyText(shell, /\b(?:curl|wget)\b[^\n]*\|[^\n]*\b(?:sh|bash|zsh|nu)\b/i);

// ─── nested pi ───────────────────────────────────────────────────────────────

const PI_MANAGEMENT_COMMANDS = new Set(["config", "install", "list", "remove", "uninstall", "update"]);
const PI_OPTIONS_WITH_VALUES = new Set([
	"--api-key",
	"--append-system-prompt",
	"--exclude-tools",
	"--extension",
	"--fork",
	"--mode",
	"--model",
	"--models",
	"--name",
	"--prompt-template",
	"--provider",
	"--session",
	"--session-dir",
	"--skill",
	"--system-prompt",
	"--theme",
	"--thinking",
	"--tools",
	"-e",
	"-n",
	"-t",
	"-xt",
]);

const isPiExecutable = (command: Invocation) => /^pi(?:\.exe)?$/i.test(command.executable);

const piPositionalArgs = (args: string[]) => {
	const positionals: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--") {
			positionals.push(...args.slice(index + 1));
			break;
		}
		if (PI_OPTIONS_WITH_VALUES.has(arg)) {
			index++;
			continue;
		}
		if (arg.startsWith("-")) continue;
		positionals.push(arg);
	}
	return positionals;
};

const isNonAgentPi = (command: Invocation) => {
	const args = command.args;
	if (args.some((arg) => ["-h", "--help", "-v", "--version"].includes(arg))) return true;
	if (args.includes("--list-models")) return true;
	if (args.some((arg) => arg === "--export" || arg.startsWith("--export="))) return true;

	const hasExplicitAgentMode = args.some(
		(arg, index) => arg === "-p" || arg === "--print" || arg === "--mode=json" || (arg === "--mode" && args[index + 1] === "json"),
	);
	if (hasExplicitAgentMode) return false;
	// A pi on PATH is the real CLI; `./pi` or `/opt/tools/pi` is some other program.
	if (!/^pi(?:\.exe)?$/i.test(command.raw)) return true;

	const positionals = piPositionalArgs(args);
	if (positionals.length === 0) return true;
	return PI_MANAGEMENT_COMMANDS.has(positionals[0]);
};

const launchesNestedPiAgent = (shell: ShellAnalysis) =>
	!nestedPiOverrideEnabled() && shell.commands.some((command) => isPiExecutable(command) && !isNonAgentPi(command));

// ─── rules ───────────────────────────────────────────────────────────────────

const shellRule = (test: (shell: ShellAnalysis) => boolean) => (call: ToolCall) => call.shell !== undefined && test(call.shell);
const toolPath = (call: ToolCall) => String(call.input.path ?? "").trim();

const rules: Rule[] = [
	// Block credential material no matter how it is accessed. If the agent needs a
	// secret-adjacent value, the user should provide a redacted snippet explicitly.
	{
		id: "block.credential-structured-access",
		decision: "block",
		description: "credential/private material path accessed by structured tool",
		guidance: GUIDANCE.credentials,
		matches: (call) => (READ_TOOLS.has(call.toolName) || WRITE_TOOLS.has(call.toolName)) && isCredentialPath(toolPath(call)),
	},
	{
		id: "block.credential-shell-access",
		decision: "block",
		description: "shell command references credential/private material",
		guidance: GUIDANCE.credentials,
		matches: shellRule(mentionsCredentials),
	},

	// A model must not manufacture an unavailable subagent by recursively launching
	// a Pi agent from a shell tool. Non-agent Pi commands and user-run terminal/`!`
	// commands remain available; a parent-process env opt-in exists for agent tests.
	{
		id: "block.nested-pi-agent",
		decision: "block",
		description: "agent-controlled shell command starts another Pi agent",
		guidance: GUIDANCE.nestedPi,
		matches: shellRule(launchesNestedPiAgent),
	},

	// Block commands with huge blast radius. These are not confirmation-worthy;
	// the right next step is to stop and ask the user to handle it manually.
	{
		id: "block.catastrophic-command",
		decision: "block",
		description: "catastrophic disk/system command",
		guidance: GUIDANCE.catastrophic,
		matches: shellRule(isCatastrophic),
	},

	// Block writes to pseudo-filesystems. Reading them may be diagnostic; writing
	// them changes kernel/device state and should not be agent-driven.
	{
		id: "block.pseudo-fs-structured-write",
		decision: "block",
		description: "structured write to /dev, /proc, or /sys",
		guidance: GUIDANCE.pseudoFs,
		matches: (call) => WRITE_TOOLS.has(call.toolName) && isPseudoFsPath(toolPath(call)),
	},
	{
		id: "block.pseudo-fs-shell-write",
		decision: "block",
		description: "shell write to /dev, /proc, or /sys",
		guidance: GUIDANCE.pseudoFs,
		matches: shellRule(shellWritesPseudoFs),
	},

	// Hooks exist for a reason and the agent should never silently bypass them.
	{
		id: "block.no-verify",
		decision: "block",
		description: "git command uses --no-verify to bypass hooks",
		guidance: GUIDANCE.noVerify,
		matches: shellRule(bypassesGitHooks),
	},

	// Ask on any deletion. This is intentionally blunt: deletion should be
	// conscious, even when it looks small or local.
	{
		id: "ask.rm",
		decision: "ask",
		description: "command deletes files",
		guidance: GUIDANCE.rm,
		matches: shellRule(hasDelete),
	},

	// Ask when shell is used as a file editor. This nudges the agent toward the
	// structured edit/write tools, where the path and diff are easier to inspect.
	{
		id: "ask.shell-write",
		decision: "ask",
		description: "shell command writes or mutates files",
		guidance: GUIDANCE.shellWrite,
		matches: shellRule(hasShellWrite),
	},

	// Inline interpreter code is the standard way around every command-level rule.
	// Ask whenever such a body has an observable side effect.
	{
		id: "ask.inline-script",
		decision: "ask",
		description: "inline interpreter code writes files, spawns processes, or sends data",
		guidance: GUIDANCE.inlineScript,
		matches: shellRule(hasInlineScriptEffect),
	},

	// Writing a script then running it hides the payload from every other rule.
	{
		id: "ask.run-generated-script",
		decision: "ask",
		description: "runs a script created during this session",
		guidance: GUIDANCE.generatedScript,
		matches: shellRule(runsGeneratedScript),
	},

	// Ask for elevated privileges. Sudo is sometimes legitimate, but it should
	// never happen accidentally or as a workaround for a failed command.
	{
		id: "ask.sudo",
		decision: "ask",
		description: "sudo/elevated command",
		guidance: GUIDANCE.sudo,
		matches: shellRule(hasSudo),
	},

	// Ask before discarding local work or rewriting remote history.
	{
		id: "ask.git-destructive",
		decision: "ask",
		description: "destructive Git command",
		guidance: GUIDANCE.gitDestructive,
		matches: shellRule(isDestructiveGit),
	},

	// Ask before creating a commit. Skills (e.g. /implement) may instruct the
	// agent to commit automatically; gate that behind explicit confirmation.
	{
		id: "ask.git-commit",
		decision: "ask",
		description: "git commit creates history",
		guidance: GUIDANCE.gitCommit,
		matches: shellRule(isGitCommit),
	},

	// Ask before changing the dependency graph or executing package-manager-fetched
	// code. Tests/builds/lints are deliberately not included here.
	{
		id: "ask.package-manager-mutate",
		decision: "ask",
		description: "mutating or remote-executing package-manager command",
		guidance: GUIDANCE.packageManager,
		matches: shellRule(isMutatingPackageManager),
	},

	// Ask when a network command uploads, pushes, includes auth material,
	// or pipes remote content into an interpreter.
	{
		id: "ask.network-risk",
		decision: "ask",
		description: "network upload, push, remote execution, or credentialed network call",
		guidance: GUIDANCE.networkRisk,
		matches: shellRule(isRiskyNetwork),
	},
];

// ─── assessment ──────────────────────────────────────────────────────────────

const targetForCall = (call: ToolCall) => {
	if (call.shell) return String(call.input.command ?? "").trim();
	const path = toolPath(call);
	return path ? `${call.toolName}: ${path}` : call.toolName;
};

const matchingRules = (call: ToolCall, decision: Exclude<Decision, "allow">): Match[] =>
	rules
		.filter((rule) => rule.decision === decision && rule.matches(call))
		.map(({ id, decision, description, guidance }) => ({ id, decision, description, guidance }));

const assessToolCall = (toolName: string, input: ToolInput): Assessment => {
	const call: ToolCall = { toolName, input };
	if (SHELL_TOOLS.has(toolName)) {
		call.shell = analyzeShellCommand(String(input.command ?? ""));
	}

	const blockMatches = matchingRules(call, "block");
	const askMatches = blockMatches.length > 0 ? [] : matchingRules(call, "ask");

	// Record after matching, so a command is not flagged for running the file it
	// creates in the same breath, but before returning, so a later call is.
	if (WRITE_TOOLS.has(toolName)) rememberWrittenPath(toolPath(call));
	if (call.shell) for (const path of call.shell.written) rememberWrittenPath(path);

	if (blockMatches.length > 0) return { decision: "block", matches: blockMatches, target: targetForCall(call) };
	if (askMatches.length > 0) return { decision: "ask", matches: askMatches, target: targetForCall(call) };

	return { decision: "allow", matches: [], target: targetForCall(call) };
};

// ─── reasons ─────────────────────────────────────────────────────────────────

const noteRuleHits = (ids: string[]) => {
	let highest = 0;
	for (const id of ids) {
		const count = (ruleHits.get(id) ?? 0) + 1;
		ruleHits.set(id, count);
		highest = Math.max(highest, count);
	}
	return highest;
};

const escalationNote = (hits: number) =>
	hits > 1 ? `\nYou have hit this rule ${hits} times in this run. Stop trying variations and ask the user.` : "";

const unique = <T>(values: T[]) => [...new Set(values)];
const formatList = (values: string[]) => values.map((value) => `- ${value}`).join("\n");

const formatReason = (assessment: Assessment, hits = 0) => {
	const descriptions = unique(assessment.matches.map((match) => `${match.id}: ${match.description}`));
	const guidance = unique(assessment.matches.map((match) => match.guidance));
	return [
		`Permission gate ${assessment.decision}:`,
		formatList(descriptions),
		"",
		"Guidance:",
		formatList(guidance),
		"",
		"Target:",
		assessment.target,
		escalationNote(hits),
	]
		.join("\n")
		.trimEnd();
};

// Pure classification of a finished yes/no ask, kept separate from the handler so
// the decline/timeout logic is testable. `choice` is what ctx.ui.select resolved to
// (ASK_ALLOW, ASK_DENY, or undefined for a dismissal / timeout / caught throw).
// `timedOut` is whether the dialog ran out its countdown rather than being answered.
//
// Both non-allow outcomes abort the turn — a decline is a decision the model must
// not route around, and a timeout means the user stepped away, so unattended work
// stops too. They differ only in wording: the model (and user) should be able to
// tell "you said no" from "nobody was there".
function describeAskOutcome(choice: string | undefined, timedOut: boolean, askSecs: number) {
	if (choice !== ASK_DENY && timedOut) {
		return {
			kind: "timedOut" as const,
			notify: `Permission gate ask timed out after ${askSecs}s with no response; blocked the call and aborted the turn.`,
			reason:
				"Blocked by permission gate: the ask timed out after " +
				askSecs +
				"s with no response — the user is away, so the turn was aborted. Do not retry this call in another form; wait for the user to return and ask before attempting it again.",
		};
	}
	return {
		kind: "declined" as const,
		notify: "Permission gate ask declined by user; aborting turn.",
		reason: "Blocked by permission gate: the user declined (explicitly or by dismissing). Do not retry this in another form.",
	};
}

// ─── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("agent_start", () => {
		ruleHits.clear();
	});

	pi.on("tool_call", async (event, ctx) => {
		const assessment = assessToolCall(event.toolName, event.input as ToolInput);
		if (assessment.decision === "allow") return undefined;

		const ids = assessment.matches.map((match) => match.id);
		const hits = noteRuleHits(ids);
		const reason = formatReason(assessment, hits);

		if (assessment.decision === "block") {
			if (ctx.hasUI) ctx.ui.notify(`Permission gate blocked tool call: ${ids.join(", ")}`, "warning");
			return { block: true, reason };
		}

		if (!ctx.hasUI) return { block: true, reason: `${reason}\n\nConfirmation requires UI.` };

		// The dialog renders its own countdown from `timeout`; the controller is a
		// backstop for a host that does not honour it. Either way "nobody answered"
		// is told apart from "answered no" by how long the dialog stayed up.
		const timeoutMs = askTimeoutMs();
		const previous = askSlot;
		let releaseSlot: () => void = () => {};
		askSlot = new Promise((resolve) => {
			releaseSlot = resolve;
		});
		await previous;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs + ASK_TIMEOUT_BACKSTOP_MS);
		const startedAt = Date.now();
		let choice: string | undefined;
		try {
			const notifyAsk = { ids, target: assessment.target, timeoutMs };
			try {
				pi.events.emit("permission_gate:ask", notifyAsk);
			} catch {
				// Notification listeners are advisory; the ask must still run.
			}
			try {
				choice = await ctx.ui.select(`⚠️ Permission gate ask\n\n${reason}\n\nAllow?`, [ASK_DENY, ASK_ALLOW], {
					signal: controller.signal,
					timeout: timeoutMs,
				});
			} catch {
				choice = undefined;
			}
		} finally {
			clearTimeout(timer);
			releaseSlot();
		}

		if (choice === ASK_ALLOW) return undefined;

		// A dismissal in the countdown's final slack window is misread as a
		// timeout. Harmless: both kinds abort the turn; only the wording differs.
		const askSecs = Math.round(timeoutMs / 1000);
		const timedOut = controller.signal.aborted || Date.now() - startedAt >= timeoutMs - ASK_TIMEOUT_SLACK_MS;
		const outcome = describeAskOutcome(choice, timedOut, askSecs);
		const outcomeReason = `${outcome.reason}\n\n${reason}`;
		ctx.ui.notify(outcome.notify, "warning");

		// pi's agent loop checks the abort signal before it reads this block
		// reason, so an aborted turn would otherwise hand the model a bare
		// "Operation aborted" with no sign a gate exists. Deliver the reason as a
		// next-turn message, which survives the abort, and defer the abort by a
		// macrotask so the block reason still wins the race inside the loop.
		try {
			pi.sendMessage({ customType: "permission_gate", content: outcomeReason, display: false }, { deliverAs: "nextTurn" });
		} catch {
			// Older hosts may not support custom messages; the block still stands.
		}
		setTimeout(() => {
			try {
				ctx.abort();
			} catch {
				// The run may already have ended; nothing to abort.
			}
		}, 0);

		return { block: true, reason: outcomeReason };
	});
}

// Exported for tests/permission-gate.test.ts.
export { assessToolCall, describeAskOutcome, escalationNote, NESTED_PI_OVERRIDE_ENV, noteRuleHits, rememberWrittenPath, resetGateState, ASK_DENY };
