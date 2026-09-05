import {
	analyzeShellCommand,
	effectsForScript,
	HOME,
	normalize,
	normalizedEffectPath,
	normalizedPath,
	PRIVILEGE_EXECUTABLES,
	scriptEffects,
	scriptNamesPrivateKey,
	type AnalyzedScript,
	type Invocation,
	type PathEffect,
	type ShellAnalysis,
} from "./shell-analysis.ts";
import { PermissionGateState } from "./state.ts";

// ─── policy surface ──────────────────────────────────────────────────────────

type Decision = "allow" | "ask" | "block";

type GateCall =
	| { kind: "shell"; toolName: string; command: string; shell: ShellAnalysis }
	| { kind: "path"; toolName: string; path: string; cwd: string; access: "read" | "write" }
	| { kind: "other"; toolName: string };

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
	matches: (call: GateCall, env: RuleEnv) => boolean;
};

/** Cross-call context; pure rules ignore it, session-aware rules read it. */
type RuleEnv = { state: PermissionGateState };

export type Assessment = {
	decision: Decision;
	matches: Match[];
	target: string;
	writes: PathEffect[];
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
	gitRm: "This deletes paths from disk AND stages the deletion. Confirm before discarding work.",
	noVerify: "Do not bypass git hooks. Fix what makes the hook fail, or ask the user.",
	packageManager: "This changes dependencies or runs downloaded code.",
	networkRisk: "This sends data out, pushes, or executes remote content.",
} as const;

const SHELL_TOOLS = new Set(["bash", "nu"]);
const PATH_TOOLS: ReadonlyMap<string, "read" | "write"> = new Map([
	["read", "read"],
	["grep", "read"],
	["find", "read"],
	["ls", "read"],
	["ast_search", "read"],
	["edit", "write"],
	["write", "write"],
]);

export const NESTED_PI_OVERRIDE_ENV = "PI_PERMISSION_GATE_ALLOW_NESTED_PI";
const nestedPiOverrideEnabled = () => /^(?:1|true|yes|on)$/i.test(process.env[NESTED_PI_OVERRIDE_ENV]?.trim() ?? "");

// ─── path helpers ────────────────────────────────────────────────────────────

// .env, .envrc, .npmrc, .netrc are intentionally allowed (low-stakes project config)
const isEnvTemplatePath = (path: string) => /(^|\/)(?:\.(?:env|envrc|npmrc|netrc))(?:\.|$)/i.test(path);

const isCredentialPath = (path: string) => {
	const normalized = normalize(path);
	if (isEnvTemplatePath(normalized)) return false;

	return [
		/(^|\/)\.ssh\/[^/]*(?:_key|id_[a-z0-9_]+)$/,
		/(^|\/)\.gnupg(\/|$)/,
		/\.(pem|key|p12|pfx)$/,
		/(^|\/)\.aws\/credentials$/,
		/(^|\/)\.config\/gcloud(\/|$)/,
		/(^|\/)\.azure(\/|$)/,
		/(^|\/)\.docker\/config\.json$/,
	].some((pattern) => pattern.test(normalized));
};

const isPseudoFsPath = (path: string, cwd?: string) => {
	const normalized = cwd === undefined ? normalizedPath(path) : normalizedPath(path, cwd);
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

	// Resolve every argument against the command's effective directory: a bare
	// `id_ed25519` inside `~/.ssh` is the same credential as the absolute path.
	return invocation.args.some((arg, index) => {
		if (isCommitMessage(index)) return false;
		return isCredentialPath(normalizedPath(arg, invocation.cwd));
	});
};

const runsGeneratedScript = (shell: ShellAnalysis, state: PermissionGateState) => {
	const writtenHere = new Set(shell.written.map(normalizedEffectPath));
	return shell.executed.some((effect) => state.hasWrittenPath(effect) || writtenHere.has(normalizedEffectPath(effect)));
};

// ─── predicates ──────────────────────────────────────────────────────────────

const executablesIn = (shell: ShellAnalysis, names: Set<string>) => shell.commands.filter((command) => names.has(command.executable));
const usesExecutable = (shell: ShellAnalysis, names: Set<string>) => executablesIn(shell, names).length > 0;

const DOWNLOAD_EXECUTABLES = new Set(["curl", "wget"]);
const REMOTE_SHELLS = new Set(["sh", "bash", "zsh", "nu"]);
const remoteShellPipeline = (shell: ShellAnalysis, requireElevation = false) =>
	shell.pipelines.some((pipeline) => {
		let hasRemoteInput = false;
		for (const stage of pipeline) {
			const runsRemoteShell = stage.commands.some(
				(command) => REMOTE_SHELLS.has(command.executable) && (!requireElevation || command.elevated),
			);
			if (hasRemoteInput && runsRemoteShell) return true;
			if (stage.commands.some((command) => DOWNLOAD_EXECUTABLES.has(command.executable))) hasRemoteInput = true;
		}
		return false;
	});

