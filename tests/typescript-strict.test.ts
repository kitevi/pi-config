import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const typeScriptDirectories = ["extensions", "reminders", "tests"];

const commonArgs = [
	"--noEmit",
	"--strict",
	"--allowImportingTsExtensions",
	"--skipLibCheck",
	"--module",
	"NodeNext",
	"--moduleResolution",
	"NodeNext",
	"--target",
	"ES2023",
];

const strictArgs = [
	...commonArgs,
	"--noUncheckedIndexedAccess",
	"--exactOptionalPropertyTypes",
	"--noImplicitOverride",
	"--noImplicitReturns",
	"--noFallthroughCasesInSwitch",
	"--noPropertyAccessFromIndexSignature",
];

const typeScriptFiles = async (directory: string): Promise<string[]> => {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = await Promise.all(
		entries.map((entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return typeScriptFiles(path);
			return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
		}),
	);
	return files.flat();
};

void describe("repository TypeScript", () => {
	const check = async (files: string[], args: string[]) => {
		try {
			const result = await execFileAsync("npx", ["tsc", ...args, ...files], {
				cwd: repoRoot,
				timeout: 60_000,
				maxBuffer: 10 * 1024 * 1024,
			});
			assert.strictEqual(result.stdout, "");
			assert.strictEqual(result.stderr, "");
		} catch (error) {
			const failure = error as { stdout?: string; stderr?: string };
			assert.fail([failure.stdout, failure.stderr].filter(Boolean).join("\n"));
		}
	};

	void it("compiles every repository TypeScript file", async () => {
		const files = (
			await Promise.all(typeScriptDirectories.map((directory) => typeScriptFiles(join(repoRoot, directory))))
		)
			.flat()
			.filter((path) => !path.includes(`${join(repoRoot, "node_modules")}/`))
			.map((path) => relative(repoRoot, path))
			.sort();

		assert.ok(files.length > 0, "expected the strict typecheck to include repository TypeScript files");
		await check(files, strictArgs);
	});
});
