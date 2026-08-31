/**
 * ReadSeek Output Guard
 *
 * Keeps oversized model-visible output from pi-readseek's unbounded digest and
 * discovery tools out of context. Guarded names are `read` / `readSeek_digest`,
 * `readSeek_refs`, `readSeek_search`, and `readSeek_def`.
 *
 * Digest emits complete requested facets by default. refs/search/def emit every
 * result. grep has configured match/line/byte budgets; write/view truncate; and
 * edit/rename return compact visible summaries.
 *
 * This tool_result hook is post-execution: the source tool has already built its
 * full text/details. The guard only bounds what enters model-visible content.
 * Results over MAX_LINES or MAX_BYTES are replaced with a small head/tail preview
 * whose "Full output:" header points at a temp file containing the COMPLETE text.
 *
 * Full-output files remain untouched as the source of truth. Only compact preview
 * text is sanitized: ANSI escapes are removed, CRLF becomes LF, and bare CR
 * becomes LF. Preview lines are capped at 1 KiB. Fail-open: any fs error leaves
 * the original result unchanged.
 */
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

const MAX_LINES = 200;
const MAX_BYTES = 16_384;
const HEAD_LINES = 20;
const TAIL_LINES = 50;
const PREVIEW_LINE_MAX_BYTES = 1_024;

const GUARDED_TOOLS = new Set([
	"read",
	"readSeek_digest",
	"readSeek_refs",
	"readSeek_search",
	"readSeek_def",
]);

export type GuardMetadata = {
	trimmed: true;
	lineCount: number;
	byteCount: number;
	outputPath: string;
};

export type GuardResult = {
	text: string;
	metadata: GuardMetadata;
};

function lineCount(text: string): number {
	return text === "" ? 0 : text.split("\n").length;
}

function byteCount(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function truncateUtf8(text: string, maxBytes: number): {
	text: string;
	byteCount: number;
} {
	let bytes = 0;
	let result = "";
	for (const char of text) {
		const charBytes = byteCount(char);
		if (bytes + charBytes > maxBytes) break;
		result += char;
		bytes += charBytes;
	}
	return { text: result, byteCount: bytes };
}

function sanitizePreviewText(text: string): string {
	return stripVTControlCharacters(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function formatPreviewLine(line: string): string {
	const totalBytes = byteCount(line);
	if (totalBytes <= PREVIEW_LINE_MAX_BYTES) return line;
	const truncated = truncateUtf8(line, PREVIEW_LINE_MAX_BYTES);
	return `${truncated.text}\n[truncated preview line: ${totalBytes} bytes total, showing ${truncated.byteCount} bytes]`;
}

function renderPreview(fullText: string, outputPath: string): string {
	const lines = sanitizePreviewText(fullText).split("\n");
	const headEnd = Math.min(HEAD_LINES, lines.length);
	const tailStart = Math.max(headEnd, lines.length - TAIL_LINES);
	const head = lines.slice(0, headEnd).map(formatPreviewLine);
	const tail = lines.slice(tailStart).map(formatPreviewLine);
	const omitted = lines.slice(headEnd, tailStart);

	const rendered: string[] = [
		"[ReadSeek context guard: preview]",
		`Full output: ${outputPath}`,
		`Output: ${lineCount(fullText)} lines, ${byteCount(fullText)} bytes`,
		`Trigger thresholds: ${MAX_LINES} lines, ${MAX_BYTES} bytes`,
		"Refine instead of reading the full output: use read 'at'/'limit' or 'map'; narrow 'path'; use refs 'scope'; qualify def names; tighten search patterns.",
		"",
		"Head:",
		...head,
	];
	if (omitted.length > 0) {
		rendered.push(
			`... omitted ${omitted.length} lines / ${byteCount(omitted.join("\n"))} bytes ...`,
		);
	}
	rendered.push("Tail:", ...tail, "[End ReadSeek context guard preview]");
	return rendered.join("\n");
}

function writeGuardTempFile(fullText: string): string {
	const path = join(tmpdir(), `pi-readseek-output-guard-${randomUUID()}.txt`);
	writeFileSync(path, fullText, { mode: 0o600, flag: "wx" });
	return path;
}

export function guardReadSeekOutput(text: string): GuardResult | undefined {
	if (text === "" || (lineCount(text) <= MAX_LINES && byteCount(text) <= MAX_BYTES)) {
		return undefined;
	}

	let outputPath: string;
	try {
		outputPath = writeGuardTempFile(text);
	} catch {
		return undefined;
	}

	return {
		text: renderPreview(text, outputPath),
		metadata: {
			trimmed: true,
			lineCount: lineCount(text),
			byteCount: byteCount(text),
			outputPath,
		},
	};
}

export default function (pi: ExtensionAPI): void {
	pi.on("tool_result", (event) => {
		if (!GUARDED_TOOLS.has(event.toolName)) return undefined;

		const textContent = event.content.filter((c) => c.type === "text");
		const nonTextContent = event.content.filter((c) => c.type !== "text");
		const text = textContent.map((c) => c.text).join("\n");
		const result = guardReadSeekOutput(text);
		if (result === undefined) return undefined;

		return {
			content: [{ type: "text" as const, text: result.text }, ...nonTextContent],
			details: {
				...(event.details ?? {}),
				readSeekOutputGuard: result.metadata,
			},
		};
	});
}
