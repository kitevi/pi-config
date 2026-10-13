import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import plugin, {
	applyCodemodeOutputCap,
	capCodemodeText,
	CODEMODE_OUTPUT_MAX_CHARS,
	type CapEvent,
	type CapIo,
} from "../extensions/codemode-output-cap.ts";

function textEvent(text: string, extra: Partial<CapEvent> = {}): CapEvent {
	return {
		toolName: "codemode",
		content: [{ type: "text", text }],
		...extra,
	};
}

function io(overrides: Partial<CapIo> = {}): CapIo & { writes: string[]; reads: string[] } {
	const writes: string[] = [];
	const reads: string[] = [];
	return {
		writes,
		reads,
		readFile: async (path) => {
			reads.push(path);
			if (overrides.readFile) return overrides.readFile(path);
			throw new Error(`unexpected read ${path}`);
		},
		writeFile: async (text) => {
			writes.push(text);
			if (overrides.writeFile) return overrides.writeFile(text);
			return "/tmp/pi-codemode-cap-test.txt";
		},
	};
}

void describe("capCodemodeText", () => {
	void it("keeps the start, the end, and the path inside the budget", () => {
		const full = `START${"x".repeat(20_000)}END`;
		const path = "/tmp/pi-codemode-cap-test.txt";
		const text = capCodemodeText(full, path);

		assert.ok(text.length <= CODEMODE_OUTPUT_MAX_CHARS);
		assert.ok(text.startsWith("START"));
		assert.ok(text.includes("END"));
		assert.ok(text.includes(path));
		assert.match(text, /characters omitted/);
	});
});

void describe("applyCodemodeOutputCap", () => {
	void it("leaves a return at the budget unchanged and writes no file", async () => {
		const files = io();
		const event = textEvent("a".repeat(CODEMODE_OUTPUT_MAX_CHARS));

		assert.equal(await applyCodemodeOutputCap(event, files), undefined);
		assert.deepEqual(files.writes, []);
	});

	void it("writes one file and middle-cuts a longer return", async () => {
		const full = `START${"m".repeat(12_000)}END`;
		const files = io();
		const result = await applyCodemodeOutputCap(textEvent(full), files);

		assert.equal(files.writes.length, 1);
		assert.equal(files.writes[0], full);
		assert.ok(result);
		const text = result.content.find((block) => block.type === "text");
		assert.equal(text?.type, "text");
		if (text?.type !== "text") return;
		assert.ok(text.text.length <= CODEMODE_OUTPUT_MAX_CHARS);
		assert.ok(text.text.includes("START"));
		assert.ok(text.text.includes("END"));
		assert.ok(text.text.includes("/tmp/pi-codemode-cap-test.txt"));
		assert.deepEqual(result.details, { fullOutputPath: "/tmp/pi-codemode-cap-test.txt" });
	});

	void it("reuses an existing full-output path", async () => {
		const preview = "truncated preview";
		const full = `HEAD${"q".repeat(15_000)}TAIL`;
		const path = "/tmp/pi-codemode-existing.txt";
		const files = io({
			readFile: async () => full,
		});
		const result = await applyCodemodeOutputCap(textEvent(preview, {
			details: { fullOutputPath: path, calls: [] },
		}), files);

		assert.deepEqual(files.reads, [path]);
		assert.deepEqual(files.writes, []);
		assert.ok(result);
		const text = result.content.find((block) => block.type === "text");
		assert.equal(text?.type, "text");
		if (text?.type !== "text") return;
		assert.ok(text.text.length <= CODEMODE_OUTPUT_MAX_CHARS);
		assert.ok(text.text.startsWith("HEAD"));
		assert.ok(text.text.includes("TAIL"));
		assert.ok(text.text.includes(path));
		assert.equal(text.text.includes(preview), false);
		assert.equal(result.details, undefined);
	});

	void it("keeps image blocks", async () => {
		const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
		const files = io();
		const result = await applyCodemodeOutputCap({
			toolName: "codemode",
			content: [{ type: "text", text: "z".repeat(11_000) }, image],
		}, files);

		assert.ok(result);
		assert.deepEqual(result.content.filter((block) => block.type === "image"), [image]);
	});

	void it("ignores a non-codemode result", async () => {
		const files = io();
		const result = await applyCodemodeOutputCap({
			toolName: "bash",
			content: [{ type: "text", text: "b".repeat(11_000) }],
		}, files);

		assert.equal(result, undefined);
		assert.deepEqual(files.writes, []);
	});

	void it("ignores a nested codemode result", async () => {
		const files = io();
		const result = await applyCodemodeOutputCap(textEvent("c".repeat(11_000), {
			parentToolCallId: "parent",
		}), files);

		assert.equal(result, undefined);
		assert.deepEqual(files.writes, []);
	});

	void it("returns structured content when it replaces the text", async () => {
		const files = io();
		const structuredContent = { ok: true };
		const result = await applyCodemodeOutputCap(textEvent("d".repeat(11_000), {
			structuredContent,
		}), files);

		assert.equal(result?.structuredContent, structuredContent);
	});
});

void describe("codemode-output-cap extension", () => {
	void it("caps a codemode tool result", async () => {
		const handlers: Array<(event: CapEvent) => Promise<unknown>> = [];
		plugin({
			on: (_event: string, handler: (event: CapEvent) => Promise<unknown>) => {
				handlers.push(handler);
			},
		} as never);

		const event = textEvent("e".repeat(11_000));
		const result = await handlers[0]?.(event);
		assert.ok(result);
	});
});
