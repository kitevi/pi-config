import { describe, it } from "vitest";
import { assert } from "vitest";
import extension, { guardBashOutput } from "../extensions/bash-context-guard.ts";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ToolResultEvent = {
	toolName: string;
	toolCallId: string;
	input?: Record<string, unknown>;
	content: Array<{ type: string; text?: string }>;
	details?: Record<string, unknown>;
	isError?: boolean;
};

function createMockPi() {
	const handlers: Array<{ event: string; handler: (e: unknown) => unknown }> = [];
	return {
		on: (event: string, handler: (e: unknown) => unknown) => {
			handlers.push({ event, handler });
		},
		fireToolResult: (event: ToolResultEvent) => {
			for (const h of handlers) {
				if (h.event === "tool_result") return h.handler(event) as Record<string, unknown> | undefined;
			}
			return undefined;
		},
	};
}
void describe("guardBashOutput", () => {
	void it("passes through results under both limits untouched", () => {
		const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
		assert.strictEqual(guardBashOutput({ text }), undefined);
	});

	void it("trims over the line limit, writes full output to a temp file", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
		const text = lines.join("\n");
		const result = guardBashOutput({ text });
		assert.ok(result, "oversized output is guarded");

		assert.strictEqual(result.metadata.trimmed, true);
		assert.strictEqual(result.metadata.outputPathSource, "guard");
		assert.strictEqual(result.metadata.lineCount, 200);

		const preview = result.text;
		assert.match(preview, /^\[Bash context guard: preview\]/);
		assert.match(preview, /\nFull output: \//);
		assert.match(preview, /\[End Bash context guard preview\]$/);
		assert.ok(preview.includes("line 1\n"), "head includes first line");
		assert.ok(preview.includes("line 12\n"), "head includes line 12");
		assert.ok(!preview.includes("line 100"), "middle omitted");
		assert.ok(preview.includes("line 200"), "tail includes last line");
		assert.match(preview, /\.\.\. omitted 153 lines \/ \d+ bytes \.\.\./);

		const outputPath = result.metadata.outputPath;
		assert.ok(outputPath, "outputPath set");
		assert.ok(existsSync(outputPath), "temp file exists");
		assert.strictEqual(readFileSync(outputPath, "utf8"), text);
		unlinkSync(outputPath);
	});

	void it("previews the complete output from pi's fullOutputPath when pi truncated", () => {
		// pi truncated a 10,000-line log: result text is pi's preview, the raw
		// bytes live in pi's file. The guard must preview/count from THAT file
		// and point at it — pi's mid-tier text is discarded, no second copy.
		const fullLines = Array.from({ length: 10_000 }, (_, i) => `raw ${i + 1}`);
		const piFile = join(
			tmpdir(),
			`pi-bash-context-guard-test-pi-${randomUUID()}.txt`,
		);
		writeFileSync(piFile, fullLines.join("\n"));
		try {
			const piPreview = Array.from({ length: 100 }, (_, i) => `pi preview ${i + 1}`).join("\n");
			const result = guardBashOutput({ text: piPreview, fullOutputPath: piFile });
			assert.ok(result, "pi's full output is guarded");

			assert.strictEqual(result.metadata.trimmed, true);
			assert.strictEqual(result.metadata.outputPath, piFile);
			assert.strictEqual(result.metadata.outputPathSource, "pi");
			assert.strictEqual(result.metadata.lineCount, 10_000);

			const preview = result.text;
			assert.ok(preview.includes(`Full output: ${piFile}`));
			assert.ok(preview.includes("raw 1\n"), "head from raw file");
			assert.ok(preview.includes("raw 10000"), "tail from raw file");
			assert.ok(!preview.includes("pi preview"), "pi's mid-tier text discarded");
			assert.match(preview, /\.\.\. omitted 9953 lines \/ \d+ bytes \.\.\./);
		} finally {
			unlinkSync(piFile);
		}
	});

	void it("fails open when pi's fullOutputPath is unreadable", () => {
		const text = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
		const missing = join(tmpdir(), `pi-bash-context-guard-missing-${randomUUID()}.txt`);
		assert.strictEqual(
			guardBashOutput({ text, fullOutputPath: missing }),
			undefined,
		);
	});

	void it("trims over the byte limit even when lines fit, head/tail overlap", () => {
		// 10 lines x 1,000 chars = ~10KB > MAX_BYTES, but 10 lines < HEAD+TAIL.
		const lines = Array.from({ length: 10 }, (_, i) => `${i}:${"x".repeat(1000)}`);
		const text = lines.join("\n");
		const result = guardBashOutput({ text });
		assert.ok(result, "byte-heavy output is guarded");

		assert.strictEqual(result.metadata.trimmed, true);
		assert.strictEqual(result.metadata.lineCount, 10);
		assert.ok(!result.text.includes("omitted"), "no omitted line when nothing omitted");
		for (let i = 0; i < 10; i++) {
			assert.ok(result.text.includes(`${i}:${"x".repeat(1000)}`), `line ${i} present`);
		}
		unlinkSync(result.metadata.outputPath);
	});

	void it("caps huge lines in the preview while preserving full output on disk", () => {
		const text = "x".repeat(10_000);
		const result = guardBashOutput({ text });
		assert.ok(result, "huge line is guarded");
		const outputPath = result.metadata.outputPath;
		assert.ok(outputPath, "outputPath set");

		try {
			assert.strictEqual(result.metadata.trimmed, true);
			assert.ok(
				Buffer.byteLength(result.text, "utf8") < 2_000,
				"single-line preview stays small",
			);
			assert.match(
				result.text,
				/\[truncated preview line: 10000 bytes total, showing 1024 bytes\]/,
			);
			assert.strictEqual(readFileSync(outputPath, "utf8"), text);
		} finally {
			unlinkSync(outputPath);
		}
	});

	void it("sanitizes only the preview and preserves the full output verbatim", () => {
		const text = [
			"\u001b[31mred\u001b[0m\r",
			"phase 1\rphase 2",
			"\u001b]8;;https://example.com\u0007linked label\u001b]8;;\u0007",
			...Array.from({ length: 100 }, (_, i) => `line ${i + 1}`),
		].join("\n");
		const result = guardBashOutput({ text });
		assert.ok(result, "control-code-heavy output is guarded");

		try {
			assert.ok(!result.text.includes("\u001b"), "ANSI escapes removed from preview");
			assert.ok(!result.text.includes("\r"), "carriage returns removed from preview");
			assert.ok(result.text.includes("red\nphase 1\nphase 2\nlinked label"));
			assert.ok(!result.text.includes("https://example.com"), "OSC metadata removed from preview");
			assert.strictEqual(
				readFileSync(result.metadata.outputPath, "utf8"),
				text,
				"full-output file remains the untouched source of truth",
			);
		} finally {
			unlinkSync(result.metadata.outputPath);
		}
	});

	void it("honors exact threshold boundaries and empty input", () => {
		const at80 = Array.from({ length: 80 }, () => "x").join("\n");
		assert.strictEqual(guardBashOutput({ text: at80 }), undefined);

		const at81 = Array.from({ length: 81 }, () => "x").join("\n");
		const trimmed = guardBashOutput({ text: at81 });
		assert.ok(trimmed, "81 lines exceeds the limit");
		unlinkSync(trimmed.metadata.outputPath);

		const at6144 = "x".repeat(6144);
		assert.strictEqual(guardBashOutput({ text: at6144 }), undefined);

		const at6145 = "x".repeat(6145);
		const trimmedBytes = guardBashOutput({ text: at6145 });
		assert.ok(trimmedBytes, "6,145 bytes exceeds the limit");
		unlinkSync(trimmedBytes.metadata.outputPath);

		assert.strictEqual(guardBashOutput({ text: "" }), undefined);
	});

	void it("hook ignores non-bash tools", () => {
		const pi = createMockPi();
		extension(pi as never);
		const big = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
		const result = pi.fireToolResult({
			toolName: "read",
			toolCallId: "1",
			content: [{ type: "text", text: big }],
		});
		assert.strictEqual(result, undefined);
	});

	void it("hook rewrites oversized bash results and merges details", () => {
		const pi = createMockPi();
		extension(pi as never);
		const big = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
		const image = { type: "image", data: "abc" } as unknown as { type: string; text?: string };
		const result = pi.fireToolResult({
			toolName: "bash",
			toolCallId: "2",
			content: [{ type: "text", text: big }, image],
			details: { existing: "keep-me" },
		});

		assert.ok(result, "handler returns a rewrite");
		const content = result.content as Array<{ type: string; text?: string }>;
		assert.match(content[0].text as string, /^\[Bash context guard: preview\]/);
		assert.strictEqual(content[1], image, "non-text content preserved verbatim");

		const details = result.details as Record<string, unknown>;
		assert.strictEqual(details.existing, "keep-me", "pre-existing details preserved");
		const guard = details.bashContextGuard as { trimmed: boolean; outputPath: string };
		assert.strictEqual(guard.trimmed, true);
		unlinkSync(guard.outputPath);
	});

	void it("hook restores the complete output path from a failed command notice", () => {
		const pi = createMockPi();
		extension(pi as never);
		const piFile = join(
			tmpdir(),
			`pi-bash-context-guard-test-error-${randomUUID()}.log`,
		);
		const fullText = Array.from({ length: 10_000 }, (_, i) => `raw ${i + 1}`).join("\n");
		writeFileSync(piFile, fullText);
		let guardPath: string | undefined;

		try {
			const piPreview = [
				...Array.from({ length: 100 }, (_, i) => `pi preview ${i + 1}`),
				"",
				`[Showing lines 9901-10000 of 10000. Full output: ${piFile}]`,
				"",
				"Command exited with code 1",
			].join("\n");
			const result = pi.fireToolResult({
				toolName: "bash",
				toolCallId: "failed-command",
				content: [{ type: "text", text: piPreview }],
				isError: true,
			});

			assert.ok(result, "failed command output is guarded");
			const details = result.details as Record<string, unknown>;
			const guard = details.bashContextGuard as {
				outputPath: string;
				outputPathSource: string;
			};
			guardPath = guard.outputPath;
			assert.strictEqual(guard.outputPath, piFile);
			assert.strictEqual(guard.outputPathSource, "pi");
			const preview = (result.content as Array<{ text?: string }>)[0].text as string;
			assert.ok(preview.includes("raw 1\n"));
			assert.ok(preview.includes("raw 10000"));
			assert.ok(preview.includes("Status: Command exited with code 1"));
			assert.ok(!preview.includes("pi preview"));
		} finally {
			if (guardPath && guardPath !== piFile && existsSync(guardPath)) {
				unlinkSync(guardPath);
			}
			unlinkSync(piFile);
		}
	});

	void it("does not mistake failed command output for Pi's truncation notice", () => {
		const pi = createMockPi();
		extension(pi as never);
		const unrelatedFile = join(
			tmpdir(),
			`pi-bash-context-guard-test-unrelated-${randomUUID()}.log`,
		);
		writeFileSync(unrelatedFile, "unrelated file contents");
		let guardPath: string | undefined;

		try {
			const commandOutput = [
				...Array.from({ length: 200 }, (_, i) => `command line ${i + 1}`),
				`Full output: ${unrelatedFile}`,
				"Command exited with code 1",
			].join("\n");
			const result = pi.fireToolResult({
				toolName: "bash",
				toolCallId: "failed-command-own-output",
				content: [{ type: "text", text: commandOutput }],
				isError: true,
			});

			assert.ok(result, "the command's own oversized output is guarded");
			const details = result.details as Record<string, unknown>;
			const guard = details.bashContextGuard as {
				outputPath: string;
				outputPathSource: string;
			};
			guardPath = guard.outputPath;
			assert.strictEqual(guard.outputPathSource, "guard");
			assert.notStrictEqual(guard.outputPath, unrelatedFile);
			assert.strictEqual(readFileSync(guard.outputPath, "utf8"), commandOutput);
		} finally {
			if (guardPath && existsSync(guardPath)) unlinkSync(guardPath);
			unlinkSync(unrelatedFile);
		}
	});

	void it("hook returns undefined for small bash results", () => {
		const pi = createMockPi();
		extension(pi as never);
		const result = pi.fireToolResult({
			toolName: "bash",
			toolCallId: "3",
			content: [{ type: "text", text: "tiny" }],
		});
		assert.strictEqual(result, undefined);
	});
});
