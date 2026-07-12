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

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function loadSettings(): Settings {
	return JSON.parse(readFileSync(join(repoRoot, "settings.json"), "utf8")) as Settings;
}

void describe("pi-synthetic package filter", () => {
	void it("loads the provider from its current package entrypoint", () => {
		const synthetic = loadSettings().packages.find(
			(entry): entry is PackageFilter =>
				typeof entry !== "string" && entry.source === "npm:@aliou/pi-synthetic",
		);

		assert.ok(synthetic, "Expected an @aliou/pi-synthetic package entry");
		assert.deepStrictEqual(synthetic.extensions, ["extensions/provider/index.ts"]);
	});
});
