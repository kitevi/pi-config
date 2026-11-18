import { strict as assert } from "node:assert";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(repoRoot, "skills", "codebase-search", "scripts", "cbm");
const latestApi = "https://api.github.com/repos/DeusData/codebase-memory-mcp/releases/latest";
const downloads = "https://github.com/DeusData/codebase-memory-mcp/releases/download";
const assets = [
	"linux-amd64-portable.tar.gz",
	"linux-arm64-portable.tar.gz",
	"darwin-amd64.tar.gz",
	"darwin-arm64.tar.gz",
	"windows-amd64.zip",
	"windows-arm64.zip",
].map((name) => `codebase-memory-mcp-${name}`);

const has = (command: string): boolean => spawnSync("sh", ["-c", 'command -v "$1"', "sh", command]).status === 0;
const canZip = has("zip") && has("unzip");

// Stands in for the real binary: reports its tag, echoes arguments, exits on request.
const fakeBinary = (tag: string): string => `#!/bin/sh
case \${1-} in
  --version) echo "codebase-memory-mcp ${tag}" ;;
  exit) exit "$2" ;;
  *) printf '<%s>\\n' "$@" ;;
esac
`;

// Serves releases from $FAKE_RELEASES the way GitHub would, logging every URL.
const fakeCurl = `#!/bin/sh
for arg; do
  if [ "\${prev-}" = -o ]; then out=$arg; fi
  prev=$arg
done
url=$prev
printf '%s\\n' "$url" >>"$FAKE_LOG"
if [ -n "\${FAKE_OFFLINE-}" ]; then echo 'curl: (6) Could not resolve host' >&2; exit 6; fi
dir=\${url%/*}
case $url in
  ${latestApi}) src=$FAKE_RELEASES/latest.json ;;
  ${downloads}/*/checksums.txt) src=$FAKE_RELEASES/\${dir##*/}/checksums.txt ;;
  ${downloads}/*.tar.gz) src=$FAKE_RELEASES/\${dir##*/}/release.tar.gz ;;
  ${downloads}/*.zip) src=$FAKE_RELEASES/\${dir##*/}/release.zip ;;
  *) src= ;;
esac
if [ -z "$src" ] || [ ! -f "$src" ]; then echo 'curl: (22) 404' >&2; exit 22; fi
cp "$src" "$out"
`;

type Run = { code: number | null; stdout: string; stderr: string };

let home = "";

const store = (): string => join(home, "cache", "codebase-memory-mcp", "bin");
const requests = async (): Promise<string[]> =>
	(await readFile(join(home, "curl.log"), "utf8").catch(() => "")).split("\n").filter(Boolean);

function cbm(args: string[], env: Record<string, string> = {}, stubs = join(home, "stub")): Promise<Run> {
	return new Promise((resolve) => {
		execFile(
			script,
			args,
			{
				env: {
					PATH: `${stubs}:${join(home, "stub")}:${process.env["PATH"] ?? ""}`,
					HOME: home,
					XDG_CACHE_HOME: join(home, "cache"),
					FAKE_RELEASES: join(home, "releases"),
					FAKE_LOG: join(home, "curl.log"),
					...env,
				},
				timeout: 20_000,
			},
			(error, stdout, stderr) => {
				const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
				resolve({ code, stdout, stderr });
			},
		);
	});
}

// Publishes TAG as the latest release, under every asset name upstream uses.
async function publish(tag: string, options: { corrupt?: boolean } = {}): Promise<void> {
	const dir = join(home, "releases", tag);
	const pkg = join(dir, "pkg");
	await mkdir(pkg, { recursive: true });
	for (const name of ["codebase-memory-mcp", "codebase-memory-mcp.exe"]) {
		await writeFile(join(pkg, name), fakeBinary(tag), { mode: 0o755 });
	}
	await execFileAsync("tar", ["-czf", join(dir, "release.tar.gz"), "-C", pkg, "codebase-memory-mcp"]);
	if (canZip) await execFileAsync("zip", ["-qj", join(dir, "release.zip"), join(pkg, "codebase-memory-mcp.exe")]);

	const digest = async (file: string): Promise<string> =>
		options.corrupt ? "0".repeat(64) : createHash("sha256").update(await readFile(file)).digest("hex");
	const tarDigest = await digest(join(dir, "release.tar.gz"));
	const zipDigest = canZip ? await digest(join(dir, "release.zip")) : "0".repeat(64);
	const lines = assets.map((asset) => `${asset.endsWith(".zip") ? zipDigest : tarDigest}  ${asset}\n`);
	await writeFile(join(dir, "checksums.txt"), lines.join(""));
	await writeFile(join(home, "releases", "latest.json"), `{\n  "tag_name": "${tag}",\n  "prerelease": false\n}\n`);
}

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "pi-config-cbm-"));
	await mkdir(join(home, "stub"));
	await writeFile(join(home, "stub", "curl"), fakeCurl, { mode: 0o755 });
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

