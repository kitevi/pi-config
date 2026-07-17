import { chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	createAgentLoopReport,
	type AgentLoopSnapshot,
	type CaptureFidelity,
	type CommandSnapshot,
	type ModelSnapshot,
	type PromptOptionsSnapshot,
	type Serializable,
	type SourceSnapshot,
	type ToolSnapshot,
	type TurnSnapshot,
	type UsageSnapshot,
} from "./report.ts";

const COMMAND_NAME = "export-agent";

interface RuntimeCapture {
	sessionStartedAt: string;
	sessionStartReason: string;
	existingContextEntriesAtLoad: number;
	runStartedAt?: string;
	latestContextBuiltAt?: string;
	latestProviderRequestAt?: string;
	providerRequestCount: number;
	promptOptions?: PromptOptionsSnapshot;
	effectiveSystemPrompt?: string;
	tools?: ToolSnapshot[];
	model?: ModelSnapshot;
	messages?: Serializable[];
	providerPayload?: Serializable;
	turns: TurnSnapshot[];
}

export interface ExportAgentDependencies {
	now?: () => Date;
	tempDirectory?: () => string;
	writeHtml?: (path: string, html: string) => Promise<void>;
}

function finiteNumber(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function sourceSnapshot(value: unknown, fallbackPath: string): SourceSnapshot {
	const source = record(value) ?? {};
	const baseDir = optionalString(source.baseDir);
	return {
		path: optionalString(source.path) ?? fallbackPath,
		source: optionalString(source.source) ?? "unknown",
		scope: optionalString(source.scope) ?? "unknown",
		origin: optionalString(source.origin) ?? "unknown",
		...(baseDir ? { baseDir } : {}),
	};
}

/** Convert extension/provider values into inert, cycle-safe JSON data for the report. */
export function toSerializable(value: unknown): Serializable {
	const seen = new WeakSet<object>();

	const convert = (current: unknown): Serializable => {
		if (current === null) return null;
		if (typeof current === "string" || typeof current === "boolean") return current;
		if (typeof current === "number") return Number.isFinite(current) ? current : String(current);
		if (typeof current === "bigint") return current.toString();
		if (typeof current === "undefined") return "[undefined]";
		if (typeof current === "symbol") return current.toString();
		if (typeof current === "function") return `[Function${current.name ? ` ${current.name}` : ""}]`;
		if (current instanceof Date) return current.toISOString();
		if (current instanceof Error) {
			return {
				name: current.name,
				message: current.message,
				...(current.stack ? { stack: current.stack } : {}),
			};
		}
		if (typeof current !== "object") return String(current);
		if (seen.has(current)) return "[Circular]";
		seen.add(current);

		if (Array.isArray(current)) {
			const result = current.map(convert);
			seen.delete(current);
			return result;
		}

		const result: Record<string, Serializable> = {};
		for (const key of Object.keys(current).sort()) {
			try {
				result[key] = convert((current as Record<string, unknown>)[key]);
			} catch (error) {
				result[key] = `[Unreadable: ${error instanceof Error ? error.message : String(error)}]`;
			}
		}
		seen.delete(current);
		return result;
	};

	return convert(value);
}

export function snapshotPromptOptions(options: BuildSystemPromptOptions): PromptOptionsSnapshot {
	return {
		...(options.customPrompt !== undefined ? { customPrompt: options.customPrompt } : {}),
		selectedTools: [...(options.selectedTools ?? [])],
		toolSnippets: { ...(options.toolSnippets ?? {}) },
		promptGuidelines: [...(options.promptGuidelines ?? [])],
		...(options.appendSystemPrompt !== undefined ? { appendSystemPrompt: options.appendSystemPrompt } : {}),
		cwd: options.cwd,
		contextFiles: (options.contextFiles ?? []).map((file) => ({
			path: file.path,
			content: file.content,
		})),
		skills: (options.skills ?? []).map((skill) => ({
			name: skill.name,
			description: skill.description,
			filePath: skill.filePath,
			baseDir: skill.baseDir,
			disableModelInvocation: skill.disableModelInvocation,
			sourceInfo: sourceSnapshot(skill.sourceInfo, skill.filePath),
		})),
	};
}

function snapshotTools(pi: ExtensionAPI, options: PromptOptionsSnapshot): ToolSnapshot[] {
	const active = new Set(pi.getActiveTools());
	return pi.getAllTools().map((tool) => {
		const enrichedTool = tool as typeof tool & { promptGuidelines?: string[] };
		return {
			name: tool.name,
			description: tool.description,
			active: active.has(tool.name),
			parameters: toSerializable(tool.parameters),
			promptGuidelines: [...(enrichedTool.promptGuidelines ?? [])],
			promptSnippet: options.toolSnippets[tool.name],
			sourceInfo: sourceSnapshot(tool.sourceInfo, `<tool:${tool.name}>`),
		};
	});
}

function snapshotCommands(pi: ExtensionAPI): CommandSnapshot[] {
	return pi.getCommands().map((command) => ({
		name: command.name,
		description: command.description,
		source: command.source,
		sourceInfo: sourceSnapshot(command.sourceInfo, `<command:${command.name}>`),
	}));
}

function snapshotModel(pi: ExtensionAPI, model: ExtensionCommandContext["model"]): ModelSnapshot | undefined {
	if (!model) return undefined;
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		api: model.api,
		contextWindow: finiteNumber(model.contextWindow),
		maxTokens: finiteNumber(model.maxTokens),
		reasoning: model.reasoning,
		input: [...model.input],
		thinkingLevel: pi.getThinkingLevel(),
	};
}

