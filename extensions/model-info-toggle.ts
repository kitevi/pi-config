import type { Api, Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, FooterComponent } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type Verbosity = "low" | "medium" | "high";

type SupportedVerbosityApi = "openai-responses" | "openai-codex-responses" | "azure-openai-responses";

const DEFAULT_SHOW_MODEL_INFO = false;
const GPT_VERBOSITY: Verbosity = "low";
const TOGGLE_MODEL_INFO_SHORTCUT = "ctrl+p" as KeyId;
const DUMB_ZONE_TOKEN_THRESHOLD = 128_000;
const DUMB_ZONE_LABEL = "dumb";
const SUPPORTED_APIS = new Set<SupportedVerbosityApi>([
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
]);

let originalFooterRender: ((this: FooterComponent, width: number) => string[]) | undefined;
let footerPatched = false;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function supportsVerbosityControl(model: Pick<Model<Api>, "api"> | undefined): boolean {
	return !!model && SUPPORTED_APIS.has(model.api as SupportedVerbosityApi);
}

export function getModelVerbosity(model: Pick<Model<Api>, "api" | "id"> | undefined): Verbosity | undefined {
	if (!model || !supportsVerbosityControl(model)) return undefined;
	return model.id.startsWith("gpt-") ? GPT_VERBOSITY : undefined;
}

export function patchPayloadVerbosity(payload: unknown, verbosity: Verbosity): unknown {
	if (!isObject(payload)) return payload;

	const text = isObject(payload.text) ? payload.text : {};

	return {
		...payload,
		text: {
			...text,
			verbosity,
		},
	};
}

export function formatFooterTokenCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function shouldShowDumbZone(
	usage: { tokens: number | null } | undefined,
	threshold = DUMB_ZONE_TOKEN_THRESHOLD,
): boolean {
	return typeof usage?.tokens === "number" && usage.tokens > threshold;
}

export function injectDumbZoneIntoFooterLine(
	line: string,
	contextWindow: number | undefined,
	label: string,
	width: number,
): string {
	if (!contextWindow || width <= 0) return line;

	const contextWindowMarker = `/${formatFooterTokenCount(contextWindow)}`;
	const markerStart = line.indexOf(contextWindowMarker);
	if (markerStart === -1) return line;
	const insertAt = markerStart + contextWindowMarker.length;

	const insertText = ` ${label}`;
	const suffix = line.slice(insertAt);
	const removableSpaces = suffix.match(/^ */)?.[0].length ?? 0;
	const spacesToRemove = Math.min(removableSpaces, visibleWidth(insertText));

	return truncateToWidth(`${line.slice(0, insertAt)}${insertText}${suffix.slice(spacesToRemove)}`, width, "");
}

export function buildFooterRightSideCandidates(
	model: Pick<Model<Api>, "provider" | "id" | "reasoning">,
	thinkingLevel: string | undefined,
): string[] {
	const modelName = model.id;
	let rightSideWithoutProvider = modelName;

	if (model.reasoning) {
		const level = thinkingLevel || "off";
		rightSideWithoutProvider = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
	}

	return [`(${model.provider}) ${rightSideWithoutProvider}`, rightSideWithoutProvider];
}

function findFooterRightSide(
	line: string,
	model: Pick<Model<Api>, "provider" | "id" | "reasoning">,
	thinkingLevel: string | undefined,
): { candidate: string; candidateStart: number; paddingStart: number } | undefined {
	for (const candidate of buildFooterRightSideCandidates(model, thinkingLevel)) {
		const candidateStart = line.lastIndexOf(candidate);
		if (candidateStart === -1) continue;

		let paddingStart = candidateStart;
		while (paddingStart > 0 && line[paddingStart - 1] === " ") {
			paddingStart--;
		}

		return { candidate, candidateStart, paddingStart };
	}

	return undefined;
}

