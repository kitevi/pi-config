import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, lstat, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const bootstrapPath = join(repoRoot, "bootstrap.mjs");

function bootstrapEnv(home: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		HOME: home,
		USERPROFILE: home,
	};
}

async function runBootstrap(home: string): Promise<void> {
	await execFileAsync(process.execPath, [bootstrapPath], {
		cwd: repoRoot,
		env: bootstrapEnv(home),
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

void describe("bootstrap extension links", () => {
	void it("prunes repo-owned links that lost their source and keeps undeclared runtime files", async () => {
		const home = await mkdtemp(join(tmpdir(), "pi-config-extensions-"));
		const extensionsDir = join(home, ".pi", "agent", "extensions");
		const staleLink = join(extensionsDir, "removed-extension.ts");
		const runtimeConfig = join(extensionsDir, "pi-model-sort.json");

		try {
			await mkdir(extensionsDir, { recursive: true });
			await symlink(join(repoRoot, "extensions", "removed-extension.ts"), staleLink);
			await writeFile(runtimeConfig, '{"lastUsed":{}}\n');

			await runBootstrap(home);

			await assert.rejects(lstat(staleLink), { code: "ENOENT" });
			assert.equal(await readFile(runtimeConfig, "utf8"), '{"lastUsed":{}}\n');
			assert.equal((await lstat(join(extensionsDir, "git-editor-guard.ts"))).isSymbolicLink(), true);
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

void describe("bootstrap MCP config", () => {
	void it("installs native mcp.json and leaves an undeclared mcporter file", async () => {
		const home = await mkdtemp(join(tmpdir(), "pi-config-mcp-"));
		const agentDir = join(home, ".pi", "agent");
		const mcporterPath = join(home, ".mcporter", "mcporter.json");

		try {
			await mkdir(dirname(mcporterPath), { recursive: true });
			await writeFile(mcporterPath, "{\"kept\":true}\n");

			await runBootstrap(home);

			const installed = JSON.parse(await readFile(join(agentDir, "mcp.json"), "utf8")) as {
				mcpServers?: { context7?: { url?: string } };
			};
			assert.equal(installed.mcpServers?.context7?.url, "https://mcp.context7.com/mcp");
			assert.equal(await readFile(mcporterPath, "utf8"), "{\"kept\":true}\n");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

void describe("bootstrap pi-vcc settings", () => {
	void it("compacts after 90 percent of the context window", async () => {
		const home = await mkdtemp(join(tmpdir(), "pi-config-vcc-"));

		try {
			await runBootstrap(home);

			const configPath = join(home, ".pi", "agent", "pi-vcc-config.json");
			const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
				overrideDefaultCompaction?: boolean;
				globalThreshold?: { compactPercent?: number };
			};

			assert.equal(parsed.overrideDefaultCompaction, true);
			assert.equal(parsed.globalThreshold?.compactPercent, 90);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

void describe("bootstrap model config", () => {
	void it("installs models.json declaring the open-design provider", async () => {
		const home = await mkdtemp(join(tmpdir(), "pi-config-models-"));

		try {
			await runBootstrap(home);

			const installed = JSON.parse(await readFile(join(home, ".pi", "agent", "models.json"), "utf8")) as {
				providers?: Record<
					string,
					{ baseUrl?: string; api?: string; apiKey?: string; models?: { id?: string }[] }
				>;
			};
			const provider = installed.providers?.["open-design"];

			assert.equal(provider?.baseUrl, "https://amr-link.open-design.ai/v1");
			assert.equal(provider?.api, "openai-completions");
			assert.match(provider?.apiKey ?? "", /^\$\{OPEN_DESIGN_API_KEY\}$/);
			assert.equal(provider?.models?.[0]?.id, "deepseek-v4.1-flash");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

void describe("bootstrap managed writes", () => {
	void it("writes the declared settings and leaves no temporary siblings", async () => {
		const home = await mkdtemp(join(tmpdir(), "pi-config-atomic-"));

		try {
			await runBootstrap(home);

			const agentDir = join(home, ".pi", "agent");
			const repo = JSON.parse(await readFile(join(repoRoot, "settings.json"), "utf8"));
			const installed = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));

			assert.deepEqual(installed, repo);
			assert.deepEqual((await readdir(agentDir)).filter((name) => name.endsWith(".tmp")), []);
			assert.deepEqual((await readdir(join(agentDir, "extensions"))).filter((name) => name.endsWith(".tmp")), []);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
