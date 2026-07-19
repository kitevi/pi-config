import { randomUUID } from "node:crypto";
import { open, readFile, rm, type FileHandle } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

export interface FabricCodeModeContextGuardLimits {
	maxLines: number;
	maxBytes: number;
	headLines: number;
	tailLines: number;
}

export const DEFAULT_LIMITS: FabricCodeModeContextGuardLimits = {
	maxLines: 80,
	maxBytes: 6144,
	headLines: 12,
	tailLines: 35,
};

type GuardEvent = Pick<ToolResultEvent, "toolName" | "content">;
type GuardPatch = Pick<ToolResultEvent, "content">;

interface GuardOptions {
	limits: FabricCodeModeContextGuardLimits;
	persist: (text: string) => Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLimits(value: unknown): FabricCodeModeContextGuardLimits {
	if (!isRecord(value)) throw new Error("guard config must be an object");
	const integer = (key: keyof FabricCodeModeContextGuardLimits, minimum: number) => {
		const candidate = value[key];
		if (!Number.isInteger(candidate) || (candidate as number) < minimum) {
			throw new Error(`${key} must be an integer >= ${minimum}`);
		}
		return candidate as number;
	};
	const limits = {
		maxLines: integer("maxLines", 3),
		maxBytes: integer("maxBytes", 256),
		headLines: integer("headLines", 0),
		tailLines: integer("tailLines", 0),
	};
	if (limits.headLines + limits.tailLines + 3 > limits.maxLines) {
		throw new Error("head/tail lines leave no room for guard metadata");
	}
	return limits;
}

export async function loadFabricCodeModeContextGuardConfig(
	path: string,
): Promise<FabricCodeModeContextGuardLimits> {
	return parseLimits(JSON.parse(await readFile(path, "utf8")));
}

export async function persistFabricOutput(text: string): Promise<string> {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const path = join(
			tmpdir(),
			`pi-fabric-code-mode-context-guard-${process.pid}-${randomUUID()}.txt`,
		);
		let handle: FileHandle | undefined;
		try {
			handle = await open(path, "wx", 0o600);
			await handle.writeFile(text, "utf8");
			await handle.sync();
			await handle.close();
			return path;
		} catch (error) {
			await handle?.close().catch(() => undefined);
			if (handle) await rm(path, { force: true }).catch(() => undefined);
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw error;
		}
	}
	throw new Error("Could not reserve a unique Fabric context-guard temp file");
}

function textPayload(event: GuardEvent): string {
	return event.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const suffix = maxBytes >= 3 ? "…" : "";
	const budget = maxBytes - Buffer.byteLength(suffix, "utf8");
	let result = "";
	let used = 0;
	for (const character of text) {
		const bytes = Buffer.byteLength(character, "utf8");
		if (used + bytes > budget) break;
		result += character;
		used += bytes;
	}
	return result + suffix;
}

function buildPreview(
	text: string,
	path: string,
	limits: FabricCodeModeContextGuardLimits,
): string {
	const lines = text.split("\n");
	const headCount = Math.min(limits.headLines, lines.length);
	const tailStart = Math.max(headCount, lines.length - limits.tailLines);
	const head = lines.slice(0, headCount);
	const tail = lines.slice(tailStart);
	const omittedLines = Math.max(0, lines.length - head.length - tail.length);
	const header = [
		`[Fabric code-mode context guard: ${lines.length} lines / ${Buffer.byteLength(text, "utf8")} bytes exceeded ${limits.maxLines} lines / ${limits.maxBytes} bytes.]`,
		`[Full output: ${JSON.stringify(path)}]`,
	];
	const marker =
		`[… output shortened; ${omittedLines} whole lines omitted; long lines may be shortened …]`;
	const outputLineCount = header.length + head.length + 1 + tail.length;
	if (outputLineCount > limits.maxLines) {
		throw new Error("guard limits reserve too many preview lines");
	}

	const fixedBytes = Buffer.byteLength([...header, marker].join(""), "utf8") +
		(outputLineCount - 1);
	let remainingBytes = limits.maxBytes - fixedBytes;
	if (remainingBytes < 0) throw new Error("guard metadata exceeds the byte budget");

	const selected = [...head, ...tail];
	const bounded: string[] = [];
	for (let index = 0; index < selected.length; index += 1) {
		const quota = Math.floor(remainingBytes / (selected.length - index));
		const line = truncateUtf8(selected[index] ?? "", quota);
		bounded.push(line);
		remainingBytes -= Buffer.byteLength(line, "utf8");
	}

	return [
		...header,
		...bounded.slice(0, head.length),
		marker,
		...bounded.slice(head.length),
	].join("\n");
}

function replaceTextContent(
	event: GuardEvent,
	preview: string,
): ToolResultEvent["content"] {
	const content: ToolResultEvent["content"] = [];
	let replaced = false;
	for (const block of event.content) {
		if (block.type !== "text") content.push(block);
		else if (!replaced) {
			content.push({ ...block, text: preview });
			replaced = true;
		}
	}
	return content;
}

export function createFabricCodeModeContextGuard(
	options: GuardOptions,
): (event: GuardEvent) => Promise<GuardPatch | undefined> {
	return async (event) => {
		// In full-code mode, only fabric_exec is model-bound. Nested pi.* lifecycle
		// events stay untouched so the sandbox can reduce their bounded results.
		if (event.toolName !== "fabric_exec") return undefined;

		const text = textPayload(event);
		if (
			text.split("\n").length <= options.limits.maxLines &&
			Buffer.byteLength(text, "utf8") <= options.limits.maxBytes
		) return undefined;

		try {
			const path = await options.persist(text);
			return {
				content: replaceTextContent(
					event,
					buildPreview(text, path, options.limits),
				),
			};
		} catch {
			return {
				content: replaceTextContent(
					event,
					truncateUtf8(
						"[Fabric code-mode context guard failure: oversized output was withheld because it could not be saved safely.]",
						options.limits.maxBytes,
					),
				),
			};
		}
	};
}

export default async function fabricCodeModeContextGuardExtension(
	pi: ExtensionAPI,
) {
	const path = process.env.PI_FABRIC_CODE_MODE_CONTEXT_GUARD_CONFIG ??
		join(homedir(), ".pi", "agent", "fabric-code-mode-context-guard.json");
	let limits = DEFAULT_LIMITS;
	try {
		limits = await loadFabricCodeModeContextGuardConfig(path);
	} catch (error) {
		console.error(
			`Fabric code-mode context guard could not load ${path}; using safe defaults:`,
			error instanceof Error ? error.message : String(error),
		);
	}

	pi.on("tool_result", createFabricCodeModeContextGuard({
		limits,
		persist: persistFabricOutput,
	}));
}
