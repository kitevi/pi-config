import type { Api, Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, FooterComponent, InteractiveMode } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
const DEFAULT_SHOW_MODEL_INFO = false;
const TOGGLE_MODEL_INFO_SHORTCUT = "ctrl+p" as KeyId;
const DUMB_ZONE_TOKEN_THRESHOLD = 128_000;
const DUMB_ZONE_LABEL = "dumb";

/** Status-line keys owned by provider usage widgets; veiled while model info is hidden. */
export const USAGE_STATUS_KEYS: ReadonlySet<string> = new Set([
	"better-openai", // pi-better-openai STATUS_KEY (non-TUI status surface)
	"synthetic-usage", // @aliou/pi-synthetic usage-status EXTENSION_ID
	"opencode-go-usage", // local extensions/opencode-go-usage.ts STATUS_ID
	"zro-session", // pi-zro-provider STATUS_KEY_SESSION
	"zro-account", // pi-zro-provider STATUS_KEY_ACCOUNT
	"hypercharm-session", // pi-hypercharm-provider STATUS_KEY_SESSION
	"hypercharm-account", // pi-hypercharm-provider STATUS_KEY_ACCOUNT
	"neuralwatt-energy", // pi-neuralwatt-provider STATUS_KEY_ENERGY (statusbar mode)
	"neuralwatt-quota", // pi-neuralwatt-provider STATUS_KEY_QUOTA (statusbar mode)
	"neuralwatt-mcr", // pi-neuralwatt-provider STATUS_KEY_MCR (statusbar mode)
]);

/** Widget keys owned by provider usage widgets (below-editor status lines); veiled while model info is hidden. */
export const USAGE_WIDGET_KEYS: ReadonlySet<string> = new Set([
	"hypercharm", // pi-hypercharm-provider WIDGET_KEY
	"zro", // pi-zro-provider WIDGET_KEY
	"neuralwatt", // pi-neuralwatt-provider widget key
]);

export function filterUsageWidgets<T>(
	widgets: ReadonlyMap<string, T>,
	hidden: boolean,
	keys: ReadonlySet<string> = USAGE_WIDGET_KEYS,
): ReadonlyMap<string, T> {
	if (!hidden) return widgets;
	let removed = false;
	for (const key of widgets.keys()) {
		if (keys.has(key)) {
			removed = true;
			break;
		}
	}
	if (!removed) return widgets;
	const kept = new Map<string, T>();
	for (const [key, widget] of widgets) {
		if (!keys.has(key)) kept.set(key, widget);
	}
	return kept;
}

export function filterUsageStatuses(
	statuses: ReadonlyMap<string, string>,
	hidden: boolean,
	keys: ReadonlySet<string> = USAGE_STATUS_KEYS,
): ReadonlyMap<string, string> {
	if (!hidden) return statuses;
	let removed = false;
	for (const key of statuses.keys()) {
		if (keys.has(key)) {
			removed = true;
			break;
		}
	}
	if (!removed) return statuses;
	const kept = new Map<string, string>();
	for (const [key, text] of statuses) {
		if (!keys.has(key)) kept.set(key, text);
	}
	return kept;
}

let originalFooterRender: ((this: FooterComponent, width: number) => string[]) | undefined;
let footerPatched = false;
let veilShapeWarningShown = false;

export interface VeilableFooterData {
	getExtensionStatuses(): ReadonlyMap<string, string>;
}

