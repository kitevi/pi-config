import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import plugin, {
	applyCodemodeOutputCap,
	capCodemodeText,
	CODEMODE_OUTPUT_MAX_CHARS,
	type CapEvent,
	type CapIo,
	type CapResult,
} from "../extensions/codemode-output-cap.ts";

function textEvent(text: string, extra: Partial<CapEvent> = {}): CapEvent {
	return {
		toolName: "codemode",
		content: [{ type: "text", text }],
		...extra,
	};
}

function assertOmissionMarker(text: string, path: string, full: string): void {
	assert.ok(text.length <= CODEMODE_OUTPUT_MAX_CHARS);
	const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	assert.match(text, new RegExp(`characters omitted\\. Full text: ${escapedPath}`));
	assert.match(text, /Read it with tools\.read, about 80 lines at a time, or search it/);
	assert.match(text, /text\(\) of the whole file is cut again/);
	assert.match(text, /Do not re-run the command/);
	assert.equal(text.includes("[Full output"), false);
	const markerStart = text.indexOf("\n\n... ");
	const tailStart = text.lastIndexOf("\n\n");
	assert.ok(markerStart >= 0);
	assert.ok(tailStart > markerStart);
	const head = text.slice(0, markerStart);
	const tail = text.slice(tailStart + 2);
	const omitted = Number(text.match(/(\d+) characters omitted/)?.[1]);
	assert.equal(omitted, full.length - head.length - tail.length);
	assert.ok(full.startsWith(head));
	assert.ok(full.endsWith(tail));
}

function codemodeResultHandler(): (event: CapEvent) => Promise<CapResult | undefined> {
	const handlers: Array<(event: CapEvent) => Promise<CapResult | undefined>> = [];
	plugin({
		on: (_event: string, handler: (event: CapEvent) => Promise<CapResult | undefined>) => {
			handlers.push(handler);
		},
	} as never);
	const handler = handlers[0];
	assert.ok(handler);
	return handler;
}

async function withNativeSpill(fullText: string, test: (path: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-codemode-cap-test-"));
	try {
		const path = join(directory, "native-spill.txt");
		await writeFile(path, fullText, { mode: 0o600 });
		await test(path);
	} finally {
		await rm(directory, { recursive: true });
	}
}

function io(overrides: Partial<CapIo> = {}): CapIo & { writes: string[] } {
	const writes: string[] = [];
	return {
		writes,
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

		assert.ok(text.startsWith("START"));
		assert.ok(text.includes("END"));
		assertOmissionMarker(text, path, full);
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
		assert.ok(text.text.includes("START"));
		assert.ok(text.text.includes("END"));
		assertOmissionMarker(text.text, "/tmp/pi-codemode-cap-test.txt", full);
		assert.deepEqual(result.details, { fullOutputPath: "/tmp/pi-codemode-cap-test.txt" });
	});

	void it("caps the delivered preview while reusing its existing full-output path", async () => {
		const preview = `HEAD${"q".repeat(15_000)}TAIL`;
		const path = "/tmp/pi-codemode-existing.txt";
		const files = io();
		const result = await applyCodemodeOutputCap(textEvent(preview, {
			details: { fullOutputPath: path, calls: [] },
		}), files);

		assert.deepEqual(files.writes, []);
		assert.ok(result);
		const text = result.content.find((block) => block.type === "text");
		assert.equal(text?.type, "text");
		if (text?.type !== "text") return;
		assert.ok(text.text.startsWith("HEAD"));
		assert.ok(text.text.includes("TAIL"));
		assertOmissionMarker(text.text, path, preview);
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
	void it("does not expand a preview produced by a smaller per-script budget", async () => {
		await withNativeSpill("x".repeat(20_000), async (path) => {
			const preview = `Script completed\nWall time 0.1 seconds\nOutput:\nWarning: truncated output\n${"x".repeat(400)}\n[Full output: ${path} (read with offset/limit)]`;
			const result = await codemodeResultHandler()(textEvent(preview, {
				details: { fullOutputPath: path, calls: [] },
			}));

			assert.equal(result, undefined);
		});
	});

	void it("preserves image paths added after Pi writes its text spill", async () => {
		await withNativeSpill(`HEAD${"x".repeat(50_000)}TAIL`, async (nativePath) => {
			const firstPath = "/tmp/pi-codemode-first.png";
			const secondPath = "/tmp/pi-codemode-second.png";
			const firstImage = { type: "image" as const, data: "first", mimeType: "image/png" };
			const secondImage = { type: "image" as const, data: "second", mimeType: "image/png" };
			const event: CapEvent = {
				toolName: "codemode",
				content: [
					{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
					{ type: "text", text: `HEAD${"x".repeat(20_000)}TAIL\n\n[Full output: ${nativePath} (read with offset/limit)]\n[Image saved to ${firstPath} (image/png, 1 B)]` },
					firstImage,
					{ type: "text", text: `[Image saved to ${secondPath} (image/png, 1 B)]` },
					secondImage,
				],
				details: { fullOutputPath: nativePath, calls: [] },
			};
			const fullReturn = event.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
			const result = await codemodeResultHandler()(event);
			assert.ok(result);
			const savedPath = ((result.details ?? event.details) as { fullOutputPath: string }).fullOutputPath;
			try {
				const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
				assert.ok(text.includes(firstPath), "first image path must remain visible");
				assert.ok(text.includes(secondPath), "second image path must remain visible");
				assert.ok(text.length <= CODEMODE_OUTPUT_MAX_CHARS);
				assert.deepEqual(result.content.filter((block) => block.type === "image"), [firstImage, secondImage]);
				assert.equal(await readFile(savedPath, "utf8"), fullReturn);
				assert.equal(await readFile(nativePath, "utf8"), `HEAD${"x".repeat(50_000)}TAIL`);
			} finally {
				if (savedPath !== nativePath) await rm(savedPath);
			}
		});
	});

	void it("caps a codemode tool result", async () => {
		const full = "e".repeat(11_000);
		const event = textEvent(full);
		const result = await codemodeResultHandler()(event);
		assert.ok(result);
		const path = (result.details as { fullOutputPath: string }).fullOutputPath;
		try {
			assert.equal(await readFile(path, "utf8"), full);
			assert.equal(result.content[0]?.type, "text");
			if (result.content[0]?.type === "text") assert.ok(result.content[0].text.length <= CODEMODE_OUTPUT_MAX_CHARS);
		} finally {
			await rm(path);
		}
	});
});