void describe("codebase-search cbm wrapper", () => {
	void it("installs the latest release on first use, then skips the network while the check is fresh", async () => {
		await publish("v1.0.0");

		const first = await cbm(["search", "two words"]);
		assert.equal(first.code, 0, first.stderr);
		assert.equal(first.stdout, "<search>\n<two words>\n");
		const fetched = await requests();
		assert.equal(fetched.length, 3);
		assert.equal(fetched[0], latestApi);
		assert.equal(await readFile(join(store(), "latest"), "utf8"), "v1.0.0\n");

		const second = await cbm(["exit", "3"]);
		assert.equal(second.code, 3);
		assert.equal((await requests()).length, 3);
	});

	void it("updates after the interval, keeps the previous release, and prunes older ones", async () => {
		await publish("v1.0.0");
		await cbm(["--version"]);
		await publish("v1.1.0");
		await cbm(["--version"], { CBM_UPDATE_INTERVAL: "0" });
		await mkdir(join(store(), `.work.${spawnSync("true").pid}`));
		await publish("v1.2.0");

		const run = await cbm(["--version"], { CBM_UPDATE_INTERVAL: "0" });
		assert.equal(run.stdout, "codebase-memory-mcp v1.2.0\n", run.stderr);
		assert.deepEqual((await readdir(store())).sort(), ["cbm-v1.1.0", "cbm-v1.2.0", "checked-at", "latest"]);
	});

	void it("refuses a download whose SHA-256 does not match and installs nothing", async () => {
		await publish("v1.0.0", { corrupt: true });

		const run = await cbm(["--version"]);
		assert.equal(run.code, 1);
		assert.match(run.stderr, /failed verification/);
		assert.deepEqual(await readdir(store()), []);
	});

	void it("keeps running the installed release while GitHub is unreachable, until the next check", async () => {
		await publish("v1.0.0");
		await cbm(["--version"]);
		await writeFile(join(store(), "checked-at"), "1\n");

		const offline = await cbm(["--version"], { FAKE_OFFLINE: "1" });
		assert.equal(offline.code, 0, offline.stderr);
		assert.equal(offline.stdout, "codebase-memory-mcp v1.0.0\n");
		assert.match(offline.stderr, /warning: update failed; running v1\.0\.0/);
		const count = (await requests()).length;
		await cbm(["--version"], { FAKE_OFFLINE: "1" });
		assert.equal((await requests()).length, count);
	});

	void it("fails clearly when GitHub is unreachable before the first install", async () => {
		const run = await cbm(["--version"], { FAKE_OFFLINE: "1" });
		assert.equal(run.code, 1);
		assert.match(run.stderr, /not installed in .* could not be downloaded/);
	});

	void it("runs a pinned CBM_VERSION without asking GitHub for the latest release", async () => {
		await publish("v1.0.0");
		await publish("v1.1.0");

		const run = await cbm(["--version"], { CBM_VERSION: "v1.0.0" });
		assert.equal(run.stdout, "codebase-memory-mcp v1.0.0\n", run.stderr);
		assert.ok(!(await requests()).includes(latestApi));
	});

	void it.each([
		{ args: ["cli", "index_repository", "--repo-path", ".", "--persistence", "true"], error: /--persistence is refused/ },
		{ args: ["cli", "--quiet", "index_repository", "--repo-path=.", "--persistence=true"], error: /--persistence is refused/ },
		{ args: ["cli", "index_repository", '{"repo_path":"."}'], error: /takes flags here/ },
		{ args: ["cli", "index_repository"], error: /needs --repo-path/ },
	])("refuses indexing that could write into the repository: $args", async ({ args, error }) => {
		const run = await cbm(args);
		assert.equal(run.code, 2);
		assert.match(run.stderr, error);
		assert.deepEqual(await requests(), []);
	});

	void it("refuses to index a repository that holds a .codebase-memory artifact, and leaves it untouched", async () => {
		const repo = join(home, "repo");
		await mkdir(join(repo, ".codebase-memory"), { recursive: true });

		const run = await cbm(["cli", "index_repository", "--repo-path", repo]);
		assert.equal(run.code, 2);
		assert.match(run.stderr, /holds a \.codebase-memory\/ graph artifact/);
		assert.deepEqual(await readdir(join(repo, ".codebase-memory")), []);
	});

	void it("passes ordinary index and help calls through", async () => {
		await publish("v1.0.0");
		const repo = join(home, "repo");
		await mkdir(repo);

		const run = await cbm(["cli", "index_repository", "--repo-path", repo, "--persistence", "false"]);
		assert.equal(run.code, 0, run.stderr);
		assert.equal(run.stdout, `<cli>\n<index_repository>\n<--repo-path>\n<${repo}>\n<--persistence>\n<false>\n`);
		assert.equal((await cbm(["cli", "index_repository", "--help"])).code, 0);
	});

	void it.each(["install", "uninstall", "update"])("refuses %s, which acts outside the store", async (command) => {
		const run = await cbm([command]);
		assert.equal(run.code, 2);
		assert.match(run.stderr, /refused/);
		assert.deepEqual(await requests(), []);
	});

	void it.skipIf(!has("shellcheck"))("passes ShellCheck as POSIX sh", async () => {
		await execFileAsync("shellcheck", ["--shell=sh", "--severity=style", script]);
	});
});

