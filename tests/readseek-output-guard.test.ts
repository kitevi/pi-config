import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { assert, describe, it } from "vitest";
import extension, { guardReadSeekOutput } from "../extensions/readseek-output-guard.ts";

type ToolResultEvent = {
	toolName: string;
	toolCallId: string;
	content: Array<{ type: string; text?: string }>;
	details?: Record<string, unknown>;
};

function createMockPi() {
	const handlers: Array<{ event: string; handler: (event: unknown) => unknown }> = [];
	return {
		on: (event: string, handler: (event: unknown) => unknown) => {
			handlers.push({ event, handler });
		},
		fireToolResult: (event: ToolResultEvent) => {
			for (const handler of handlers) {
				if (handler.event === "tool_result") {
					return handler.handler(event) as Record<string, unknown> | undefined;
				}
			}
			return undefined;
		},
	};
}

function guardOutputPath(result: Record<string, unknown>): string {
	const details = result.details as Record<string, unknown>;
	const guard = details.readSeekOutputGuard as { outputPath: string };
	return guard.outputPath;
}

void describe("readseek-output-guard", () => {
	void it("passes through guarded results under both limits", () => {
		const pi = createMockPi();
		extension(pi as never);

		const result = pi.fireToolResult({
			toolName: "read",
			toolCallId: "small-read",
			content: [{ type: "text", text: "small digest" }],
		});

		assert.strictEqual(result, undefined);
	});

	void it("guards a giant single-line digest envelope by byte count", () => {
		const text = JSON.stringify({
			schema: "readseek.digest",
			content: {
				line_count: 40_000,
				hashlines: [{ line: 1, hash: "abcdef", text: "x".repeat(20_000) }],
			},
		});
		const result = guardReadSeekOutput(text);
		assert.ok(result, "oversized single-line digest is guarded");

		try {
			assert.strictEqual(result.metadata.lineCount, 1);
			assert.strictEqual(result.metadata.byteCount, Buffer.byteLength(text, "utf8"));
			assert.ok(Buffer.byteLength(result.text, "utf8") < 3_000, "preview remains small");
			assert.match(result.text, /^\[ReadSeek context guard: preview\]/);
			assert.match(result.text, /\[truncated preview line: \d+ bytes total, showing 1024 bytes\]/);
			assert.ok(existsSync(result.metadata.outputPath), "full-output file exists");
			assert.strictEqual(readFileSync(result.metadata.outputPath, "utf8"), text);
		} finally {
			unlinkSync(result.metadata.outputPath);
		}
	});

	void it("guards every unbounded digest and discovery tool alias", () => {
		const guardedTools = [
			"read",
			"readSeek_digest",
			"readSeek_refs",
			"readSeek_search",
			"readSeek_def",
		];
		const oversized = "x".repeat(16_385);

		for (const toolName of guardedTools) {
			const pi = createMockPi();
			extension(pi as never);
			const result = pi.fireToolResult({
				toolName,
				toolCallId: `oversized-${toolName}`,
				content: [{ type: "text", text: oversized }],
			});
			assert.ok(result, `${toolName} output is guarded`);

			const outputPath = guardOutputPath(result);
			try {
				assert.strictEqual(readFileSync(outputPath, "utf8"), oversized);
			} finally {
				unlinkSync(outputPath);
			}
		}
	});

	void it("does not guard readseek tools whose visible output is already bounded", () => {
		const unguardedTools = ["readSeek_rename", "grep", "readSeek_view"];
		const oversized = "x".repeat(16_385);

		for (const toolName of unguardedTools) {
			const pi = createMockPi();
			extension(pi as never);
			const result = pi.fireToolResult({
				toolName,
				toolCallId: `ignored-${toolName}`,
				content: [{ type: "text", text: oversized }],
			});
			assert.strictEqual(result, undefined, `${toolName} remains outside the guard`);
		}
	});

	void it("preserves non-text content and existing details when rewriting", () => {
		const pi = createMockPi();
		extension(pi as never);
		const image = { type: "image", data: "abc" } as unknown as { type: string; text?: string };
		const result = pi.fireToolResult({
			toolName: "read",
			toolCallId: "digest-with-image",
			content: [{ type: "text", text: "x".repeat(16_385) }, image],
			details: { existing: "keep-me" },
		});
		assert.ok(result, "oversized read output is rewritten");

		const outputPath = guardOutputPath(result);
		try {
			const content = result.content as Array<{ type: string; text?: string }>;
			assert.match(content[0].text as string, /^\[ReadSeek context guard: preview\]/);
			assert.strictEqual(content[1], image, "non-text content is preserved verbatim");
			const details = result.details as Record<string, unknown>;
			assert.strictEqual(details.existing, "keep-me", "existing details are preserved");
		} finally {
			unlinkSync(outputPath);
		}
	});
});
