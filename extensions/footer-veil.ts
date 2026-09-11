import {
	type ExtensionAPI,
	type ExtensionContext,
	FooterComponent,
	InteractiveMode,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const TOGGLE_MODEL_INFO_SHORTCUT = "ctrl+p";
const REFRESH_WIDGET_KEY = "footer-veil";

// Hidden mode keeps built-in footer stats and explicitly allowlisted widgets.
// Providers remain hidden by default; their source maps are never modified.
const NO_EXTENSION_STATUSES: ReadonlyMap<string, string> = new Map();
const ALWAYS_VISIBLE_WIDGETS: ReadonlySet<string> = new Set(["skill-guide"]);

// These private Pi surfaces have no public visibility hook. Keep their shape
// assumptions here, and cover them through the bundled-UI integration test.
interface VeilableFooterData {
	getExtensionStatuses(): ReadonlyMap<string, string>;
}

interface FooterDataHost {
	footerData?: VeilableFooterData | null;
}

function asFooterData(host: unknown): VeilableFooterData | undefined {
	if (typeof host !== "object" || host === null) return undefined;
	const data = (host as FooterDataHost).footerData;
	if (typeof data !== "object" || data === null) return undefined;
	if (typeof data.getExtensionStatuses !== "function") return undefined;
	return data;
}

export function withVeiledExtensionStatuses<T>(
	host: unknown,
	hidden: boolean,
	run: () => T,
	onShapeWarning?: () => void,
): T {
	const footerData = asFooterData(host);
	if (!hidden || !footerData) {
		if (hidden) onShapeWarning?.();
		return run();
	}
	const original = footerData.getExtensionStatuses;
	footerData.getExtensionStatuses = () => NO_EXTENSION_STATUSES;
	try {
		return run();
	} finally {
		footerData.getExtensionStatuses = original;
	}
}

interface WidgetContainer {
	clear(): void;
	addChild(child: unknown): void;
}

type RenderWidgetContainerFn = (
	this: InteractiveMode,
	container: WidgetContainer,
	widgets: ReadonlyMap<string, unknown>,
	spacerWhenEmpty: boolean,
	leadingSpacer: boolean,
) => void;

export function stripModelInfoFromFooterLine(line: string): string {
	// Pi joins stats with single spaces, then pads the model with at least two.
	// Cut at that boundary, not at a model name that Pi may have truncated.
	const paddingStart = line.search(/ {2,}/);
	return paddingStart < 0 ? line : truncateToWidth(line, visibleWidth(line.slice(0, paddingStart)), "");
}

const WARNING_MESSAGES = {
	footer: "Footer veil: unexpected footer shape; usage statuses left visible.",
	widget: "Footer veil: unexpected widget surface; usage widgets left visible.",
};
type VeilWarningKind = keyof typeof WARNING_MESSAGES;

interface VeilSessionBindings {
	reportWarning(message: string): void;
}

function defaultSessionBindings(): VeilSessionBindings {
	return { reportWarning: () => {} };
}

// Own patches and current UI bindings together. Pi emits session_shutdown
// before replacing extension modules; no render-host tracking is needed.
const veil = {
	shown: false,
	session: defaultSessionBindings(),
	warnings: new Set<VeilWarningKind>(),
	originalFooterRender: undefined as FooterComponent["render"] | undefined,
	originalRenderWidgetContainer: undefined as RenderWidgetContainerFn | undefined,

	beginSession(bindings: VeilSessionBindings): void {
		this.shown = false;
		this.warnings.clear();
		this.session = bindings;
	},

	warn(kind: VeilWarningKind): void {
		if (this.warnings.has(kind)) return;
		this.warnings.add(kind);
		this.session.reportWarning(WARNING_MESSAGES[kind]);
	},

	install(): void {
		if (!this.originalFooterRender) {
			const original = FooterComponent.prototype.render;
			FooterComponent.prototype.render = function renderWithFooterVeil(width: number): string[] {
				const lines = withVeiledExtensionStatuses(
					this,
					!veil.shown,
					() => original.call(this, width),
					() => veil.warn("footer"),
				);
				if (lines.length < 2) return lines;

				const nextLines = [...lines];
				nextLines[1] = veil.shown ? lines[1] : stripModelInfoFromFooterLine(lines[1]);
				return nextLines;
			};
			this.originalFooterRender = original;
		}

		if (!this.originalRenderWidgetContainer) {
			const proto = InteractiveMode.prototype as unknown as {
				renderWidgetContainer?: RenderWidgetContainerFn;
			};
			if (typeof proto.renderWidgetContainer !== "function") {
				this.warn("widget");
			} else {
				const original = proto.renderWidgetContainer;
				proto.renderWidgetContainer = function renderWidgetContainerWithFooterVeil(
					this: InteractiveMode,
					container: WidgetContainer,
					widgets: ReadonlyMap<string, unknown>,
					spacerWhenEmpty: boolean,
					leadingSpacer: boolean,
				): void {
					const visible = veil.shown
						? widgets
						: new Map([...widgets].filter(([key]) => ALWAYS_VISIBLE_WIDGETS.has(key)));
					original.call(this, container, visible, spacerWhenEmpty, leadingSpacer);
				};
				this.originalRenderWidgetContainer = original;
			}
		}
	},

	uninstall(): void {
		if (this.originalFooterRender) FooterComponent.prototype.render = this.originalFooterRender;
		this.originalFooterRender = undefined;
		if (this.originalRenderWidgetContainer) {
			(InteractiveMode.prototype as unknown as { renderWidgetContainer: RenderWidgetContainerFn })
				.renderWidgetContainer = this.originalRenderWidgetContainer;
		}
		this.originalRenderWidgetContainer = undefined;
		this.session = defaultSessionBindings();
	},

	refresh(ctx: ExtensionContext): void {
		if (!this.originalRenderWidgetContainer || !ctx.hasUI) return;
		// Removing our unused widget through the public UI API rebuilds both
		// containers, including widgets populated before the patch ran.
		// A paint request alone leaves cached children unchanged.
		ctx.ui.setWidget(REFRESH_WIDGET_KEY, undefined);
	},
};

/** Restore prototypes and clear session bindings between isolated unit tests. */
export function resetFooterVeilForTests(): void {
	veil.uninstall();
	veil.beginSession(defaultSessionBindings());
}

export default function footerVeilExtension(pi: ExtensionAPI): void {
	pi.registerShortcut(TOGGLE_MODEL_INFO_SHORTCUT, {
		description: "Toggle footer details (skill guide stays visible)",
		handler: async (ctx) => {
			veil.shown = !veil.shown;
			veil.refresh(ctx);
			if (ctx.hasUI) {
				ctx.ui.notify(`Model info and usage ${veil.shown ? "shown" : "hidden"}.`, "info");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		veil.beginSession({
			reportWarning: (message) => {
				if (ctx.hasUI) ctx.ui.notify(message, "warning");
			},
		});
		veil.install();
		veil.refresh(ctx);
	});

	pi.on("session_shutdown", async () => {
		veil.uninstall();
	});
}
