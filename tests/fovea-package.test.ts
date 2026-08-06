import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, describe, it } from "vitest";

interface Settings {
	packages: Array<string | { source: string }>;
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function readJson(name: string): unknown {
	return JSON.parse(readFileSync(join(repoRoot, name), "utf8")) as unknown;
}

void describe("pi-fovea package", () => {
	void it("loads the published extension and skill package", () => {
		const settings = readJson("settings.json") as Settings;
		const source = settings.packages.find((entry) =>
			typeof entry === "string" ? entry === "npm:pi-fovea" : entry.source === "npm:pi-fovea",
		);

		assert.ok(source, "Expected an npm:pi-fovea package entry");
	});

	void it("tracks every supported global option", () => {
		assert.deepStrictEqual(readJson("fovea.json"), {
			sync: {
				enabled: false,
				budget: 128,
				ackClean: false,
				warmFileThreshold: 16,
			},
			tools: {
				defaultBudget: 512,
				replaceGrep: true,
			},
		});
	});
});
