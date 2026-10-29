/**
 * Caps the model-facing codemode return at 30,000 characters.
 *
 * Nested tool results and smaller previews stay as Pi delivered them. A script
 * whose `// @options:` line asks for a larger `max_output_tokens` raises the cap
 * to that budget. Longer returns get a middle cut with the full-text path, the
 * omitted range when it indexes that file, and a read instruction in the
 * omission hole. Pi spills are reused for text-only returns; image returns get
 * a private spill with the complete output and Pi's image-path annotations.
 */
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolResultEventResult } from "@earendil-works/pi-coding-agent";

export const CODEMODE_OUTPUT_MAX_CHARS = 30_000;

/** Pi's codemode budget allows this many characters per `max_output_tokens` token. */
const CHARS_PER_TOKEN = 4;

const OPTIONS_PREFIX = "// @options:";

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
	/** The tool input; a codemode script is `input.code`. */
	input?: Record<string, unknown>;
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

/** A complete-output file and, when known, its text, which the cut's offsets must index. */
interface Spill {
	path: string;
	text?: string;
}

interface OmittedRange {
	start: number;
	end: number;
	total: number;
}

const OMISSION_INSTRUCTION =
	`You already have the text before and after the gap. Get what you still need in one call: use tools.bash to run node on the full text and print only the lines, fields, or character range you need (offsets are JavaScript string indices). One call prints at most ${CODEMODE_OUTPUT_MAX_CHARS.toLocaleString("en-US")} characters; a script whose first line is // @options: {"max_output_tokens": N} may print about ${CHARS_PER_TOKEN} characters per token. Do not rerun the original command.`;

const HEADER_PATTERN = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

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

function omissionMarker(omitted: number, path: string, range?: OmittedRange): string {
	const where = range ? `, slice(${range.start}, ${range.end}) of ${range.total}` : "";
	return `\n\n... ${omitted} characters omitted${where}. Full text: ${path}\n${OMISSION_INSTRUCTION}\n\n`;
}

/** The longest marker for a text of `total` characters: every number as wide as `total`. */
function markerReserve(total: number, path: string, showRange: boolean): number {
	return omissionMarker(total, path, showRange ? { start: total, end: total, total } : undefined).length;
}

/**
 * Middle-cut `fullText` to `maxChars`, naming `path` in the hole. `showRange` adds the omitted
 * `slice(start, end)`; pass false when `fullText` is not the start of that file.
 */
export function capCodemodeText(fullText: string, path: string, maxChars = CODEMODE_OUTPUT_MAX_CHARS, showRange = true): string {
	if (maxChars <= 0) return "";
	if (fullText.length <= maxChars) return fullText;

	const total = fullText.length;
	// Reserve the widest marker, so the cut can be chosen before the marker names it.
	const available = maxChars - markerReserve(total, path, showRange);
	if (available <= 0) {
		return omissionMarker(total, path, showRange ? { start: 0, end: total, total } : undefined).slice(-maxChars);
	}
	const head = Math.ceil(available / 2);
	const end = total - Math.floor(available / 2);
	const marker = omissionMarker(end - head, path, showRange ? { start: head, end, total } : undefined);
	return `${fullText.slice(0, head)}${marker}${fullText.slice(end)}`;
}

function joinedText(content: CapContentBlock[]): string {
	return content.filter((block): block is TextBlock => block.type === "text").map((block) => block.text).join("\n");
}

function otherBlocks(content: CapContentBlock[]): CapContentBlock[] {
	return content.filter((block) => block.type !== "text");
}

