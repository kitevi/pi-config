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

});
