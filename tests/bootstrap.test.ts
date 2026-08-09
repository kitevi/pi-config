import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, lstat, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const bootstrapPath = join(repoRoot, "bootstrap.mjs");

async function runBootstrap(home: string): Promise<void> {
	await execFileAsync(process.execPath, [bootstrapPath, "--light"], {
		cwd: repoRoot,
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
		},
		timeout: 30_000,
	});
}

function appendSystemPath(home: string): string {
	return join(home, ".pi", "agent", "APPEND_SYSTEM.md");
}

void describe("bootstrap reconciliation", () => {
	void it("installs APPEND_SYSTEM.md as a regular file matching the repository copy", async () => {
		const home = await mkdtemp(join(tmpdir(), "pi-config-bootstrap-"));

		try {
			await runBootstrap(home);

			const repoAppend = await readFile(join(repoRoot, "APPEND_SYSTEM.md"), "utf8");
			const generatedPath = appendSystemPath(home);
			const firstOutput = await readFile(generatedPath, "utf8");
			const targetStat = await lstat(generatedPath);

			assert.equal(firstOutput, repoAppend);
			assert.equal(targetStat.isFile(), true);
			assert.equal(targetStat.isSymbolicLink(), false);

			await runBootstrap(home);
			assert.equal(await readFile(generatedPath, "utf8"), firstOutput);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	void it("replaces the removed Pi Lovely IDE wiring with the vendored IDE extension", async () => {
		const home = await mkdtemp(join(tmpdir(), "pi-config-bootstrap-"));

		try {
			const settings = JSON.parse(await readFile(join(repoRoot, "settings.json"), "utf8"));
			const legacyTarget = join(home, ".pi", "agent", "xl0-lovely-ide.json");
			const vendoredEntry = join(home, ".pi", "agent", "extensions", "ide", "index.js");

			// Declared state: the old package/config are gone, the vendored
			// bridge exists in the repo.
			assert.equal(settings.packages.includes("npm:@xl0/pi-lovely-ide"), false);
			assert.equal(existsSync(join(repoRoot, "xl0-lovely-ide.json")), false);
			assert.equal(existsSync(join(repoRoot, "extensions", "ide", "index.js")), true);

			await runBootstrap(home);

			// Reconciliation never writes the stale legacy config (per
			// docs/adr/0001-user-managed-legacy-path-cleanup.md it is the
			// user's to remove manually), and links the vendored extension.
			assert.equal(existsSync(legacyTarget), false);
			assert.equal(existsSync(vendoredEntry), true);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
