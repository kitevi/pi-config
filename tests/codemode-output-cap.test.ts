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

/** A return just past the cap. */
const OVER_CAP = CODEMODE_OUTPUT_MAX_CHARS + 1_000;
const HEADER = { type: "text" as const, text: "Script completed\nWall time 0.1 seconds\nOutput:\n" };
const RAISED_BUDGET = { code: '// @options: {"max_output_tokens": 20000}\ntext(value);' };

function textEvent(text: string, extra: Partial<CapEvent> = {}): CapEvent {
	return {
		toolName: "codemode",
		content: [{ type: "text", text }],
		...extra,
	};
}

function assertOmissionMarker(text: string, path: string, full: string, { range }: { range: boolean }): void {
	assert.ok(text.length <= CODEMODE_OUTPUT_MAX_CHARS);
	const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const marker = text.match(new RegExp(`(\\d+) characters omitted(?:, slice\\((\\d+), (\\d+)\\) of (\\d+))?\\. Full text: ${escapedPath}\\n`));
	assert.ok(marker, "the marker names the full text");
	assert.match(text, /Get what you still need in one call/);
	assert.match(text, /use tools\.bash to run node on the full text/);
	assert.match(text, /offsets are JavaScript string indices/);
	assert.match(text, /\/\/ @options: \{"max_output_tokens": N\}/);
	assert.match(text, /Do not rerun the original command/);
	assert.equal(text.includes("[Full output"), false);
	const markerStart = text.indexOf("\n\n... ");
	const tailStart = text.lastIndexOf("\n\n");
	assert.ok(markerStart >= 0);
	assert.ok(tailStart > markerStart);
	const head = text.slice(0, markerStart);
	const tail = text.slice(tailStart + 2);
	assert.equal(Number(marker[1]), full.length - head.length - tail.length);
	assert.ok(full.startsWith(head));
	assert.ok(full.endsWith(tail));
	if (range) {
		assert.deepEqual(marker.slice(2).map(Number), [head.length, full.length - tail.length, full.length]);
	} else {
		assert.equal(marker[2], undefined, "offsets are named only when they index the file");
	}
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
		readFile: overrides.readFile ?? ((path) => readFile(path, "utf8")),
		writeFile: async (text) => {
			writes.push(text);
			if (overrides.writeFile) return overrides.writeFile(text);
			return "/tmp/pi-codemode-cap-test.txt";
		},
	};
}

/** Enough image entries that their path annotations alone pass the budget. */
function imageEntries(): Array<{ image: { type: "image"; data: string; mimeType: string }; label: string }> {
	return Array.from({ length: Math.ceil(CODEMODE_OUTPUT_MAX_CHARS / 100) }, (_, index) => ({
		image: { type: "image" as const, data: String(index), mimeType: "image/png" },
		label: `[Image saved to /tmp/${"p".repeat(120)}/image-${index}.png (image/png, 1 B)]`,
	}));
}

