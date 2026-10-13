/**
 * Caps the model-facing codemode return at 10,000 characters.
 *
 * Nested tool results stay as Pi delivered them. When the return is longer,
 * the complete text is one private temp file and the model sees a middle cut
 * with that path inside the budget. An existing Pi spill is reused.
 */
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolResultEventResult } from "@earendil-works/pi-coding-agent";

export const CODEMODE_OUTPUT_MAX_CHARS = 10_000;

export interface TextBlock {
	type: "text";
	text: string;
}

export interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}

export type CapContentBlock = TextBlock | ImageBlock;

export interface CapEvent {
	toolName: string;
	parentToolCallId?: string;
	content: CapContentBlock[];
	details?: unknown;
	structuredContent?: JsonValue;
}

export interface CapResult {
	content: CapContentBlock[];
	details?: unknown;
	structuredContent?: JsonValue;
}

export interface CapIo {
	readFile(path: string): Promise<string>;
	writeFile(text: string): Promise<string>;
}

export function middleCut(value: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	if (value.length <= maxChars) return value;
	const marker = `\n\n... ${value.length - maxChars} characters omitted ...\n\n`;
	const available = maxChars - marker.length;
	if (available <= 0) return marker.slice(-maxChars);
	const head = Math.ceil(available / 2);
	const tail = Math.floor(available / 2);
	return `${value.slice(0, head)}${marker}${tail > 0 ? value.slice(value.length - tail) : ""}`;
}

export function capCodemodeText(fullText: string, path: string, maxChars = CODEMODE_OUTPUT_MAX_CHARS): string {
	const suffix = `\n\n[Full output (${fullText.length} chars) saved to: ${path}]`;
	if (suffix.length >= maxChars) return suffix.slice(-maxChars);
	const text = `${middleCut(fullText, maxChars - suffix.length)}${suffix}`;
	return text.length <= maxChars ? text : suffix.slice(-maxChars);
}

function joinedText(content: CapContentBlock[]): string {
	return content.filter((block): block is TextBlock => block.type === "text").map((block) => block.text).join("\n");
}

function otherBlocks(content: CapContentBlock[]): CapContentBlock[] {
	return content.filter((block) => block.type !== "text");
}

function fullOutputPathOf(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const path = (details as { fullOutputPath?: unknown }).fullOutputPath;
	return typeof path === "string" && path.length > 0 ? path : undefined;
}

function withOutputPath(details: unknown, path: string): unknown {
	if (typeof details === "object" && details !== null && !Array.isArray(details)) {
		return { ...details, fullOutputPath: path };
	}
	return { fullOutputPath: path };
}

function cappedResult(event: CapEvent, fullText: string, path: string, wroteFile: boolean): CapResult {
	const content: CapContentBlock[] = [
		{ type: "text", text: capCodemodeText(fullText, path) },
		...otherBlocks(event.content),
	];
	return {
		content,
		...(wroteFile ? { details: withOutputPath(event.details, path) } : {}),
		...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
	};
}

export async function writeCapFile(text: string): Promise<string> {
	const path = join(tmpdir(), `pi-codemode-cap-${randomBytes(8).toString("hex")}.txt`);
	await writeFile(path, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
	return path;
}

export async function applyCodemodeOutputCap(event: CapEvent, io: CapIo): Promise<CapResult | undefined> {
	if (event.toolName !== "codemode" || event.parentToolCallId !== undefined) return undefined;

	const joined = joinedText(event.content);
	const existingPath = fullOutputPathOf(event.details);
	let full = joined;
	if (existingPath) {
		try {
			full = await io.readFile(existingPath);
		} catch {
			full = joined;
		}
	}

	if (full.length <= CODEMODE_OUTPUT_MAX_CHARS && joined.length <= CODEMODE_OUTPUT_MAX_CHARS) return undefined;

	if (full.length <= CODEMODE_OUTPUT_MAX_CHARS) {
		return {
			content: [{ type: "text", text: full }, ...otherBlocks(event.content)],
			...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
		};
	}

	const reused = existingPath !== undefined && full !== joined;
	let path = reused ? existingPath : undefined;
	let wroteFile = false;
	if (!path) {
		try {
			path = await io.writeFile(full);
			wroteFile = true;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			const notice = `\n\n[Could not save the full output: ${reason}]`;
			const budget = Math.max(1, CODEMODE_OUTPUT_MAX_CHARS - notice.length);
			return {
				content: [{ type: "text", text: `${middleCut(full, budget)}${notice}` }, ...otherBlocks(event.content)],
				...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
			};
		}
	}

	return cappedResult(event, full, path, wroteFile);
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event): Promise<ToolResultEventResult | undefined> => {
		const result = await applyCodemodeOutputCap({
			toolName: event.toolName,
			content: event.content.flatMap((block): CapContentBlock[] => {
				if (block.type === "text") return [{ type: "text", text: block.text }];
				return [{ type: "image", data: block.data, mimeType: block.mimeType }];
			}),
			...(event.details !== undefined ? { details: event.details } : {}),
			...(event.parentToolCallId !== undefined ? { parentToolCallId: event.parentToolCallId } : {}),
			...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
		}, {
			readFile: (path) => readFile(path, "utf8"),
			writeFile: writeCapFile,
		});
		if (!result) return undefined;
		return {
			content: result.content,
			...(result.details !== undefined ? { details: result.details } : {}),
			...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
		};
	});
}
