/**
 * Registers `code_search`: ranked code search through probe
 * (https://github.com/probelabs/probe), which pairs ripgrep with tree-sitter and
 * needs no index. A call returns whole functions, classes, and blocks with line
 * numbers, best match first.
 *
 * The first call downloads probe's release for the platform, checks its SHA-256,
 * and keeps it in `${XDG_CACHE_HOME:-~/.cache}/probe/bin/<tag>/`; later calls look
 * for a newer release at most once a day and fall back to an installed one when
 * the check fails. `PROBE_PATH` runs a given binary instead; `PROBE_VERSION` pins
 * a release tag. Reconciliation stays offline. Spec: `docs/code-search.md`.
 *
 * probe runs in the home directory, not the repository: it reads
 * `./.probe/settings.json` from its working directory, and a repository's copy
 * could turn on language servers, which can run the repository's build scripts.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LATEST_RELEASE_API = "https://api.github.com/repos/probelabs/probe/releases/latest";
const RELEASE_DOWNLOADS = "https://github.com/probelabs/probe/releases/download";
/** Release tags such as `v0.6.0` and `v0.6.0-rc347`. */
const TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const CHECK_INTERVAL_SECONDS = 24 * 60 * 60;
const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const SEARCH_TIMEOUT_MS = 120_000;
/** An install work directory this old belongs to a run that died; it is swept. */
const STALE_WORK_MS = 60 * 60 * 1000;
export const DEFAULT_MAX_TOKENS = 4_000;
export const MIN_MAX_TOKENS = 500;
export const MAX_MAX_TOKENS = 20_000;
/** Matching files past the token budget that the answer names. */
const LISTED_MORE_FILES = 10;

const DESCRIPTION =
	"Searches the repository's code and returns whole functions, classes, and blocks with line numbers, best match first. Needs no index. " +
	"A query without spaces, such as `parseConfig`, `user_id`, or `Foo::bar`, matches literally (case-insensitive, also inside longer names): use it to find where a symbol is defined and everywhere it is used. " +
	'Several words match by word stem and rank by relevance; combine them with AND, OR, NOT, and "quoted phrases", and narrow with ext:ts, file:src/**/*.py, or dir:tests. Includes tests. ' +
	"When the repository's instructions (AGENTS.md, CLAUDE.md) name their own code-search tool, use that tool instead for the whole session; call this one there only if that tool fails.";

export interface ReleaseTarget {
	/** Rust target triple in the release asset name. */
	target: string;
	archive: "tar.gz" | "zip";
	binary: string;
}

/** The release build for a Node `process.platform` and `process.arch`. */
export function releaseTarget(platform: string, arch: string): ReleaseTarget | undefined {
	const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : undefined;
	if (!cpu) return undefined;
	switch (platform) {
		case "darwin":
			return { target: `${cpu}-apple-darwin`, archive: "tar.gz", binary: "probe" };
		case "linux":
			return { target: `${cpu}-unknown-linux-musl`, archive: "tar.gz", binary: "probe" };
		case "win32":
			// No Windows ARM64 build exists; Windows on ARM runs the x86-64 one under emulation.
			return { target: "x86_64-pc-windows-msvc", archive: "zip", binary: "probe.exe" };
		default:
			return undefined;
	}
}

/**
 * A query without spaces, such as `parseConfig`, `Foo::bar`, or `--max-tokens`,
 * which probe then matches literally; operators and filters such as `ext:ts`
 * stay with probe's query parser.
 */
