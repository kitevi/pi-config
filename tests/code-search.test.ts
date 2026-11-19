import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CodeSearchDeps,
	type ReleaseTarget,
	formatResults,
	isLiteralQuery,
	register,
	releaseTarget,
} from "../extensions/code-search.ts";

const execFileAsync = promisify(execFile);

const LATEST_API = "https://api.github.com/repos/probelabs/probe/releases/latest";
const DOWNLOADS = "https://github.com/probelabs/probe/releases/download";
const TARGET = "x86_64-unknown-linux-musl";
const DAY_MS = 24 * 60 * 60 * 1000;

/** probe's outline answer: one result naming the release and its arguments, twelve files past the budget, a tip. */
const fakeProbe = (tag: string): string => `#!/bin/sh
for last; do :; done
echo "Pattern: query"
echo "Path: $last"
echo "Using BM25 ranking (Okapi BM25 algorithm)"
echo "---"
echo "File: $last/src/lib.rs"
echo ""
echo "1    ${tag} $*"
echo ""
echo "Found 1 search results"
echo "Total bytes returned: 42"
echo "Total tokens returned: 12"
echo "Limits applied:"
echo "  Max tokens: 4000"
echo ""
echo "Skipped files due to limits: 12"
echo "Remaining files not shown:"
i=1
while [ "$i" -le 12 ]; do
	echo "  $last/src/more$i.rs <1> <2>"
	i=$((i + 1))
done
echo ""
echo "\u{1F4A1} Tip: Use --session to get the next page"
`;

interface RegisteredTool {
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((update: { content: Array<{ text: string }> }) => void) | undefined,
		ctx: { cwd: string },
	): Promise<{ content: Array<{ text: string }> }>;
}

let root: string;
let repo: string;
let store: string;
let assets: Map<string, Buffer>;
let latest: string;
let offline: boolean;
let requests: string[];
let now: number;
let env: Record<string, string | undefined>;
let execs: Array<{ command: string; args: string[]; cwd: string | undefined }>;

const asset = (tag: string): string => `${DOWNLOADS}/${tag}/probe-${tag}-${TARGET}.tar.gz`;

const fakeFetch: CodeSearchDeps["fetch"] = async (url) => {
	requests.push(url);
	if (offline) throw new TypeError("fetch failed");
	if (url === LATEST_API) return new Response(JSON.stringify({ tag_name: latest }));
	const body = assets.get(url);
	return body ? new Response(new Uint8Array(body)) : new Response("Not Found", { status: 404 });
};

/** Builds a release archive the way probe's CI lays it out and serves it with its digest. */
async function publish(tag: string, options: { digest?: string } = {}): Promise<void> {
	const name = `probe-${tag}-${TARGET}`;
	const build = join(root, "builds", tag);
	await mkdir(join(build, name), { recursive: true });
	await writeFile(join(build, name, "probe"), fakeProbe(tag), { mode: 0o644 });
	await writeFile(join(build, name, "LICENSE"), "Apache-2.0\n");
	const archive = join(build, `${name}.tar.gz`);
	await execFileAsync("tar", ["-czf", archive, "-C", build, name]);
	const bytes = await readFile(archive);
	assets.set(asset(tag), bytes);
	const digest = options.digest ?? createHash("sha256").update(bytes).digest("hex");
	assets.set(`${asset(tag)}.sha256`, Buffer.from(`${digest}  ${name}.tar.gz\n`));
}

/** A fresh session: registers the extension against a minimal pi and returns its search. */
function session(): { search: (params: Record<string, unknown>) => Promise<string>; updates: string[] } {
	const registered: { tool?: RegisteredTool } = {};
	const updates: string[] = [];
	const pi = {
		registerTool: (definition: RegisteredTool) => {
			registered.tool = definition;
		},
		exec: async (command: string, args: string[], options: { cwd?: string } = {}) => {
			execs.push({ command, args, cwd: options.cwd });
			try {
				const { stdout, stderr } = await execFileAsync(command, args, { cwd: options.cwd ?? root });
				return { stdout, stderr, code: 0, killed: false };
			} catch (error) {
				const failure = error as { stdout?: string; stderr?: string; code?: unknown; killed?: boolean };
				return {
					stdout: failure.stdout ?? "",
					stderr: failure.stderr ?? "",
					code: typeof failure.code === "number" ? failure.code : 1,
					killed: failure.killed ?? false,
				};
			}
		},
	};
	register(pi as never, { fetch: fakeFetch, env, platform: "linux", arch: "x64", home: join(root, "home"), now: () => now });
	const tool = registered.tool;
	if (!tool) throw new Error("code_search was not registered");
	const text = (parts: Array<{ text: string }>): string => parts.map((part) => part.text).join("");
	return {
		updates,
		search: async (params) => text((await tool.execute("call", params, undefined, (update) => updates.push(text(update.content)), { cwd: repo })).content),
	};
}