export function withVeiledExtensionStatuses<T>(
	host: unknown,
	hidden: boolean,
	run: () => T,
	onShapeWarning?: () => void,
): T {
	const footerData = (host as { footerData?: VeilableFooterData | null | undefined } | null | undefined)
		?.footerData;
	if (!hidden || !footerData || typeof footerData.getExtensionStatuses !== "function") {
		if (hidden) onShapeWarning?.();
		return run();
	}
	const data: VeilableFooterData = footerData;
	const original = data.getExtensionStatuses;
	data.getExtensionStatuses = () => filterUsageStatuses(original.call(data), true);
	try {
		return run();
	} finally {
		data.getExtensionStatuses = original;
	}
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

function patchFooterRender(
	getShowModelInfo: () => boolean,
	getDumbZoneLabel: () => string,
	onVeilShapeWarning: () => void,
): void {
	if (footerPatched) return;

	originalFooterRender = FooterComponent.prototype.render;
	FooterComponent.prototype.render = function renderWithFooterVeil(width: number): string[] {
		const lines = withVeiledExtensionStatuses(
			this,
			!getShowModelInfo(),
			() => originalFooterRender?.call(this, width) ?? [],
			onVeilShapeWarning,
		);
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

		if (model && !getShowModelInfo()) {
			footerLine = stripModelInfoFromFooterLine(footerLine, model, session?.state?.thinkingLevel);
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

type RenderWidgetContainerFn = (
	this: unknown,
	container: unknown,
	widgets: ReadonlyMap<string, unknown>,
	spacerWhenEmpty: boolean,
	leadingSpacer: boolean,
) => void;

interface WidgetRenderHost {
	renderWidgets(): void;
}

let originalRenderWidgetContainer: RenderWidgetContainerFn | undefined;
let widgetRenderPatched = false;
let widgetShapeWarningShown = false;
let widgetRenderHost: WidgetRenderHost | undefined;

/**
 * Provider usage widgets (hypercharm, zro, neuralwatt) bypass the footer's
 * extension-status line entirely: they render via ctx.ui.setWidget into
 * InteractiveMode's above/below-editor containers. Veil them by filtering the
 * widget map inside renderWidgetContainer, which rebuilds both containers.
 */
function patchWidgetRender(getShowModelInfo: () => boolean, onWidgetShapeWarning: () => void): void {
	if (widgetRenderPatched) return;
	const proto = InteractiveMode.prototype as unknown as {
		renderWidgetContainer?: RenderWidgetContainerFn;
		renderWidgets?: () => void;
	};
	if (typeof proto.renderWidgetContainer !== "function" || typeof proto.renderWidgets !== "function") {
		onWidgetShapeWarning();
		return;
	}
	originalRenderWidgetContainer = proto.renderWidgetContainer;
	proto.renderWidgetContainer = function renderWidgetContainerWithFooterVeil(
		this: unknown,
		container: unknown,
		widgets: ReadonlyMap<string, unknown>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		widgetRenderHost = this as WidgetRenderHost;
		const visible = filterUsageWidgets(widgets, !getShowModelInfo());
		originalRenderWidgetContainer?.call(this, container, visible, spacerWhenEmpty, leadingSpacer);
	};
	widgetRenderPatched = true;
}

function unpatchWidgetRender(): void {
	if (!widgetRenderPatched || !originalRenderWidgetContainer) return;

	(InteractiveMode.prototype as unknown as { renderWidgetContainer: RenderWidgetContainerFn }).renderWidgetContainer =
		originalRenderWidgetContainer;
	widgetRenderPatched = false;
	originalRenderWidgetContainer = undefined;
	widgetRenderHost = undefined;
}

/** Rebuild the widget containers so a veil-state change applies without waiting for the next setWidget. */
function refreshWidgetContainers(): void {
	if (!widgetRenderPatched) return;
	try {
		widgetRenderHost?.renderWidgets();
	} catch {
		// The host may be mid-teardown; the next render cycle reapplies the veil.
	}
}

const OPENAI_PRESENTATION_COMMAND = "openai-usage-presentation";
type OpenAIPresentationAction = "hide" | "show";
type PresentationDispatchResult = "dispatched" | "unavailable";

function syncOpenAIPresentation(
	pi: Pick<ExtensionAPI, "getCommands" | "sendUserMessage">,
	action: OpenAIPresentationAction,
): PresentationDispatchResult {
	if (!pi.getCommands().some((command) => command.source === "extension" && command.name === OPENAI_PRESENTATION_COMMAND)) {
		return "unavailable";
	}
	// Pi 0.85.1 dispatches recognized extension commands before prompting, even while streaming.
	pi.sendUserMessage(`/${OPENAI_PRESENTATION_COMMAND} ${action}`, { expandPromptTemplates: true });
	return "dispatched";
}

export default function footerVeilExtension(pi: ExtensionAPI): void {
	let showModelInfo = DEFAULT_SHOW_MODEL_INFO;
	let openAIWarningShown = false;

	function synchronizeOpenAI(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const result = syncOpenAIPresentation(pi, showModelInfo ? "show" : "hide");
		if (result === "unavailable" && !openAIWarningShown) {
			openAIWarningShown = true;
			ctx.ui.notify("Footer veil: OpenAI presentation unavailable; load Better OpenAI with /openai-usage-presentation support.", "warning");
		}
	}

	pi.registerShortcut(TOGGLE_MODEL_INFO_SHORTCUT, {
		description: "Toggle footer veil (model info + usage widgets)",
		handler: async (ctx) => {
			showModelInfo = !showModelInfo;
			if (ctx.hasUI) {
				synchronizeOpenAI(ctx);
				ctx.ui.notify("Model info and usage " + (showModelInfo ? "shown" : "hidden") + ".", "info");
			}
			refreshWidgetContainers();
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		showModelInfo = DEFAULT_SHOW_MODEL_INFO;
		openAIWarningShown = false;
		patchFooterRender(
			() => showModelInfo,
			() => ctx.ui.theme.fg("warning", DUMB_ZONE_LABEL),
			() => {
				if (veilShapeWarningShown || !ctx.hasUI) return;
				veilShapeWarningShown = true;
				ctx.ui.notify("Footer veil: unexpected footer shape; usage statuses left visible.", "warning");
			},
		);
		patchWidgetRender(
			() => showModelInfo,
			() => {
				if (widgetShapeWarningShown || !ctx.hasUI) return;
				widgetShapeWarningShown = true;
				ctx.ui.notify("Footer veil: unexpected widget surface; usage widgets left visible.", "warning");
			},
		);
		refreshWidgetContainers();
	});

	pi.on("resources_discover", (_event, ctx) => {
		// This runs after every session_start handler, including Better OpenAI's visibility reset.
		synchronizeOpenAI(ctx);
	});

	pi.on("session_shutdown", async () => {
		unpatchFooterRender();
		unpatchWidgetRender();
	});
}