function participatesInContext(entry: unknown): boolean {
	const entryRecord = record(entry);
	if (!entryRecord) return false;
	if (entryRecord.type === "custom_message" || entryRecord.type === "compaction" || entryRecord.type === "branch_summary") return true;
	if (entryRecord.type !== "message") return false;
	const message = record(entryRecord.message);
	return !(message?.role === "bashExecution" && message.excludeFromContext === true);
}

function contextEntryCount(ctx: Pick<ExtensionCommandContext, "sessionManager">): number {
	const manager = ctx.sessionManager as typeof ctx.sessionManager & { buildContextEntries?: () => unknown[] };
	const entries = manager.buildContextEntries?.() ?? manager.getBranch();
	return entries.filter(participatesInContext).length;
}

function promptOptionsForCommand(ctx: ExtensionCommandContext, pi: ExtensionAPI): PromptOptionsSnapshot {
	const getter = (ctx as ExtensionCommandContext & {
		getSystemPromptOptions?: () => BuildSystemPromptOptions;
	}).getSystemPromptOptions;
	if (getter) return snapshotPromptOptions(getter.call(ctx));

	// Compatibility fallback for Pi versions that expose structured options only
	// while an agent run is starting.
	return {
		selectedTools: pi.getActiveTools(),
		toolSnippets: {},
		promptGuidelines: [],
		cwd: ctx.cwd,
		contextFiles: [],
		skills: [],
	};
}

function unwrapQuotedName(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		const last = value.at(-1);
		if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) return value.slice(1, -1);
	}
	return value;
}

export function buildExportPath(
	argument: string,
	sessionId: string,
	generatedAt: Date,
	temporaryDirectory = tmpdir(),
): string {
	const requested = unwrapQuotedName(argument.trim());
	const timestamp = generatedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-");
	const defaultName = `pi-agent-loop-${sessionId.slice(0, 8) || "session"}-${timestamp}.html`;
	const leaf = basename(requested || defaultName)
		.replace(/\s+/g, "-")
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^\.+/, "") || defaultName;
	const htmlName = leaf.toLowerCase().endsWith(".html") ? leaf : `${leaf}.html`;
	return join(temporaryDirectory, htmlName);
}

async function writePrivateHtml(path: string, html: string): Promise<void> {
	await writeFile(path, html, { encoding: "utf8", mode: 0o600 });
	await chmod(path, 0o600);
}

function serializableMessages(value: unknown): Serializable[] {
	const serialized = toSerializable(value);
	return Array.isArray(serialized) ? serialized : [serialized];
}

function usageSnapshot(message: unknown): UsageSnapshot | undefined {
	const usage = record(record(message)?.usage);
	if (!usage) return undefined;
	const cost = record(usage.cost);
	return {
		input: finiteNumber(usage.input),
		cacheRead: finiteNumber(usage.cacheRead),
		cacheWrite: finiteNumber(usage.cacheWrite),
		output: finiteNumber(usage.output),
		totalTokens: finiteNumber(usage.totalTokens),
		...(cost ? {
			cost: {
				input: finiteNumber(cost.input),
				cacheRead: finiteNumber(cost.cacheRead),
				cacheWrite: finiteNumber(cost.cacheWrite),
				output: finiteNumber(cost.output),
				total: finiteNumber(cost.total),
			},
		} : {}),
	};
}

function countToolCalls(message: unknown): number {
	const content = record(message)?.content;
	if (!Array.isArray(content)) return 0;
	return content.filter((part) => {
		const type = record(part)?.type;
		return type === "toolCall" || type === "tool_use" || type === "function_call";
	}).length;
}

function captureFidelity(runtime: RuntimeCapture): CaptureFidelity {
	if (runtime.providerPayload !== undefined) return "provider-request";
	if (runtime.messages !== undefined) return "logical-request";
	return "preflight";
}

function captureNote(runtime: RuntimeCapture): string {
	switch (captureFidelity(runtime)) {
		case "provider-request":
			return `The report uses the latest provider request and ${runtime.turns.length} completed model call(s) observed in the latest agent run.`;
		case "logical-request":
			return "Pi built logical model input, but no provider request body reached this observer—typically because the call failed or was aborted before serialization.";
		case "preflight":
			return "No model call has happened since this session observer started. The report explains the loop using current configuration and a schematic request.";
	}
}

