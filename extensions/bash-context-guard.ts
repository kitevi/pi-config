/**
 * Bash Context Guard
 *
 * Keeps oversized bash tool results out of the context. Results over
 * MAX_LINES or MAX_BYTES are replaced with a small head/tail preview whose
 * "Full output:" header points at a file containing the COMPLETE output:
 * pi's own fullOutputPath when pi already truncated (pi writes the complete
 * captured output there), otherwise a temp file this guard writes.
 *
 * Full-output files remain untouched as the source of truth. Only compact preview
 * text is sanitized: ANSI escapes are removed, CRLF becomes LF, and bare CR
 * becomes LF. Preview lines are capped at 1 KiB. Fail-open: any fs error leaves
 * the original result unchanged.
 */
import {
	isBashToolResult,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";

const MAX_LINES = 80;
const MAX_BYTES = 6_144;
const HEAD_LINES = 12;
const TAIL_LINES = 35;
const PREVIEW_LINE_MAX_BYTES = 1_024;

export type GuardMetadata = {
	trimmed: true;
	lineCount: number;
	byteCount: number;
	outputPath: string;
	outputPathSource: "pi" | "guard";
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

function renderPreview(
	fullText: string,
	outputPath: string,
	status?: string,
): string {
	const lines = sanitizePreviewText(fullText).split("\n");
	const headEnd = Math.min(HEAD_LINES, lines.length);
	const tailStart = Math.max(headEnd, lines.length - TAIL_LINES);
	const head = lines.slice(0, headEnd).map(formatPreviewLine);
	const tail = lines.slice(tailStart).map(formatPreviewLine);
	const omitted = lines.slice(headEnd, tailStart);

	const rendered: string[] = [
		"[Bash context guard: preview]",
		`Full output: ${outputPath}`,
		`Output: ${lineCount(fullText)} lines, ${byteCount(fullText)} bytes`,
		`Trigger thresholds: ${MAX_LINES} lines, ${MAX_BYTES} bytes`,
	];
	if (status) rendered.push(`Status: ${sanitizePreviewText(status)}`);
	rendered.push("", "Head:", ...head);
	if (omitted.length > 0) {
		rendered.push(
			`... omitted ${omitted.length} lines / ${byteCount(omitted.join("\n"))} bytes ...`,
		);
	}
	rendered.push("Tail:", ...tail, "[End Bash context guard preview]");
	return rendered.join("\n");
}

function writeGuardTempFile(fullText: string): string {
	const path = join(tmpdir(), `pi-bash-context-guard-${randomUUID()}.txt`);
	writeFileSync(path, fullText, { mode: 0o600, flag: "wx" });
	return path;
}

export function guardBashOutput(options: {
	text: string;
	fullOutputPath?: string;
	status?: string;
}): GuardResult | undefined {
	const text = options.text;

	// When pi's own truncation fired, the complete output is already on disk;
	// preview/count from it and point at it. Pi's mid-tier preview text is
	// discarded entirely.
	let fullText = text;
	let output: { path: string; source: "pi" | "guard" } | undefined;
	if (typeof options.fullOutputPath === "string") {
		try {
			fullText = readFileSync(options.fullOutputPath, "utf8");
			output = { path: options.fullOutputPath, source: "pi" };
		} catch {
			return undefined;
		}
	}

	const lines = lineCount(fullText);
	const bytes = byteCount(fullText);

	if (fullText === "" || (lines <= MAX_LINES && bytes <= MAX_BYTES)) {
		return undefined;
	}

	if (output === undefined) {
		try {
			output = { path: writeGuardTempFile(fullText), source: "guard" };
		} catch {
			return undefined;
		}
	}

	return {
		text: renderPreview(fullText, output.path, options.status),
		metadata: {
			trimmed: true,
			lineCount: lines,
			byteCount: bytes,
			outputPath: output.path,
			outputPathSource: output.source,
		},
	};
}

function isPathInside(parent: string, candidate: string): boolean {
	const relativePath = relative(parent, candidate);
	return (
		relativePath === "" ||
		(relativePath !== ".." &&
			!relativePath.startsWith(`..${sep}`) &&
			!isAbsolute(relativePath))
	);
}

function validatePiFullOutputPath(value: unknown): string | undefined {
	if (typeof value !== "string" || value === "" || value.trim() !== value) {
		return undefined;
	}
	if (!isAbsolute(value) || !isPathInside(tmpdir(), value)) return undefined;
	return value;
}

function extractPiFullOutputPathFromNotice(text: string): string | undefined {
	const match = text.match(
		/^\[Showing [^\r\n]+\. Full output: ([^\]\r\n]+)\]$/m,
	);
	return validatePiFullOutputPath(match?.[1]?.trim());
}

function extractFailureStatus(text: string, isError: boolean): string | undefined {
	if (!isError) return undefined;
	const lines = text.split("\n");
	let status: string | undefined;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const candidate = lines[index]?.trim();
		if (candidate) {
			status = candidate;
			break;
		}
	}
	if (!status) return undefined;
	return /^(?:Command exited with code \d+|Command aborted|Command timed out after \S+ seconds)$/.test(
		status,
	)
		? status
		: undefined;
}

export default function (pi: ExtensionAPI): void {
	pi.on("tool_result", (event) => {
		if (!isBashToolResult(event)) return undefined;

		const textContent = event.content.filter((c) => c.type === "text");
		const nonTextContent = event.content.filter((c) => c.type !== "text");
		const text = textContent.map((c) => c.text).join("\n");
		const fullOutputPath =
			validatePiFullOutputPath(event.details?.fullOutputPath) ??
			(event.isError ? extractPiFullOutputPathFromNotice(text) : undefined);
		const result = guardBashOutput({
			text,
			fullOutputPath,
			status: fullOutputPath
				? extractFailureStatus(text, event.isError)
				: undefined,
		});
		if (result === undefined) return undefined;

		return {
			content: [{ type: "text" as const, text: result.text }, ...nonTextContent],
			details: {
				...(event.details ?? {}),
				bashContextGuard: result.metadata,
			},
		};
	});
}
