import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	DefaultResourceLoader,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, it } from "vitest";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

void describe("Pi runtime compatibility", () => {
	void it("loads every local extension while leaving tool orchestration to Fabric", async () => {
		const home = await mkdtemp(join(tmpdir(), "pi-config-runtime-"));

		try {
			const settings = JSON.parse(await readFile(join(repoRoot, "settings.json"), "utf8"));
			const extensionPaths = (await readdir(join(repoRoot, "extensions")))
				.filter((name) => name.endsWith(".ts"))
				.map((name) => join(repoRoot, "extensions", name));
			const loader = new DefaultResourceLoader({
				cwd: home,
				agentDir: home,
				settingsManager: SettingsManager.inMemory({ extensions: settings.extensions }),
				additionalExtensionPaths: extensionPaths,
				extensionFactories: [
					{ name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true },
					{ name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
					{ name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			await loader.reload();
			const loaded = loader.getExtensions();
			assert.deepEqual(loaded.errors, []);
			assert.deepEqual(loaded.extensions.map((extension) => extension.path).sort(), extensionPaths.sort());
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