function makeRuntime(
	reason: string,
	ctx: Pick<ExtensionCommandContext, "sessionManager">,
	now: () => Date,
): RuntimeCapture {
	return {
		sessionStartedAt: now().toISOString(),
		sessionStartReason: reason,
		existingContextEntriesAtLoad: contextEntryCount(ctx),
		providerRequestCount: 0,
		turns: [],
	};
}

export function registerAgentLoopExport(
	pi: ExtensionAPI,
	dependencies: ExportAgentDependencies = {},
): void {
	const now = dependencies.now ?? (() => new Date());
	const tempDirectory = dependencies.tempDirectory ?? tmpdir;
	const writeHtml = dependencies.writeHtml ?? writePrivateHtml;
	let runtime: RuntimeCapture | undefined;

	const ensureRuntime = (ctx: Pick<ExtensionCommandContext, "sessionManager">): RuntimeCapture => {
		runtime ??= makeRuntime("unknown", ctx, now);
		return runtime;
	};

	pi.on("session_start", (event, ctx) => {
		runtime = makeRuntime(event.reason, ctx, now);
	});

	pi.on("before_agent_start", (event, ctx) => {
		const current = ensureRuntime(ctx);
		current.runStartedAt = now().toISOString();
		current.latestContextBuiltAt = undefined;
		current.latestProviderRequestAt = undefined;
		current.providerRequestCount = 0;
		current.messages = undefined;
		current.providerPayload = undefined;
		current.turns = [];
		current.promptOptions = snapshotPromptOptions(event.systemPromptOptions);
		current.effectiveSystemPrompt = event.systemPrompt;
		current.tools = snapshotTools(pi, current.promptOptions);
		current.model = snapshotModel(pi, ctx.model);
	});

	pi.on("context", (event, ctx) => {
		const current = ensureRuntime(ctx);
		current.latestContextBuiltAt = now().toISOString();
		current.messages = serializableMessages(event.messages);
		current.effectiveSystemPrompt = ctx.getSystemPrompt();
		if (current.promptOptions) current.tools = snapshotTools(pi, current.promptOptions);
		current.model = snapshotModel(pi, ctx.model);
	});

	pi.on("before_provider_request", (event, ctx) => {
		const current = ensureRuntime(ctx);
		current.latestProviderRequestAt = now().toISOString();
		current.providerRequestCount += 1;
		current.providerPayload = toSerializable(event.payload);
	});

	pi.on("turn_end", (event, ctx) => {
		const current = ensureRuntime(ctx);
		const message = event.message as unknown;
		current.turns.push({
			index: finiteNumber(event.turnIndex),
			stopReason: optionalString(record(message)?.stopReason),
			toolCallCount: countToolCalls(message),
			assistant: toSerializable(message),
			toolResults: serializableMessages(event.toolResults),
			usage: usageSnapshot(message),
		});
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Export a standalone HTML explainer of Pi’s request, cache, and automatic tool loop",
		handler: async (args, ctx) => {
			try {
				await ctx.waitForIdle();
				const current = ensureRuntime(ctx);
				const generatedAt = now();
				const options = current.promptOptions ?? promptOptionsForCommand(ctx, pi);
				const tools = current.tools ?? snapshotTools(pi, options);
				const model = current.model ?? snapshotModel(pi, ctx.model);
				const fidelity = captureFidelity(current);
				const snapshot: AgentLoopSnapshot = {
					schemaVersion: 2,
					generatedAt: generatedAt.toISOString(),
					capture: {
						fidelity,
						sessionStartedAt: current.sessionStartedAt,
						sessionStartReason: current.sessionStartReason,
						runStartedAt: current.runStartedAt,
						latestContextBuiltAt: current.latestContextBuiltAt,
						latestProviderRequestAt: current.latestProviderRequestAt,
						providerRequestCount: current.providerRequestCount,
						existingContextEntriesAtLoad: current.existingContextEntriesAtLoad,
						note: captureNote(current),
					},
					session: {
						id: ctx.sessionManager.getSessionId(),
						file: ctx.sessionManager.getSessionFile(),
						cwd: ctx.cwd,
						name: ctx.sessionManager.getSessionName(),
						persisted: ctx.sessionManager.getSessionFile() !== undefined,
					},
					model,
					prompt: {
						effective: current.effectiveSystemPrompt ?? ctx.getSystemPrompt(),
						options,
					},
					tools,
					messages: fidelity === "preflight" ? [] : current.messages,
					providerPayload: current.providerPayload,
					turns: [...current.turns],
					commands: snapshotCommands(pi),
				};
				const html = createAgentLoopReport(snapshot);
				const outputPath = buildExportPath(args, snapshot.session.id, generatedAt, tempDirectory());
				await writeHtml(outputPath, html);
				if (ctx.hasUI) ctx.ui.notify(`Agent loop report: ${outputPath} (${fidelity})`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(`Agent loop export failed: ${message}`, "error");
				throw error;
			}
		},
	});
}

export default function exportAgentLoopExtension(pi: ExtensionAPI): void {
	registerAgentLoopExport(pi);
}