const storeEntries = (): Promise<string[]> =>
	readdir(store).then(
		(names) => names.sort(),
		(): string[] => [],
	);

void describe.skipIf(process.platform === "win32")("code_search", () => {
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "code-search-"));
		repo = join(root, "repo");
		store = join(root, "cache", "probe", "bin");
		await mkdir(join(repo, "src"), { recursive: true });
		await mkdir(join(root, "home"));
		execs = [];
		assets = new Map();
		latest = "v1.0.0";
		offline = false;
		requests = [];
		now = Date.UTC(2026, 10, 19);
		env = { XDG_CACHE_HOME: join(root, "cache") };
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	void it("installs the latest release on first use and trims probe's answer", async () => {
		await publish("v1.0.0");
		const { search, updates } = session();
		const answer = await search({ query: "parseConfig" });

		expect(requests).toEqual([LATEST_API, asset("v1.0.0"), `${asset("v1.0.0")}.sha256`]);
		expect(updates).toEqual(["Downloading probe v1.0.0 for code_search..."]);
		expect(answer).toBe(
			[
				"File: src/lib.rs",
				"",
				`1    v1.0.0 search --format outline --max-tokens 4000 --allow-tests --exact -- parseConfig ${repo}`,
				"",
				"Found 1 search results",
				"12 more matching files not shown, among them:",
				...Array.from({ length: 10 }, (_, index) => `  src/more${index + 1}.rs`),
			].join("\n"),
		);
		expect(await storeEntries()).toEqual(["checked-at", "latest", "v1.0.0"]);
		expect(await readdir(join(store, "v1.0.0"))).toEqual(["probe"]);
		expect(await readFile(join(store, "latest"), "utf8")).toBe("v1.0.0\n");
		expect(await readFile(join(store, "checked-at"), "utf8")).toBe(`${now / 1000}\n`);
	});

	void it("looks for a newer release at most once a day", async () => {
		await publish("v1.0.0");
		await session().search({ query: "parseConfig" });
		requests = [];
		now += DAY_MS - 1000;
		expect(await session().search({ query: "parseConfig" })).toContain("v1.0.0 search");
		expect(requests).toEqual([]);
	});

	void it("updates a day later and keeps only the new and the previous release", async () => {
		await publish("v1.0.0");
		await session().search({ query: "parseConfig" });
		now += DAY_MS;
		requests = [];
		expect(await session().search({ query: "parseConfig" })).toContain("v1.0.0 search");
		expect(requests).toEqual([LATEST_API]);

		await publish("v1.1.0");
		latest = "v1.1.0";
		now += DAY_MS;
		expect(await session().search({ query: "parseConfig" })).toContain("v1.1.0 search");
		expect(await storeEntries()).toEqual(["checked-at", "latest", "v1.0.0", "v1.1.0"]);

		await publish("v1.2.0");
		latest = "v1.2.0";
		now += DAY_MS;
		expect(await session().search({ query: "parseConfig" })).toContain("v1.2.0 search");
		expect(await storeEntries()).toEqual(["checked-at", "latest", "v1.1.0", "v1.2.0"]);
	});

	void it("refuses a release that does not match its digest and installs nothing", async () => {
		await publish("v1.0.0", { digest: "0".repeat(64) });
		await expect(session().search({ query: "parseConfig" })).rejects.toThrow(/does not match its SHA-256 digest.*grep/s);
		expect(await storeEntries()).toEqual([]);
	});

	void it("falls back to the installed release when GitHub is out of reach", async () => {
		await publish("v1.0.0");
		await session().search({ query: "parseConfig" });
		offline = true;
		now += 2 * DAY_MS;
		requests = [];
		expect(await session().search({ query: "parseConfig" })).toContain("v1.0.0 search");
		expect(requests).toEqual([LATEST_API]);
		requests = [];
		await session().search({ query: "parseConfig" });
		expect(requests).toEqual([]);
	});

	void it("is unavailable offline before anything is installed", async () => {
		offline = true;
		await expect(session().search({ query: "parseConfig" })).rejects.toThrow(
			"code_search is unavailable (fetch failed); search with grep, find, and read instead.",
		);
	});

	void it("shares one download between concurrent searches", async () => {
		await publish("v1.0.0");
		const { search } = session();
		await Promise.all([search({ query: "parseConfig" }), search({ query: "loadFile" })]);
		expect(requests).toEqual([LATEST_API, asset("v1.0.0"), `${asset("v1.0.0")}.sha256`]);
	});

	void it("runs PROBE_PATH without downloading", async () => {
		await mkdir(join(root, "bin"));
		await writeFile(join(root, "bin", "probe"), fakeProbe("local"), { mode: 0o755 });
		env["PROBE_PATH"] = join(root, "bin", "probe");
		expect(await session().search({ query: "parseConfig" })).toContain("local search");
		expect(requests).toEqual([]);
	});

	void it("pins PROBE_VERSION without asking for the latest release", async () => {
		await publish("v1.0.0");
		latest = "v9.9.9";
		env["PROBE_VERSION"] = "v1.0.0";
		expect(await session().search({ query: "parseConfig" })).toContain("v1.0.0 search");
		expect(requests).toEqual([asset("v1.0.0"), `${asset("v1.0.0")}.sha256`]);
		env["PROBE_VERSION"] = "1.0";
		await expect(session().search({ query: "parseConfig" })).rejects.toThrow(/PROBE_VERSION=1\.0 is not a probe release tag/);
	});

	void it("leaves several words to probe's query parser and clamps the budget", async () => {
		await publish("v1.0.0");
		const { search } = session();
		expect(await search({ query: "  parse AND config ", maxTokens: 50_000 })).toContain(
			`--max-tokens 20000 --allow-tests -- parse AND config ${repo}`,
		);
		expect(await search({ query: "Foo::bar", maxTokens: 10, path: "src" })).toContain(
			`--max-tokens 500 --allow-tests --exact -- Foo::bar ${join(repo, "src")}`,
		);
	});

	void it("runs probe in the home directory, where a repository's .probe/settings.json does not apply", async () => {
		await publish("v1.0.0");
		await session().search({ query: "parseConfig" });
		expect(execs.filter((run) => run.args[0] === "search").map((run) => run.cwd)).toEqual([join(root, "home")]);
	});

	void it("rejects a missing path and an empty query before anything else", async () => {
		await expect(session().search({ query: "parseConfig", path: "missing" })).rejects.toThrow("missing does not exist");
		await expect(session().search({ query: "  " })).rejects.toThrow("code_search needs a query");
		expect(requests).toEqual([]);
	});
});