const DELETE_EXECUTABLES = new Set(["rm", "rmdir", "shred", "srm", "unlink"]);
const isFindDelete = (command: Invocation) => command.executable === "find" && command.args.includes("-delete");
const hasFindDelete = (shell: ShellAnalysis) => shell.commands.some(isFindDelete);
const hasDelete = (shell: ShellAnalysis) => usesExecutable(shell, DELETE_EXECUTABLES) || hasFindDelete(shell);

const hasSudo = (shell: ShellAnalysis) => usesExecutable(shell, PRIVILEGE_EXECUTABLES);

// `save` is nushell's write. touch, mkdir, mv, cp and plain redirections stay out.
const MUTATING_EXECUTABLES = new Set(["tee", "chmod", "chown", "chgrp", "truncate", "install", "dd", "save"]);
const IN_PLACE_EDITORS = new Set(["sed", "gsed", "perl", "ruby"]);
// `sed -i` and `perl -pi` edit files in place, which is the same thing as an edit
// tool call but without a reviewable diff.
const editsInPlaceCommand = (command: Invocation) =>
	IN_PLACE_EDITORS.has(command.executable) &&
	command.args.some((arg) => /^-[a-z]*i/.test(arg) || arg.startsWith("--in-place"));
const editsInPlace = (shell: ShellAnalysis) => shell.commands.some(editsInPlaceCommand);

const hasShellWrite = (shell: ShellAnalysis) => usesExecutable(shell, MUTATING_EXECUTABLES) || editsInPlace(shell);

const hasInlineScriptEffect = (shell: ShellAnalysis) => scriptEffects(shell).size > 0;

