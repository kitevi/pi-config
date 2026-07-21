import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

interface PackageFilter {
	source: string;
	extensions?: string[];
}

interface Settings {
	packages: Array<string | PackageFilter>;
}

interface SyntheticConfig {
	quotasCommand?: boolean;
	usageStatus?: boolean;
	quotaWarnings?: boolean;
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function loadSettings(): Settings {
	return JSON.parse(readFileSync(join(repoRoot, "settings.json"), "utf8")) as Settings;
}

function loadSyntheticConfig(): SyntheticConfig {
	return JSON.parse(readFileSync(join(repoRoot, "synthetic.json"), "utf8")) as SyntheticConfig;
}

void describe("provider quota packages", () => {
	void it("loads Synthetic's provider and response-header-backed usage status", () => {
		const synthetic = loadSettings().packages.find(
			(entry): entry is PackageFilter =>
				typeof entry !== "string" && entry.source === "npm:@aliou/pi-synthetic",
		);

		assert.ok(synthetic, "Expected an @aliou/pi-synthetic package entry");
		assert.deepStrictEqual(synthetic.extensions, [
			"extensions/provider/index.ts",
			"extensions/usage-status/index.ts",
		]);
	});

	void it("keeps Synthetic's direct quota command disabled until it drops AuthStorage", () => {
		const config = loadSyntheticConfig();
		assert.equal(config.usageStatus, true);
		assert.equal(config.quotasCommand, false);
		assert.equal(config.quotaWarnings, false);
	});
});