void describe("formatResults", () => {
	void it("keeps probe's no-results line and drops its tips", () => {
		const raw = [
			"Pattern: zzqqxx",
			"Path: /repo",
			"Using BM25 ranking (Okapi BM25 algorithm)",
			"No results found.",
			"",
			"\u{1F4A1} Tips to improve your search:",
			'  - Try synonyms or related terms (e.g., "fetch" instead of "get")',
		].join("\n");
		expect(formatResults(raw, ["/repo"], "/home/me")).toBe("No results found.");
	});

	void it("makes paths relative to the root that holds them and drops the totals", () => {
		const raw = "File: /private/tmp/repo/a.ts\n\n1    x\n\nFound 1 search results\nTotal bytes returned: 1\nTotal tokens returned: 1\n";
		expect(formatResults(raw, ["/tmp/repo", "/private/tmp/repo"], "/home/me")).toBe("File: a.ts\n\n1    x\n\nFound 1 search results");
	});

	void it("resolves the files left out against the directory probe ran in", () => {
		const raw = [
			"File: /home/me/repo/a.ts",
			"",
			"1    x",
			"",
			"Found 1 search results",
			"Skipped files due to limits: 3",
			"",
			"Remaining files not shown:",
			"  repo/src/b.ts <1> <1>",
			"  /home/me/repo/c.ts <1> <2>",
			"  /elsewhere/d.ts <1> <1>",
		].join("\n");
		expect(formatResults(raw, ["/home/me/repo"], "/home/me")).toBe(
			"File: a.ts\n\n1    x\n\nFound 1 search results\n3 more matching files not shown, among them:\n  src/b.ts\n  c.ts\n  /elsewhere/d.ts",
		);
	});
});

void describe("isLiteralQuery", () => {
	void it.each(["parseConfig", "user_id", "Foo::bar", "--max-tokens", "a[0]", "https://api.github.com", "$scope"])("%s is literal", (query) => {
		expect(isLiteralQuery(query)).toBe(true);
	});
	void it.each(["parse config", "AND", "NOT", '"exact phrase"', "ext:ts", "file:src/**/*.py", "dir:tests"])("%s is not", (query) => {
		expect(isLiteralQuery(query)).toBe(false);
	});
});

void describe("releaseTarget", () => {
	const cases: Array<[platform: string, arch: string, expected: ReleaseTarget | undefined]> = [
		["darwin", "arm64", { target: "aarch64-apple-darwin", archive: "tar.gz", binary: "probe" }],
		["darwin", "x64", { target: "x86_64-apple-darwin", archive: "tar.gz", binary: "probe" }],
		["linux", "arm64", { target: "aarch64-unknown-linux-musl", archive: "tar.gz", binary: "probe" }],
		["linux", "x64", { target: "x86_64-unknown-linux-musl", archive: "tar.gz", binary: "probe" }],
		["win32", "x64", { target: "x86_64-pc-windows-msvc", archive: "zip", binary: "probe.exe" }],
		["win32", "arm64", { target: "x86_64-pc-windows-msvc", archive: "zip", binary: "probe.exe" }],
		["freebsd", "x64", undefined],
		["linux", "ia32", undefined],
	];
	void it.each(cases)("%s %s", (platform, arch, expected) => {
		expect(releaseTarget(platform, arch)).toEqual(expected);
	});
});
