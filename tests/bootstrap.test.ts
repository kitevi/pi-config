import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
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

void describe("bootstrap Pi settings", () => {
	void it("preserves the ChatGPT installation identity but replaces preferences", async () => {
		const home = await mkdtemp(join(tmpdir(), "pi-config-settings-"));
		const agentDir = join(home, ".pi", "agent");
		const settingsPath = join(agentDir, "settings.json");

		try {
			const settings = SettingsManager.create(repoRoot, agentDir);
			const deviceId = settings.getOrCreateDeviceId();
			settings.setTheme("stale-theme");
			settings.setDefaultModelAndProvider("stale-provider", "stale-model");
			await settings.flush();

			await runBootstrap(home);
			const firstOutput = await readFile(settingsPath, "utf8");
			const repoSettings = JSON.parse(await readFile(join(repoRoot, "settings.json"), "utf8"));
			assert.deepEqual(JSON.parse(firstOutput), { ...repoSettings, deviceId });
			assert.equal(SettingsManager.create(repoRoot, agentDir).getOrCreateDeviceId(), deviceId);

			await runBootstrap(home);
			assert.equal(await readFile(settingsPath, "utf8"), firstOutput);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	void it.each(["not valid JSON", '{"deviceId":123}'])("replaces invalid existing settings: %s", async (existing) => {
		const home = await mkdtemp(join(tmpdir(), "pi-config-invalid-settings-"));
		const settingsPath = join(home, ".pi", "agent", "settings.json");

		try {
			await mkdir(dirname(settingsPath), { recursive: true });
			await writeFile(settingsPath, existing);
			await runBootstrap(home);
			assert.deepEqual(
				JSON.parse(await readFile(settingsPath, "utf8")),
				JSON.parse(await readFile(join(repoRoot, "settings.json"), "utf8")),
			);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

void describe("bootstrap opencode-go provider settings", () => {
	void it("reconciles native usage off and stays idempotent", async () => {
		const home = await mkdtemp(join(tmpdir(), "pi-config-opencode-go-"));

		try {
			await runBootstrap(home);

			const configPath = join(home, ".pi", "agent", "opencode-go-provider.json");
			const firstOutput = await readFile(configPath, "utf8");
			const parsed = JSON.parse(firstOutput) as { usage?: { enabled?: boolean } };

			assert.equal(parsed.usage?.enabled, false);

			await runBootstrap(home);
			assert.equal(await readFile(configPath, "utf8"), firstOutput);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