/** Pi's "Script completed" header block, apart from the output it introduces. */
function splitHeader(content: CapContentBlock[]): { header?: TextBlock; output: CapContentBlock[] } {
	const first = content[0];
	return first?.type === "text" && HEADER_PATTERN.test(first.text)
		? { header: first, output: content.slice(1) }
		: { output: content };
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

/** `max_output_tokens` from a script's first-line `// @options:`, read the way Pi's codemode reads it. */
function requestedOutputTokens(input: Record<string, unknown> | undefined): number | undefined {
	const code = input?.["code"];
	if (typeof code !== "string") return undefined;
	const firstLine = (code.split("\n", 1)[0] ?? "").replace(/\r$/, "").trimStart();
	if (!firstLine.startsWith(OPTIONS_PREFIX)) return undefined;
	try {
		const options: unknown = JSON.parse(firstLine.slice(OPTIONS_PREFIX.length));
		if (typeof options !== "object" || options === null) return undefined;
		const tokens = (options as { max_output_tokens?: unknown }).max_output_tokens;
		return typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : undefined;
	} catch {
		return undefined;
	}
}

/** A script's budget raises the cap; a smaller one is already enforced by Pi. */
function outputCap(input: Record<string, unknown> | undefined): number {
	return Math.max(CODEMODE_OUTPUT_MAX_CHARS, (requestedOutputTokens(input) ?? 0) * CHARS_PER_TOKEN);
}

function cappedContent(content: CapContentBlock[], maxChars: number, spill?: Spill, notice = ""): CapContentBlock[] {
	const { header, output } = splitHeader(content);
	const body: CapContentBlock[] = [];
	let images: CapContentBlock[] = [];
	for (const [index, block] of output.entries()) {
		if (block.type === "image") {
			images.push(block);
			continue;
		}
		const label = output[index + 1]?.type === "image"
			? block.text.match(/(?:^|\n)(\[Image (?:saved to |\()[^\n]*\])$/)
			: null;
		if (label?.[1]) {
			body.push({ type: "text", text: block.text.slice(0, label.index) });
			images.push({ type: "text", text: label[1] });
		} else {
			body.push(block);
		}
	}

	// Like Pi's native truncation, move each path annotation with its image.
	const headerChars = header ? header.text.length + 1 : 0;
	let annotationChars = images.reduce((count, block) => count + (block.type === "text" ? block.text.length + 1 : 0), 0);
	let full = joinedText(body);
	const originalLength = joinedText(content).length;
	const markerChars = spill
		? markerReserve(originalLength, spill.path, true)
		: `\n\n... ${originalLength} characters omitted ...\n\n`.length;
	const maxReserved = maxChars - headerChars - markerChars - 2;
	if (annotationChars > 0 && annotationChars + notice.length > maxReserved) {
		full = joinedText(output);
		images = otherBlocks(output);
		annotationChars = 0;
		notice += spill && !notice
			? "\n\nImage annotations are in the full text, in image order."
			: "\n\nImage annotations were omitted and could not be saved.";
	}
	notice = middleCut(notice, maxReserved - annotationChars);
	const budget = maxChars - headerChars - annotationChars - notice.length;
	// Offsets index the file only when the cut text is its start.
	const preview = spill
		? capCodemodeText(full, spill.path, budget, spill.text?.startsWith(full) ?? false)
		: middleCut(full, budget);
	return [...(header ? [header] : []), { type: "text", text: `${preview}${notice}` }, ...images];
}

/**
 * Swap Pi's truncated preview for the complete text in its spill, so the cut and the omission
 * count describe the advertised file. Returns undefined when the preview has an unknown shape.
 */
function withNativeText(content: CapContentBlock[], nativePath: string, nativeText: string): CapContentBlock[] | undefined {
	const hint = `\n\n[Full output: ${nativePath} (read with offset/limit)]`;
	const index = content.findIndex((block) => block.type === "text" && block.text.includes(hint));
	const block = content[index];
	if (block?.type !== "text") return undefined;
	const hintAt = block.text.lastIndexOf(hint);
	// Image annotations follow the hint; keep them beside their images.
	const rest = block.text.slice(hintAt + hint.length);
	return content.with(index, { type: "text", text: `${nativeText}${rest}` });
}

function cappedResult(event: CapEvent, maxChars: number, spill: Spill, wroteFile: boolean, notice = ""): CapResult {
	return {
		content: cappedContent(event.content, maxChars, spill, notice),
		...(wroteFile ? { details: withOutputPath(event.details, spill.path) } : {}),
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

	const maxChars = outputCap(event.input);
	if (joinedText(event.content).length <= maxChars) return undefined;

	// Pi writes its text spill before adding image-path annotations.
	const nativePath = fullOutputPathOf(event.details);
	let nativeText: string | undefined;
	let readError: unknown;
	if (nativePath) {
		try {
			nativeText = await io.readFile(nativePath);
		} catch (error) {
			// A text-only return keeps Pi's preview, which still names the native spill.
			readError = error;
		}
	}
	const content = nativePath && nativeText !== undefined
		? withNativeText(event.content, nativePath, nativeText)
		: undefined;
	if (content) event = { ...event, content };
	const nativeSpill: Spill | undefined = nativePath
		? { path: nativePath, ...(nativeText !== undefined ? { text: nativeText } : {}) }
		: undefined;
	let spill = otherBlocks(event.content).length === 0 ? nativeSpill : undefined;
	let wroteFile = false;
	if (!spill) {
		try {
			if (readError !== undefined) throw readError;
			// Like Pi's spill, the file holds the output without the header.
			const full = joinedText(splitHeader(event.content).output);
			// An unrecognized preview cannot be swapped, so the spill keeps both texts.
			const text = nativeText !== undefined && !content
				? `${nativeText}\n\n[Pi return preview and image paths]\n${full}`
				: full;
			spill = { path: await io.writeFile(text), text };
			wroteFile = true;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			const notice = `\n\n[Could not save the full output: ${reason}]`;
			if (nativeSpill) return cappedResult(event, maxChars, nativeSpill, false, notice);
			return {
				content: cappedContent(event.content, maxChars, undefined, notice),
				...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
			};
		}
	}

	return cappedResult(event, maxChars, spill, wroteFile);
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event): Promise<ToolResultEventResult | undefined> => {
		const result = await applyCodemodeOutputCap({
			toolName: event.toolName,
			input: event.input,
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