export function stripModelInfoFromFooterLine(
	line: string,
	model: Pick<Model<Api>, "provider" | "id" | "reasoning">,
	thinkingLevel: string | undefined,
): string {
	const match = findFooterRightSide(line, model, thinkingLevel);
	if (!match) return line;

	return line.slice(0, match.paddingStart) + line.slice(match.candidateStart + match.candidate.length);
}

export function injectVerbosityIntoFooterLine(
	line: string,
	model: Pick<Model<Api>, "provider" | "id" | "reasoning">,
	thinkingLevel: string | undefined,
	verbosity: Verbosity,
): string {
	const match = findFooterRightSide(line, model, thinkingLevel);
	if (!match) return line;

	const verbositySuffix = ` • 🗣  ${verbosity}`;
	const prefix = line.slice(0, match.paddingStart);
	const suffixAnsi = line.slice(match.candidateStart + match.candidate.length);
	const availableWidth = match.candidateStart - match.paddingStart + visibleWidth(match.candidate);
	const desiredRightSide = `${match.candidate}${verbositySuffix}`;
	const fittedRightSide = truncateToWidth(desiredRightSide, availableWidth, "");
	const fittedWidth = visibleWidth(fittedRightSide);
	const nextPadding = " ".repeat(Math.max(0, availableWidth - fittedWidth));

	return `${prefix}${nextPadding}${fittedRightSide}${suffixAnsi}`;
}

function patchFooterRender(
	getShowModelInfo: () => boolean,
	getDumbZoneLabel: () => string,
): void {
	if (footerPatched) return;

	originalFooterRender = FooterComponent.prototype.render;
	FooterComponent.prototype.render = function renderWithModelInfoToggle(width: number): string[] {
		const lines = originalFooterRender?.call(this, width) ?? [];
		if (lines.length < 2) return lines;

		const session = (this as unknown as {
			session?: {
				state?: { model?: Model<Api>; thinkingLevel?: string };
				getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
			};
		}).session;
		const model = session?.state?.model;
		const nextLines = [...lines];
		let footerLine = lines[1] ?? "";

		if (model) {
			if (!getShowModelInfo()) {
				footerLine = stripModelInfoFromFooterLine(footerLine, model, session?.state?.thinkingLevel);
			} else {
				const verbosity = getModelVerbosity(model);
				if (verbosity) {
					footerLine = injectVerbosityIntoFooterLine(footerLine, model, session?.state?.thinkingLevel, verbosity);
				}
			}
		}

		const usage = session?.getContextUsage?.();
		if (shouldShowDumbZone(usage)) {
			footerLine = injectDumbZoneIntoFooterLine(footerLine, usage?.contextWindow, getDumbZoneLabel(), width);
		}

		nextLines[1] = footerLine;
		return nextLines;
	};
	footerPatched = true;
}

function unpatchFooterRender(): void {
	if (!footerPatched || !originalFooterRender) return;

	FooterComponent.prototype.render = originalFooterRender;
	footerPatched = false;
	originalFooterRender = undefined;
}

export default function modelInfoToggleExtension(pi: ExtensionAPI): void {
	let showModelInfo = DEFAULT_SHOW_MODEL_INFO;

	pi.registerShortcut(TOGGLE_MODEL_INFO_SHORTCUT, {
		description: "Toggle model info footer visibility",
		handler: async (ctx) => {
			showModelInfo = !showModelInfo;

			if (ctx.hasUI) {
				ctx.ui.notify(`Model info footer ${showModelInfo ? "shown" : "hidden"}.`, "info");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		showModelInfo = DEFAULT_SHOW_MODEL_INFO;
		patchFooterRender(
			() => showModelInfo,
			() => ctx.ui.theme.fg("warning", DUMB_ZONE_LABEL),
		);
	});

	pi.on("session_shutdown", async () => {
		unpatchFooterRender();
	});

	pi.on("before_provider_request", (event, ctx) => {
		const verbosity = getModelVerbosity(ctx.model);
		if (!verbosity) return undefined;

		return patchPayloadVerbosity(event.payload, verbosity);
	});
}
