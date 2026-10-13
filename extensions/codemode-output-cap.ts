/**
 * Caps the model-facing codemode return at 10,000 characters.
 *
 * Nested tool results and smaller previews stay as Pi delivered them. Longer
 * returns get a middle cut with the full-text path and read instruction in
 * the omission hole. Pi spills are reused for text-only returns; image returns
 * get a private spill that includes Pi's image-path annotations.
 */
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
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
	writeFile(text: string): Promise<string>;
}

const OMISSION_INSTRUCTION =
	"Read it with tools.read, about 80 lines at a time, or search it. text() of the whole file is cut again. Do not re-run the command.";

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

function omissionMarker(omitted: number, path: string): string {
	return `\n\n... ${omitted} characters omitted. Full text: ${path}\n${OMISSION_INSTRUCTION}\n\n`;
}

export function capCodemodeText(fullText: string, path: string, maxChars = CODEMODE_OUTPUT_MAX_CHARS): string {
	if (maxChars <= 0) return "";
	if (fullText.length <= maxChars) return fullText;

	let omitted = fullText.length - maxChars;
	let marker = omissionMarker(omitted, path);
	for (let attempt = 0; attempt < 8; attempt++) {
		const next = fullText.length - maxChars + marker.length;
		const nextMarker = omissionMarker(next, path);
		if (next === omitted && nextMarker === marker) break;
		omitted = next;
		marker = nextMarker;
	}

	if (marker.length >= maxChars) return marker.slice(-maxChars);
	const available = maxChars - marker.length;
	const head = Math.ceil(available / 2);
	const tail = Math.floor(available / 2);
	return `${fullText.slice(0, head)}${marker}${tail > 0 ? fullText.slice(fullText.length - tail) : ""}`;
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

	const full = joinedText(event.content);
	if (full.length <= CODEMODE_OUTPUT_MAX_CHARS) return undefined;

	// Pi writes its text spill before adding image-path annotations.
	let path = otherBlocks(event.content).length === 0 ? fullOutputPathOf(event.details) : undefined;
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