void describe("codebase-search cbm platforms", () => {
	const platforms = [
		{ os: "Linux", arch: "x86_64", arm64: "0", asset: "linux-amd64-portable.tar.gz" },
		{ os: "Linux", arch: "aarch64", arm64: "0", asset: "linux-arm64-portable.tar.gz" },
		{ os: "Darwin", arch: "arm64", arm64: "1", asset: "darwin-arm64.tar.gz" },
		{ os: "Darwin", arch: "x86_64", arm64: "1", asset: "darwin-arm64.tar.gz" },
		{ os: "Darwin", arch: "x86_64", arm64: "0", asset: "darwin-amd64.tar.gz" },
		{ os: "MINGW64_NT-10.0-26100", arch: "x86_64", arm64: "0", asset: "windows-amd64.zip" },
		{ os: "MSYS_NT-10.0-26100", arch: "aarch64", arm64: "0", asset: "windows-arm64.zip" },
	];

	const fakePlatform = async (os: string, arch: string, arm64: string): Promise<string> => {
		const dir = join(home, "platform");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "uname"), `#!/bin/sh\ncase $1 in -s) echo '${os}' ;; -m) echo '${arch}' ;; esac\n`, { mode: 0o755 });
		await writeFile(join(dir, "sysctl"), `#!/bin/sh\necho ${arm64}\n`, { mode: 0o755 });
		return dir;
	};

	for (const { os, arch, arm64, asset } of platforms) {
		const rosetta = os === "Darwin" && arch === "x86_64" && arm64 === "1" ? " under Rosetta" : "";
		void it.skipIf(asset.endsWith(".zip") && !canZip)(`installs ${asset} on ${os} ${arch}${rosetta}`, async () => {
			await publish("v1.0.0");
			const exe = asset.startsWith("windows") ? "codebase-memory-mcp.exe" : "codebase-memory-mcp";

			const run = await cbm(["--version"], {}, await fakePlatform(os, arch, arm64));
			assert.equal(run.stdout, "codebase-memory-mcp v1.0.0\n", run.stderr);
			assert.equal((await requests()).at(-1), `${downloads}/v1.0.0/codebase-memory-mcp-${asset}`);
			assert.deepEqual(await readdir(join(store(), "cbm-v1.0.0")), [exe]);
		});
	}

	void it.each([
		{ os: "FreeBSD", arch: "amd64", error: /unsupported OS: FreeBSD/ },
		{ os: "Linux", arch: "i686", error: /unsupported CPU: i686/ },
	])("refuses $os $arch, which has no release build", async ({ os, arch, error }) => {
		const run = await cbm(["--version"], {}, await fakePlatform(os, arch, "0"));
		assert.equal(run.code, 1);
		assert.match(run.stderr, error);
		assert.deepEqual(await requests(), []);
	});
});
