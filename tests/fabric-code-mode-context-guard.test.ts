import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import extension, {
	createFabricCodeModeContextGuard,
	persistFabricOutput,
} from "../extensions/fabric-code-mode-context-guard.ts";

const limits = {
	maxLines: 80,
	maxBytes: 6144,
	headLines: 12,
	tailLines: 35,
};

function createMockPi() {
	const handlers: Array<(event: never) => unknown> = [];
	return {
		pi: {
			on: (name: string, handler: (event: never) => unknown) => {
				if (name === "tool_result") handlers.push(handler);
			},
		},
		fire: async (event: unknown) => {
			let patch: Record<string, unknown> | undefined;
			for (const handler of handlers) {
				const next = await handler(event as never) as Record<string, unknown> | undefined;
				if (next) patch = { ...patch, ...next };
			}
			return patch;
		},
	};
}

void describe("Fabric code-mode context guard", () => {
	void it("ignores ten nested bash results and guards their final fabric_exec aggregate once", async () => {
		const persisted: string[] = [];
		const guard = createFabricCodeModeContextGuard({
			limits,
			persist: async (text) => {
				persisted.push(text);
				return "/tmp/fabric-code-mode-context-guard-test.txt";
			},
		});
		const commandOutput = Array.from(
			{ length: 2_000 },
			(_, index) => `command-line-${index}`,
		).join("\n");

		for (let index = 0; index < 10; index += 1) {
			const patch = await guard({
				toolName: "bash",
				content: [{ type: "text", text: commandOutput }],
			});
			assert.strictEqual(patch, undefined);
		}
		assert.deepStrictEqual(persisted, []);

		const aggregate = Array.from(
			{ length: 10 },
			(_, index) => `command-${index}\n${commandOutput}`,
		).join("\n");
		const patch = await guard({
			toolName: "fabric_exec",
			content: [{ type: "text", text: aggregate }],
		});
		const preview = patch?.content?.find((block) => block.type === "text")?.text ?? "";

		assert.deepStrictEqual(persisted, [aggregate]);
		assert.ok(preview.includes("Fabric code-mode context guard"));
		assert.ok(Buffer.byteLength(preview, "utf8") <= limits.maxBytes);
		assert.ok(preview.split("\n").length <= limits.maxLines);
	});

	void it("persists exact output in a private file", async () => {
		const text = "é".repeat(7_000);
		const path = await persistFabricOutput(text);
		try {
			assert.strictEqual(await readFile(path, "utf8"), text);
			assert.strictEqual((await stat(path)).mode & 0o777, 0o600);
		} finally {
			await rm(path, { force: true });
		}
	});

	void it("loads the single limit set and preserves the original error state", async () => {
		const directory = await mkdtemp(join(tmpdir(), "fabric-code-mode-context-guard-"));
		const configPath = join(directory, "guard.json");
		await writeFile(configPath, JSON.stringify(limits));
		const previous = process.env.PI_FABRIC_CODE_MODE_CONTEXT_GUARD_CONFIG;
		process.env.PI_FABRIC_CODE_MODE_CONTEXT_GUARD_CONFIG = configPath;
		let outputPath: string | undefined;

		try {
			const mock = createMockPi();
			await extension(mock.pi as never);
			const patch = await mock.fire({
				toolName: "fabric_exec",
				toolCallId: "outer-call",
				input: { code: "return largeValue" },
				content: [{ type: "text", text: "x".repeat(7_000) }],
				details: undefined,
				isError: true,
			});
			const content = patch?.content as Array<{ type: string; text?: string }> | undefined;
			const preview = content?.find((block) => block.type === "text")?.text ?? "";
			const pathMatch = preview.match(/\[Full output: (.+)\]/);
			assert.ok(pathMatch?.[1]);
			outputPath = JSON.parse(pathMatch[1]) as string;
			assert.strictEqual(patch?.isError, undefined);
		} finally {
			if (previous === undefined) delete process.env.PI_FABRIC_CODE_MODE_CONTEXT_GUARD_CONFIG;
			else process.env.PI_FABRIC_CODE_MODE_CONTEXT_GUARD_CONFIG = previous;
			if (outputPath) await rm(outputPath, { force: true });
			await rm(directory, { recursive: true, force: true });
		}
	});
});