void describe("capCodemodeText", () => {
	void it("keeps the start, the end, the path, and the omitted range inside the budget", () => {
		const full = `START${"x".repeat(CODEMODE_OUTPUT_MAX_CHARS * 2)}END`;
		const path = "/tmp/pi-codemode-cap-test.txt";
		const text = capCodemodeText(full, path);

		assert.ok(text.startsWith("START"));
		assert.ok(text.includes("END"));
		assertOmissionMarker(text, path, full, { range: true });
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
		const full = `START${"m".repeat(OVER_CAP)}END`;
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
		assertOmissionMarker(text.text, "/tmp/pi-codemode-cap-test.txt", full, { range: true });
		assert.deepEqual(result.details, { fullOutputPath: "/tmp/pi-codemode-cap-test.txt" });
	});

	void it("spills the output without Pi's header, so the named range indexes the file", async () => {
		const output = `START${"h".repeat(OVER_CAP)}END`;
		const files = io();
		const result = await applyCodemodeOutputCap({
			toolName: "codemode",
			content: [HEADER, { type: "text", text: output }],
		}, files);

		assert.deepEqual(files.writes, [output]);
		assert.ok(result);
		assert.deepEqual(result.content[0], HEADER);
		const body = result.content[1];
		assert.equal(body?.type, "text");
		if (body?.type !== "text") return;
		assertOmissionMarker(body.text, "/tmp/pi-codemode-cap-test.txt", output, { range: true });
	});

	void it("caps the delivered preview while reusing its existing full-output path", async () => {
		const preview = `HEAD${"q".repeat(OVER_CAP)}TAIL`;
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
		assertOmissionMarker(text.text, path, preview, { range: false });
		assert.equal(result.details, undefined);
	});

	void it("raises the cap to a larger max_output_tokens from the script's options line", async () => {
		const files = io();
		assert.equal(await applyCodemodeOutputCap(textEvent("f".repeat(80_000), { input: RAISED_BUDGET }), files), undefined);
		const result = await applyCodemodeOutputCap(textEvent("f".repeat(80_001), { input: RAISED_BUDGET }), files);

		assert.ok(result);
		const text = result.content[0];
		assert.equal(text?.type, "text");
		if (text?.type !== "text") return;
		assert.ok(text.text.length <= 80_000);
		assert.ok(text.text.length > CODEMODE_OUTPUT_MAX_CHARS);
	});

	void it("keeps the default cap when the options line asks for less", async () => {
		const files = io();
		const result = await applyCodemodeOutputCap(textEvent("g".repeat(CODEMODE_OUTPUT_MAX_CHARS), {
			input: { code: '// @options: {"max_output_tokens": 1000}\ntext(value);' },
		}), files);

		assert.equal(result, undefined);
		assert.deepEqual(files.writes, []);
	});

	void it("keeps image blocks", async () => {
		const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
		const files = io();
		const result = await applyCodemodeOutputCap({
			toolName: "codemode",
			content: [{ type: "text", text: "z".repeat(OVER_CAP) }, image],
		}, files);

		assert.ok(result);
		assert.deepEqual(result.content.filter((block) => block.type === "image"), [image]);
	});

	void it("keeps interleaved image paths beside their images and preserves the native header", async () => {
		const part = Math.ceil(CODEMODE_OUTPUT_MAX_CHARS / 2);
		const firstLabel = "[Image saved to /tmp/first.png (image/png, 1 B)]";
		const secondLabel = "[Image saved to /tmp/second.png (image/png, 1 B)]";
		const firstImage = { type: "image" as const, data: "first", mimeType: "image/png" };
		const secondImage = { type: "image" as const, data: "second", mimeType: "image/png" };
		const event: CapEvent = {
			toolName: "codemode",
			content: [
				HEADER,
				{ type: "text", text: `HEAD${"a".repeat(part)}\n${firstLabel}` },
				firstImage,
				{ type: "text", text: `MIDDLE${"b".repeat(part)}\n${secondLabel}` },
				secondImage,
				{ type: "text", text: `${"c".repeat(part)}TAIL` },
			],
		};
		const files = io();
		const result = await applyCodemodeOutputCap(event, files);

		assert.ok(result);
		const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		assert.ok(text.includes(firstLabel), "first image path must remain visible");
		assert.ok(text.includes(secondLabel), "second image path must remain visible");
		assert.ok(text.includes("HEAD"));
		assert.ok(text.includes("TAIL"));
		assert.ok(text.length <= CODEMODE_OUTPUT_MAX_CHARS);
		assert.match(text, /\d+ characters omitted\. Full text: /, "annotations between the texts shift the file's offsets");
		assert.deepEqual(result.content[0], HEADER);
		assert.deepEqual(result.content.filter((block) => block.type === "image"), [firstImage, secondImage]);
		for (const [image, label] of [[firstImage, firstLabel], [secondImage, secondLabel]] as const) {
			const imageIndex = result.content.indexOf(image);
			assert.ok(imageIndex > 0);
			const preceding = result.content.at(imageIndex - 1);
			assert.equal(preceding?.type, "text");
			if (preceding?.type === "text") assert.ok(preceding.text.endsWith(label));
		}
		assert.equal(files.writes[0], event.content.slice(1).filter((block) => block.type === "text").map((block) => block.text).join("\n"));
	});

	void it("keeps the recovery link when image annotations alone exceed the budget", async () => {
		const entries = imageEntries();
		const images = entries.map(({ image }) => image);
		const content: CapEvent["content"] = entries.flatMap(({ image, label }) => [
			{ type: "text", text: label }, image,
		]);
		const files = io();
		const result = await applyCodemodeOutputCap({ toolName: "codemode", content }, files);

		assert.ok(result);
		const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		assert.ok(text.length <= CODEMODE_OUTPUT_MAX_CHARS);
		assert.ok(text.includes("Full text: /tmp/pi-codemode-cap-test.txt"));
		assert.match(text, /Image annotations are in the full text, in image order/);
		assert.deepEqual(result.content.filter((block) => block.type === "image"), images);
		assert.equal(files.writes[0], entries.map(({ label }) => label).join("\n"));
	});

	for (const nativePath of [undefined, "/tmp/pi-codemode-native.txt"]) {
		void it(`reports unsaved image annotations when the spill fails ${nativePath ? "with" : "without"} a native path`, async () => {
			const content: CapEvent["content"] = imageEntries().flatMap(({ image, label }) => [
				{ type: "text" as const, text: label }, image,
			]);
			const files = io({
				readFile: async () => "native output without image paths",
				writeFile: async () => { throw new Error("disk full"); },
			});
			const result = await applyCodemodeOutputCap({
				toolName: "codemode", content,
				...(nativePath ? { details: { fullOutputPath: nativePath } } : {}),
			}, files);

			assert.ok(result);
			const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
			assert.ok(text.length <= CODEMODE_OUTPUT_MAX_CHARS);
			assert.match(text, /Could not save the full output: disk full/);
			assert.match(text, /Image annotations were omitted and could not be saved/);
			assert.equal(text.includes("Image annotations are in the full text"), false);
			assert.deepEqual(result.content.filter((block) => block.type === "image"), content.filter((block) => block.type === "image"));
		});
	}

	void it("ignores a non-codemode result", async () => {
		const files = io();
		const result = await applyCodemodeOutputCap({
			toolName: "bash",
			content: [{ type: "text", text: "b".repeat(OVER_CAP) }],
		}, files);

		assert.equal(result, undefined);
		assert.deepEqual(files.writes, []);
	});

	void it("ignores a nested codemode result", async () => {
		const files = io();
		const result = await applyCodemodeOutputCap(textEvent("c".repeat(OVER_CAP), {
			parentToolCallId: "parent",
		}), files);

		assert.equal(result, undefined);
		assert.deepEqual(files.writes, []);
	});

	for (const operation of ["read", "write"]) {
		void it(`keeps the native full-output link when the image spill ${operation} fails`, async () => {
			const nativePath = "/tmp/pi-codemode-native.txt";
			const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
			const files = io({
				readFile: async () => {
					if (operation === "read") throw new Error("read failed");
					return "complete native output";
				},
				writeFile: async () => {
					throw new Error("write failed");
				},
			});
			const result = await applyCodemodeOutputCap({
				toolName: "codemode",
				content: [{ type: "text", text: "x".repeat(OVER_CAP) }, image],
				details: { fullOutputPath: nativePath },
			}, files);

			assert.ok(result);
			const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
			assert.ok(text.includes(`Full text: ${nativePath}`));
			assert.ok(text.includes(`Could not save the full output: ${operation} failed`));
			assert.ok(text.length <= CODEMODE_OUTPUT_MAX_CHARS);
			assert.deepEqual(result.content.filter((block) => block.type === "image"), [image]);
		});
	}

	void it("returns structured content when it replaces the text", async () => {
		const files = io();
		const structuredContent = { ok: true };
		const result = await applyCodemodeOutputCap(textEvent("d".repeat(OVER_CAP), {
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

	void it("reads the script's options line from the tool input", async () => {
		const result = await codemodeResultHandler()(textEvent("h".repeat(OVER_CAP), { input: RAISED_BUDGET }));

		assert.equal(result, undefined);
	});

	void it("preserves the complete native output and image paths", async () => {
		const flag = "FLAG{complete_output_with_images}";
		const nativeText = `HEAD${"x".repeat(25_000)}${flag}${"x".repeat(25_000)}TAIL`;
		await withNativeSpill(nativeText, async (nativePath) => {
			const firstPath = "/tmp/pi-codemode-first.png";
			const secondPath = "/tmp/pi-codemode-second.png";
			const firstImage = { type: "image" as const, data: "first", mimeType: "image/png" };
			const secondImage = { type: "image" as const, data: "second", mimeType: "image/png" };
			const event: CapEvent = {
				toolName: "codemode",
				content: [
					HEADER,
					{ type: "text", text: `HEAD${"x".repeat(40_000)}TAIL\n\n[Full output: ${nativePath} (read with offset/limit)]\n[Image saved to ${firstPath} (image/png, 1 B)]` },
					firstImage,
					{ type: "text", text: `[Image saved to ${secondPath} (image/png, 1 B)]` },
					secondImage,
				],
				details: { fullOutputPath: nativePath, calls: [] },
			};
			const result = await codemodeResultHandler()(event);
			assert.ok(result);
			const savedPath = ((result.details ?? event.details) as { fullOutputPath: string }).fullOutputPath;
			try {
				const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
				assert.ok(text.includes(firstPath), "first image path must remain visible");
				assert.ok(text.includes(secondPath), "second image path must remain visible");
				assert.ok(text.length <= CODEMODE_OUTPUT_MAX_CHARS);
				assert.deepEqual(result.content.filter((block) => block.type === "image"), [firstImage, secondImage]);
				const saved = await readFile(savedPath, "utf8");
				assert.ok(saved.includes(flag), "the advertised full text must contain the omitted flag");
				assert.ok(saved.includes(nativeText), "the complete native output must be preserved");
				assert.equal(saved.includes("[Full output:"), false, "Pi's truncated preview is replaced by the native text");
				assert.equal(text.includes("[Full output:"), false);
				const omitted = Number(text.match(/(\d+) characters omitted/)?.[1]);
				assert.ok(omitted > nativeText.length - CODEMODE_OUTPUT_MAX_CHARS, "the count describes the native text, not Pi's preview");
				const range = text.match(/slice\((\d+), (\d+)\)/);
				assert.ok(range, "the native text starts the saved file, so the range indexes it");
				assert.ok(saved.slice(Number(range[1]), Number(range[2])).includes(flag), "the named slice holds the omitted flag");
				assert.ok(saved.includes(firstPath));
				assert.ok(saved.includes(secondPath));
				assert.equal(await readFile(nativePath, "utf8"), nativeText);
			} finally {
				if (savedPath !== nativePath) await rm(savedPath);
			}
		});
	});

	void it("cuts a text-only return from the native spill so the count describes that file", async () => {
		const nativeText = `HEAD${"x".repeat(60_000)}TAIL`;
		await withNativeSpill(nativeText, async (nativePath) => {
			const preview = `Warning: truncated output (original token count: 15002)\nTotal output lines: 1\n\nHEAD${"x".repeat(19_996)}…5001 tokens truncated…${"x".repeat(19_996)}TAIL\n\n[Full output: ${nativePath} (read with offset/limit)]`;
			const result = await codemodeResultHandler()(textEvent(preview, {
				content: [HEADER, { type: "text", text: preview }],
				details: { fullOutputPath: nativePath, calls: [] },
			}));

			assert.ok(result);
			assert.equal(result.details, undefined, "the native spill is reused");
			assert.deepEqual(result.content[0], HEADER);
			const body = result.content[1];
			assert.equal(body?.type, "text");
			if (body?.type !== "text") return;
			assert.equal(body.text.includes("tokens truncated"), false);
			assert.equal(body.text.includes("[Full output:"), false);
			assertOmissionMarker(body.text, nativePath, nativeText, { range: true });
		});
	});

	void it("keeps Pi's preview when the native spill cannot be read", async () => {
		const nativePath = "/tmp/pi-codemode-missing.txt";
		const preview = `Warning: truncated output\n\nHEAD${"x".repeat(40_000)}TAIL\n\n[Full output: ${nativePath} (read with offset/limit)]`;
		const files = io({ readFile: async () => { throw new Error("gone"); } });
		const result = await applyCodemodeOutputCap(textEvent(preview, {
			details: { fullOutputPath: nativePath },
		}), files);

		assert.ok(result);
		assert.deepEqual(files.writes, []);
		const text = result.content[0];
		assert.equal(text?.type, "text");
		if (text?.type !== "text") return;
		assert.ok(text.text.length <= CODEMODE_OUTPUT_MAX_CHARS);
		assert.ok(text.text.startsWith("Warning: truncated output\n\nHEAD"));
		assert.ok(text.text.includes(`characters omitted. Full text: ${nativePath}`));
	});

	void it("caps a codemode tool result", async () => {
		const full = "e".repeat(OVER_CAP);
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