export function isLiteralQuery(query: string): boolean {
	return !/[\s"]/.test(query) && !/^(?:AND|OR|NOT)$/.test(query) && !/^(?:ext|file|path|dir|lang|language|type):/i.test(query);
}

/**
 * Trims probe's outline answer for the model: drops the echoed query, the
 * totals, and the CLI tips, makes paths relative to the first root that holds
 * them, and names only the first few matching files past the token budget.
 */
export function formatResults(raw: string, roots: readonly string[], probeCwd: string): string {
	const relative = (path: string): string => {
		for (const root of roots) {
			if (path.startsWith(root + sep)) return path.slice(root.length + 1);
		}
		return path;
	};
	const out: string[] = [];
	const moreFiles: string[] = [];
	let skipped = 0;
	let part: "results" | "summary" | "more" | "tips" = "results";
	let seenFile = false;
	for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
		if (line.startsWith("\u{1F4A1}")) {
			part = "tips";
		} else if (/^Found \d+ search results?\.?$/.test(line) || /^No results found\.?$/.test(line)) {
			part = "summary";
			out.push(line);
		} else if (part === "results") {
			if (line.startsWith("File: ")) {
				seenFile = true;
				out.push(`File: ${relative(resolve(probeCwd, line.slice(6)))}`);
			} else if (seenFile || !/^(?:Pattern: |Path: |Using .* ranking|---$)/.test(line)) {
				out.push(line);
			}
		} else if (part === "summary") {
			const count = /^Skipped files due to limits: (\d+)/.exec(line);
			if (count) skipped = Number(count[1]);
			else if (line.startsWith("Remaining files not shown")) part = "more";
		} else if (part === "more") {
			const entry = /^\s+(\S.*?)(?: <\d+> <\d+>)?\s*$/.exec(line);
			// probe names these relative to its own working directory when they lie under it.
			if (entry?.[1] && moreFiles.length < LISTED_MORE_FILES) moreFiles.push(relative(resolve(probeCwd, entry[1])));
		}
	}
	if (skipped > 0) {
		out.push(`${skipped} more matching files not shown${moreFiles.length > 0 ? ", among them:" : "."}`);
		out.push(...moreFiles.map((path) => `  ${path}`));
	}
	return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** What the extension reaches outside itself; tests replace it. */
export interface CodeSearchDeps {
	fetch: (url: string, init: { signal: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;
	env: Readonly<Record<string, string | undefined>>;
	platform: string;
	arch: string;
	home: string;
	/** Milliseconds since the epoch. */
	now: () => number;
}

type Exec = ExtensionAPI["exec"];

export default function codeSearch(pi: ExtensionAPI): void {
	register(pi, {
		fetch: (url, init) => fetch(url, init),
		env: process.env,
		platform: process.platform,
		arch: process.arch,
		home: homedir(),
		now: () => Date.now(),
	});
}

export function register(pi: ExtensionAPI, deps: CodeSearchDeps): void {
	let pending: Promise<string> | undefined;
	const locate = (signal: AbortSignal | undefined, notify: (text: string) => void): Promise<string> => {
		pending ??= locateProbe(pi.exec.bind(pi), deps, signal, notify).finally(() => {
			pending = undefined;
		});
		return pending;
	};

	pi.registerTool({
		name: "code_search",
		label: "Code search",
		description: DESCRIPTION,
		parameters: Type.Object({
			query: Type.String({
				description: 'Text without spaces, such as an identifier, for a literal match; or several words, optionally with AND, OR, NOT, "phrases", ext:, file:, and dir:',
			}),
			path: Type.Optional(
				Type.String({ description: "File or directory to search, relative to the working directory; default: the whole working directory" }),
			),
			maxTokens: Type.Optional(
				Type.Number({ description: `Code budget of the answer in tokens; default ${DEFAULT_MAX_TOKENS}, at most ${MAX_MAX_TOKENS}` }),
			),
		}),
		annotations: { readOnlyHint: true },
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const query = params.query.trim();
			if (!query) throw new Error("code_search needs a query");
			const searchPath = resolve(ctx.cwd, params.path ?? ".");
			if (!(await exists(searchPath))) throw new Error(`${params.path ?? searchPath} does not exist`);
			const maxTokens = Math.min(Math.max(Math.round(params.maxTokens ?? DEFAULT_MAX_TOKENS), MIN_MAX_TOKENS), MAX_MAX_TOKENS);

			let probe: string;
			try {
				probe = await locate(signal, (text) => onUpdate?.({ content: [{ type: "text", text }], details: undefined }));
			} catch (error) {
				throw new Error(`code_search is unavailable (${errorMessage(error)}); search with grep, find, and read instead.`);
			}

			const args = ["search", "--format", "outline", "--max-tokens", String(maxTokens), "--allow-tests"];
			if (isLiteralQuery(query)) args.push("--exact");
			args.push("--", query, searchPath);
			// From the home directory, probe never reads a repository's .probe/settings.json (see the header).
			const result = await pi.exec(probe, args, execOptions(signal, SEARCH_TIMEOUT_MS, deps.home));
			if (result.code !== 0) {
				const how = result.killed ? "was stopped" : `exited with ${result.code}`;
				throw new Error(`probe ${how}: ${(result.stderr || result.stdout).trim().slice(-2_000)}`);
			}
			const roots = [...new Set([ctx.cwd, await realpath(ctx.cwd).catch(() => ctx.cwd)])];
			const probeCwd = await realpath(deps.home).catch(() => deps.home);
			return { content: [{ type: "text", text: formatResults(result.stdout, roots, probeCwd) || "No results found." }], details: undefined };
		},
	});
}

async function locateProbe(
	exec: Exec,
	deps: CodeSearchDeps,
	signal: AbortSignal | undefined,
	notify: (text: string) => void,
): Promise<string> {
	const override = deps.env["PROBE_PATH"];
	if (override) return override;
	const target = releaseTarget(deps.platform, deps.arch);
	if (!target) throw new Error(`probe publishes no build for ${deps.platform} on ${deps.arch}`);
	const store = join(deps.env["XDG_CACHE_HOME"] || join(deps.home, ".cache"), "probe", "bin");
	const binaryOf = (tag: string): string => join(store, tag, target.binary);
	const install = async (tag: string): Promise<void> => {
		if (await exists(binaryOf(tag))) return;
		notify(`Downloading probe ${tag} for code_search...`);
		await installRelease(exec, deps, store, tag, target, signal);
	};

	const pinned = deps.env["PROBE_VERSION"];
	if (pinned) {
		if (!TAG_PATTERN.test(pinned)) throw new Error(`PROBE_VERSION=${pinned} is not a probe release tag such as v0.6.0`);
		await install(pinned);
		return binaryOf(pinned);
	}

	const recorded = await readTag(join(store, "latest"));
	const age = deps.now() / 1000 - Number(await readText(join(store, "checked-at")));
	if (recorded && age >= 0 && age < CHECK_INTERVAL_SECONDS && (await exists(binaryOf(recorded)))) return binaryOf(recorded);

	let tag: string;
	try {
		tag = await latestTag(deps, signal);
		await install(tag);
	} catch (error) {
		const fallback = signal?.aborted ? undefined : await installedTag(store, recorded, target.binary);
		if (!fallback) throw error;
		tag = fallback;
	}
	await record(store, tag, deps.now());
	await prune(store, [tag, recorded], deps.now());
	return binaryOf(tag);
}

async function latestTag(deps: CodeSearchDeps, signal: AbortSignal | undefined): Promise<string> {
	const response = await deps.fetch(LATEST_RELEASE_API, {
		signal: withTimeout(signal, CHECK_TIMEOUT_MS),
		headers: { accept: "application/vnd.github+json" },
	});
	if (!response.ok) throw new Error(`GitHub answered ${response.status} for probe's latest release`);
	const release: unknown = await response.json();
	const tag = typeof release === "object" && release !== null ? (release as { tag_name?: unknown }).tag_name : undefined;
	if (typeof tag !== "string" || !TAG_PATTERN.test(tag)) throw new Error("probe's latest release has no usable tag");
	return tag;
}

async function installRelease(
	exec: Exec,
	deps: CodeSearchDeps,
	store: string,
	tag: string,
	target: ReleaseTarget,
	signal: AbortSignal | undefined,
): Promise<void> {
	const asset = `probe-${tag}-${target.target}.${target.archive}`;
	const url = `${RELEASE_DOWNLOADS}/${tag}/${asset}`;
	const [archive, digests] = await Promise.all([download(deps, url, signal), download(deps, `${url}.sha256`, signal)]);
	const expected = /\b[0-9a-f]{64}\b/i.exec(digests.toString("utf8"))?.[0]?.toLowerCase();
	if (!expected) throw new Error(`${asset}.sha256 holds no SHA-256 digest`);
	if (createHash("sha256").update(archive).digest("hex") !== expected) {
		throw new Error(`${asset} does not match its SHA-256 digest`);
	}

	await mkdir(store, { recursive: true });
	const work = await mkdtemp(join(store, ".install-"));
	try {
		const archivePath = join(work, asset);
		await writeFile(archivePath, archive);
		const unpacked = join(work, "unpacked");
		await mkdir(unpacked);
		const tar = await exec("tar", ["-xf", archivePath, "-C", unpacked], execOptions(signal, DOWNLOAD_TIMEOUT_MS));
		if (tar.code !== 0) throw new Error(`tar could not unpack ${asset}: ${(tar.stderr || tar.stdout).trim()}`);
		const found = await findFile(unpacked, target.binary, 2);
		if (!found) throw new Error(`${asset} holds no ${target.binary}`);
		const staged = join(work, tag);
		await mkdir(staged);
		await rename(found, join(staged, target.binary));
		await chmod(join(staged, target.binary), 0o755);
		try {
			await rename(staged, join(store, tag));
		} catch (error) {
			// A concurrent run may have installed the same release first.
			if (!(await exists(join(store, tag, target.binary)))) throw error;
		}
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

async function download(deps: CodeSearchDeps, url: string, signal: AbortSignal | undefined): Promise<Buffer> {
	const response = await deps.fetch(url, { signal: withTimeout(signal, DOWNLOAD_TIMEOUT_MS) });
	if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
	return Buffer.from(await response.arrayBuffer());
}

/** The installed release to run when no newer one can be had: the recorded one, else the newest build. */
async function installedTag(store: string, preferred: string | undefined, binary: string): Promise<string | undefined> {
	if (preferred && (await exists(join(store, preferred, binary)))) return preferred;
	let newest: { tag: string; built: number } | undefined;
	for (const name of await readdir(store).catch((): string[] => [])) {
		if (!TAG_PATTERN.test(name)) continue;
		const built = await stat(join(store, name, binary)).then(
			(info) => info.mtimeMs,
			() => undefined,
		);
		if (built !== undefined && (!newest || built > newest.built)) newest = { tag: name, built };
	}
	return newest?.tag;
}

async function record(store: string, tag: string, now: number): Promise<void> {
	await mkdir(store, { recursive: true });
	await writeAtomically(join(store, "latest"), `${tag}\n`);
	await writeAtomically(join(store, "checked-at"), `${Math.floor(now / 1000)}\n`);
}

/** Keeps the releases in `keep` (the one in use and the one before it) and sweeps dead install work. */
async function prune(store: string, keep: ReadonlyArray<string | undefined>, now: number): Promise<void> {
	for (const name of await readdir(store).catch((): string[] => [])) {
		const path = join(store, name);
		const release = TAG_PATTERN.test(name) && !keep.includes(name);
		const deadWork =
			name.startsWith(".install-") &&
			now -
				(await stat(path).then(
					(info) => info.mtimeMs,
					() => now,
				)) >
				STALE_WORK_MS;
		if (release || deadWork) await rm(path, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function findFile(dir: string, name: string, depth: number): Promise<string | undefined> {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isFile() && entry.name === name) return join(dir, entry.name);
	}
	if (depth === 0) return undefined;
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const found = await findFile(join(dir, entry.name), name, depth - 1);
		if (found) return found;
	}
	return undefined;
}

async function writeAtomically(path: string, text: string): Promise<void> {
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, text);
	await rename(temporary, path);
}

async function readTag(path: string): Promise<string | undefined> {
	const text = (await readText(path))?.trim();
	return text && TAG_PATTERN.test(text) ? text : undefined;
}

function readText(path: string): Promise<string | undefined> {
	return readFile(path, "utf8").catch(() => undefined);
}

function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
	return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

function execOptions(signal: AbortSignal | undefined, timeout: number, cwd?: string): Parameters<Exec>[2] {
	return { timeout, ...(signal ? { signal } : {}), ...(cwd ? { cwd } : {}) };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