const isCatastrophic = (shell: ShellAnalysis) =>
	shell.commands.some((command) => /^mkfs(?:\.[a-z0-9]+)?$/.test(command.executable)) ||
	executablesIn(shell, new Set(["dd"])).some((command) => command.args.some((arg) => /^of=\/dev\//i.test(arg))) ||
	(hasSudo(shell) && hasDelete(shell)) ||
	executablesIn(shell, new Set(["chmod"])).some(
		(command) =>
			command.args.some((arg) => /^-{1,2}(?:r|recursive)$/i.test(arg) || /^-[a-z]*r[a-z]*$/i.test(arg)) &&
			command.args.some((arg) => /^0*777$/.test(arg)) &&
			command.args.some((arg) => arg === "/" || arg === "~" || arg === "$HOME" || arg === HOME),
	) ||
	remoteShellPipeline(shell, true);

const PSEUDO_FS_MUTATORS = new Set([...MUTATING_EXECUTABLES, "cp", "mv", "touch", "mkdir"]);
const textMentionsPseudoFs = (text: string) => extractPathMentions(text).some((path) => isPseudoFsPath(path));
const commandWritesPseudoFs = (command: Invocation) =>
	(PSEUDO_FS_MUTATORS.has(command.executable) || editsInPlaceCommand(command)) &&
	command.args.some((arg) => textMentionsPseudoFs(arg) || isPseudoFsPath(arg, command.cwd));
const scriptWritesPseudoFs = (script: AnalyzedScript) =>
	effectsForScript(script).has("mutate") && textMentionsPseudoFs(script.code);

const shellWritesPseudoFs = (shell: ShellAnalysis) =>
	shell.written.some((effect) => isPseudoFsPath(normalizedEffectPath(effect))) ||
	shell.commands.some(commandWritesPseudoFs) ||
	shell.scripts.some(scriptWritesPseudoFs);

const mentionsCredentials = (shell: ShellAnalysis) =>
	shell.texts.some((text) => mentionsCredentialPath(text)) ||
	shell.commands.some((command) => invocationMentionsCredential(command)) ||
	shell.written.some((effect) => isCredentialPath(normalizedEffectPath(effect))) ||
	shell.executed.some((effect) => isCredentialPath(normalizedEffectPath(effect))) ||
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

// `git rm` is not a plain rm invocation and also stages the deletion, so it
// retains a dedicated always-ask rule.
const isGitRm = (shell: ShellAnalysis) => gitCommands(shell, "rm").length > 0;

// `git commit -n` bypasses hooks exactly like `--no-verify`, but `-n` is a
// dry-run for push and a message value after `-m`, so it only counts for
// commit positionals. A short group containing `m`/`F`/`C`/`S` treats the
// remainder as that option's value (`-mnonsense` is `-m nonsense`, not `-n`).
const gitArgsAfterSubcommand = (command: Invocation): string[] | undefined => {
	if (command.executable !== "git") return undefined;
	let index = 0;
	while (index < command.args.length) {
		const argument = command.args[index];
		if (argument === "--") return [];
		if (!argument.startsWith("-")) return command.args.slice(index + 1);
		const [option] = argument.split("=", 1);
		index += GIT_GLOBAL_OPTIONS_WITH_VALUES.has(option) && !argument.includes("=") ? 2 : 1;
	}
	return undefined;
};

const gitCommitBypassesHooks = (args: string[]) => {
	const valueOptions = new Set(["-m", "--message", "-F", "--file", "-C", "--reuse-message", "-c", "--reedit-message", "--template", "--author", "--date"]);
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--") return false;
		if (arg === "--no-verify") return true;
		if (valueOptions.has(arg)) {
			index++;
			continue;
		}
		if (arg.startsWith("--")) continue;
		if (/^-[a-z]+$/i.test(arg)) {
			for (const letter of arg.slice(1)) {
				if (letter === "m" || letter === "F" || letter === "C" || letter === "c" || letter === "S") break;
				if (letter === "n") return true;
			}
		}
	}
	return false;
};

const bypassesGitHooks = (shell: ShellAnalysis) =>
	shell.commands.some((command) => {
		if (command.executable !== "git") return false;
		if (command.args.includes("--no-verify")) return true;
		const rest = gitArgsAfterSubcommand(command);
		return rest !== undefined && gitSubcommand(command) === "commit" && gitCommitBypassesHooks(rest);
	});

// ─── package managers ────────────────────────────────────────────────────────

const MUTATING_PACKAGE_COMMANDS = new Map<string, RegExp>([
	["npm", /^(?:install|ci|i|add|remove|rm|uninstall|update|upgrade|audit|exec|link|publish)$/],
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

// Options that consume the next word (or carry it after `=` / attached),
// so their values are never mistaken for the subcommand. Only value-taking
// options are listed: skipping a boolean flag's "value" would hide the real
// subcommand instead.
const PACKAGE_OPTIONS_WITH_VALUES = new Map<string, Set<string>>([
	["npm", new Set(["--prefix", "--workspace", "-w", "--registry", "--cache", "--userconfig", "--otp", "--tag", "--scope", "--auth-type", "--access"])],
	["pnpm", new Set(["-C", "--dir", "--filter", "--registry", "--prefix", "--cache-dir", "--store-dir", "--auth-token", "--otp", "--tag", "--reporter", "--loglevel", "--shamefully-hoist"])],
	["yarn", new Set(["--cwd", "--registry", "--cache-folder", "--otp", "--tag", "--scope", "--network-timeout"])],
	["bun", new Set(["--cwd", "--registry", "--cache-dir"])],
	["pip", new Set(["--proxy", "--index-url", "--extra-index-url", "--find-links", "--cert", "--client-cert", "--trusted-host", "--python"])],
	["pip3", new Set(["--proxy", "--index-url", "--extra-index-url", "--find-links", "--cert", "--client-cert", "--trusted-host", "--python"])],
	["uv", new Set(["--directory", "--project", "--python", "-p", "--index", "--default-index", "--cache-dir", "--auth-token", "--with"])],
	["cargo", new Set(["--manifest-path", "--target", "--target-dir", "--profile", "--config", "-Z"])],
]);

const packagePositionals = (command: Invocation) => {
	const valueOptions = PACKAGE_OPTIONS_WITH_VALUES.get(command.executable) ?? new Set<string>();
	const positional: string[] = [];
	for (let index = 0; index < command.args.length; index++) {
		const arg = command.args[index];
		if (arg === "--") {
			positional.push(...command.args.slice(index + 1));
			break;
		}
		if (arg.startsWith("--")) {
			const name = optionName(arg);
			if (name === arg && valueOptions.has(name)) index++;
			continue;
		}
		if (/^-[a-z]+$/i.test(arg) && arg.length > 2) {
			// Attached value (`-C/tmp`) or a boolean flag group (`-Syu`).
			if (!valueOptions.has(arg.slice(0, 2)) && valueOptions.has(arg)) index++;
			continue;
		}
		if (valueOptions.has(arg)) {
			index++;
			continue;
		}
		if (!arg.startsWith("-")) positional.push(arg);
	}
	return positional;
};

const isMutatingPackageManager = (shell: ShellAnalysis) =>
	shell.commands.some((command) => {
		const pattern = MUTATING_PACKAGE_COMMANDS.get(command.executable);
		if (!pattern) return false;
		// pacman spells its subcommand as a flag group: `pacman -Syu`.
		if (command.executable === "pacman") return command.args.some((arg) => pattern.test(arg));

		// Match the subcommand and, for two-word forms like `uv pip install`, the
		// pair. Later positionals are package names, not subcommands.
		const positional = packagePositionals(command).slice(0, 2);
		return positional.some((_, index) => pattern.test(positional.slice(0, index + 1).join(" ")));
	});

// ─── network ─────────────────────────────────────────────────────────────────

const NETWORK_EXECUTABLES = new Set(["ssh", "scp", "rsync", "sftp", "nc", "ncat", "netcat", "socat", "telnet"]);
const CURL_UPLOAD_OPTIONS = new Set([
	"-T",
	"--upload-file",
	"-d",
	"--data",
	"--data-ascii",
	"--data-raw",
	"--data-binary",
	"--data-urlencode",
	"-F",
	"--form",
]);
const CURL_AUTH_OPTIONS = new Set(["-u", "--user"]);
const CURL_METHOD_OPTIONS = new Set(["-X", "--request"]);
const CURL_HEADER_OPTIONS = new Set(["-H", "--header"]);
// Long options that take a value (skipped so the value is never read as a
// flag). Risky `--data`/`--user`/`--request`/`--header` relatives are handled
// by the detector below, never skipped blindly.
const CURL_SKIP_LONG_OPTIONS = new Set(["--output", "--user-agent", "--referer", "--config", "--max-time", "--connect-timeout", "--write-out", "--proxy", "--proxy-user", "--range", "--time-cond", "--cert", "--cacert", "--key", "--ciphers", "--resolve", "--connect-to", "--limit-rate", "--retry", "--cert-type", "--key-type"]);
const CURL_SKIP_SHORT_OPTIONS = new Set(["-o", "-A", "-B", "-b", "-c", "-C", "-D", "-e", "-E", "-K", "-m", "-P", "-Q", "-r", "-U", "-w", "-x", "-y", "-z"]);
const CURL_MUTATING_METHODS = /^(?:POST|PUT|PATCH|DELETE)$/i;
const WGET_AUTH_OPTIONS = new Set(["--user", "--password", "--http-user", "--http-password", "--ftp-user", "--ftp-password"]);

const optionName = (arg: string) => {
	const equals = arg.indexOf("=");
	return equals < 0 ? arg : arg.slice(0, equals);
};

// Index-based parsing misreads combined groups (`-sSX POST` hides `-X`)
// and option values (`-o -download.txt` looks like `-d`). Scan left to
// right, expanding short groups and consuming every option value.
const curlSendsData = (command: Invocation) => {
	const args = command.args;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--") break;
		if (arg.startsWith("--")) {
			const name = optionName(arg);
			const inline = name === arg ? undefined : arg.slice(name.length + 1);
			if (CURL_UPLOAD_OPTIONS.has(name) || CURL_AUTH_OPTIONS.has(name)) {
				if (inline === undefined) index++;
				return true;
			}
			if (CURL_METHOD_OPTIONS.has(name) || CURL_HEADER_OPTIONS.has(name)) {
				const value = inline ?? args[index + 1];
				if (inline === undefined) index++;
				if (CURL_METHOD_OPTIONS.has(name) ? CURL_MUTATING_METHODS.test(value ?? "") : /authorization:/i.test(value ?? "")) return true;
				continue;
			}
			if (inline === undefined && CURL_SKIP_LONG_OPTIONS.has(name)) index++;
			continue;
		}
		if (/^-[a-zA-Z]+$/.test(arg)) {
			for (let pos = 1; pos < arg.length; pos++) {
				const flag = `-${arg[pos]}`;
				const attached = arg.slice(pos + 1);
				if (CURL_UPLOAD_OPTIONS.has(flag) || CURL_AUTH_OPTIONS.has(flag)) {
					if (!attached) index++;
					return true;
				}
				if (CURL_METHOD_OPTIONS.has(flag) || CURL_HEADER_OPTIONS.has(flag)) {
					const value = attached || args[index + 1];
					if (!attached) index++;
					if (CURL_METHOD_OPTIONS.has(flag) ? CURL_MUTATING_METHODS.test(value ?? "") : /authorization:/i.test(value ?? "")) return true;
					break;
				}
				if (CURL_SKIP_SHORT_OPTIONS.has(flag)) {
					if (!attached) index++;
					break;
				}
			}
			}
		}
	return false;
};

const isRiskyNetwork = (shell: ShellAnalysis) =>
	usesExecutable(shell, NETWORK_EXECUTABLES) ||
	gitCommands(shell, "push").length > 0 ||
	executablesIn(shell, new Set(["curl"])).some((command) => curlSendsData(command)) ||
	executablesIn(shell, new Set(["wget"])).some((command) =>
		command.args.some((arg) => arg.startsWith("--post") || WGET_AUTH_OPTIONS.has(optionName(arg))),
	) ||
	// nushell: `http post https://... $payload`
	executablesIn(shell, new Set(["http"])).some((command) => /^(?:post|put|patch|delete)$/i.test(command.args[0] ?? "")) ||
	scriptEffects(shell).has("network") ||
	remoteShellPipeline(shell);

// ─── nested pi ───────────────────────────────────────────────────────────────

const PI_MANAGEMENT_COMMANDS = new Set(["config", "install", "list", "remove", "uninstall", "update"]);
// Agent-mode flags (-p, --print, --mode json) are rejected in isNonAgentPi
// before this list is consulted for positional parsing.
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

const shellRule = (test: (shell: ShellAnalysis) => boolean) => (call: GateCall) => call.kind === "shell" && test(call.shell);

const rules: Rule[] = [
	// Block credential material no matter how it is accessed. If the agent needs a
	// secret-adjacent value, the user should provide a redacted snippet explicitly.
	{
		id: "block.credential-structured-access",
		decision: "block",
		description: "credential/private material path accessed by structured tool",
		guidance: GUIDANCE.credentials,
		matches: (call) => call.kind === "path" && isCredentialPath(normalizedPath(call.path, call.cwd)),
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
		matches: (call) => call.kind === "path" && call.access === "write" && isPseudoFsPath(call.path, call.cwd),
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

	// Deletion always requires explicit confirmation (ASKS 1).
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
		matches: (call, env) => call.kind === "shell" && runsGeneratedScript(call.shell, env.state),
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

	// Ask on every git rm: it removes paths and stages the deletion.
	{
		id: "ask.git-rm",
		decision: "ask",
		description: "git rm removes paths and stages the deletion",
		guidance: GUIDANCE.gitRm,
		matches: shellRule(isGitRm),
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

const targetForCall = (call: GateCall) => {
	if (call.kind === "shell") return call.command;
	if (call.kind === "path") return `${call.toolName}: ${call.path}`;
	return call.toolName;
};

const matchingRules = (call: GateCall, env: RuleEnv, decision: Exclude<Decision, "allow">): Match[] =>
	rules
		.filter((rule) => rule.decision === decision && rule.matches(call, env))
		.map(({ id, decision, description, guidance }) => ({ id, decision, description, guidance }));

const writesForCall = (call: GateCall): PathEffect[] => {
	if (call.kind === "shell") return call.shell.written;
	if (call.kind === "path" && call.access === "write") return [{ path: call.path, cwd: call.cwd }];
	return [];
};

const stringInput = (input: unknown, key: string) => {
	if (typeof input !== "object" || input === null) return "";
	const value = Reflect.get(input, key);
	return typeof value === "string" ? value.trim() : "";
};

const normalizeToolCall = (toolName: string, input: unknown, cwd: string): GateCall => {
	if (SHELL_TOOLS.has(toolName)) {
		const command = stringInput(input, "command");
		return { kind: "shell", toolName, command, shell: analyzeShellCommand(command, cwd) };
	}
	const access = PATH_TOOLS.get(toolName);
	if (access) {
		const path = stringInput(input, "path");
		if (path) return { kind: "path", toolName, path, cwd, access };
	}
	return { kind: "other", toolName };
};

export type AssessmentContext = { state?: PermissionGateState; cwd?: string };

export const assessToolCall = (toolName: string, input: unknown, context: AssessmentContext = {}): Assessment => {
	const env: RuleEnv = { state: context.state ?? new PermissionGateState() };
	const call = normalizeToolCall(toolName, input, context.cwd ?? process.cwd());
	const writes = writesForCall(call);
	const target = targetForCall(call);
	const blockMatches = matchingRules(call, env, "block");
	if (blockMatches.length > 0) return { decision: "block", matches: blockMatches, target, writes };

	const askMatches = matchingRules(call, env, "ask");
	if (askMatches.length > 0) return { decision: "ask", matches: askMatches, target, writes };

	return { decision: "allow", matches: [], target, writes };
};
