/**
 * OpenCode Go usage, rendered into pi's footer status line.
 *
 * The installed `pi-opencode-go-provider` package owns the endpoint, polling,
 * parsing, and formatting; reconciliation disables its native editor widget so
 * exactly one controller polls. This adapter drives that controller onto the
 * footer instead. Upstream modules are internal, not a published API: the
 * consumed surface is validated at load time and failures produce one
 * diagnostic, never a local fallback implementation.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Footer slot owned exclusively by this adapter. */
export const FOOTER_STATUS_KEY = "opencode-go-usage-footer";

const PROVIDER_ID = "opencode-go";
const PACKAGE_NAME = "pi-opencode-go-provider";
const CONFIG_BASENAME = "opencode-go-provider.json";
const MULTIPROVIDER_SERVICE_EVENT = "pi-multiprovider:service";
const FOOTER_PREFIX = "Go left: ";

/** Severity labels upstream tags its widget segments with. */
export type UpstreamSeverity = "ok" | "warning" | "critical" | "muted";

const SEVERITY_COLORS: Record<UpstreamSeverity, string> = {
	ok: "success",
	warning: "warning",
	critical: "error",
	muted: "dim",
};

export interface UpstreamUsageConfig {
	enabled: boolean;
	refreshIntervalMs: number;
	showOnlyOnProvider: boolean;
	showResetTimes: boolean;
	glyphs: string;
	placement: string;
}

export interface UpstreamGlyphSet {
	sep: string;
	reset: string;
	barFilled: string;
	barHollow: string;
	ellipsis: string;
}

export interface UpstreamUsageWindow {
	key: string;
	label: string;
	status: string;
	usedPercent: number;
	remainingPercent: number;
	resetsAt: number | null;
}

export interface UpstreamSnapshot {
	capturedAt: number;
	windows: readonly UpstreamUsageWindow[];
	isLimited: boolean;
	bankedResets: number | null;
}

export interface UpstreamSegment {
	text: string;
	severity: UpstreamSeverity;
}

export interface UpstreamController {
	readonly snapshot: UpstreamSnapshot | undefined;

	isEligible(ctx: ExtensionContext): boolean;
	isStale(): boolean;
	start(ctx: ExtensionContext): void;
	refresh(ctx: ExtensionContext, options?: { force?: boolean; notify?: boolean }): Promise<void>;
	shutdown(): void;
}

export interface UpstreamMultiproviderService {
	onActiveAccountChanged(providerId: string, callback: () => void): () => void;
}

export interface ThemeLike {
	fg(color: string, text: string): string;
}

/** The narrow slice of the installed provider this adapter consumes. */
export interface ProviderBindings {
	readConfig(): UpstreamUsageConfig;

	createController(
		getConfig: () => UpstreamUsageConfig,
		onUpdate: (ctx: ExtensionContext) => void,
	): UpstreamController;

	/** Footer projection: upstream data, local surface and colour mapping. */
	projectFooter(
		snapshot: UpstreamSnapshot,
		config: UpstreamUsageConfig,
		stale: boolean,
		theme: ThemeLike,
	): string;

	pooling: {
		isService(value: unknown): value is UpstreamMultiproviderService;
		setService(service: UpstreamMultiproviderService | undefined): void;
	};
}

export interface FooterDependencies {
	loadProvider(): Promise<ProviderBindings>;
}

function resolveProviderRoot(): string {
	const requireFromAgentNpm = createRequire(join(getAgentDir(), "npm", "noop.js"));
	return dirname(requireFromAgentNpm.resolve(`${PACKAGE_NAME}/package.json`));
}

function requireFunctions(
	moduleName: string,
	module: Record<string, unknown>,
	names: readonly string[],
): void {
	for (const name of names) {
		if (typeof module[name] !== "function") {
			throw new Error(`${moduleName}.${name} is not a function`);
		}
	}
}

/** Resolve and validate the provider modules this adapter drives. */
export async function loadInstalledProvider(): Promise<ProviderBindings> {
	const root = resolveProviderRoot();
	const [usage, controllerModule, configModule, glyphModule, formatModule, multiproviderModule] =
		await Promise.all([
			import(join(root, "usage.ts")) as Promise<Record<string, unknown>>,
			import(join(root, "usage-controller.ts")) as Promise<Record<string, unknown>>,
			import(join(root, "config.ts")) as Promise<Record<string, unknown>>,
			import(join(root, "glyphs.ts")) as Promise<Record<string, unknown>>,
			import(join(root, "format.ts")) as Promise<Record<string, unknown>>,
			import(join(root, "multiprovider.ts")) as Promise<Record<string, unknown>>,
		]);
	requireFunctions("usage.ts", usage, ["usageSegments"]);
	requireFunctions("usage-controller.ts", controllerModule, ["UsageController"]);
	requireFunctions("config.ts", configModule, ["readUsageConfig"]);
	requireFunctions("glyphs.ts", glyphModule, ["resolveGlyphSet"]);
	requireFunctions("format.ts", formatModule, ["sanitizeStatusText"]);
	requireFunctions("multiprovider.ts", multiproviderModule, [
		"isMultiproviderService",
		"setActiveMultiproviderService",
	]);

	const UsageController = controllerModule.UsageController as new (
		getConfig: () => UpstreamUsageConfig,
		onUpdate: (ctx: ExtensionContext) => void,
	) => UpstreamController;

	return {
		readConfig: () => (configModule.readUsageConfig as () => UpstreamUsageConfig)(),
		createController: (getConfig, onUpdate) => new UsageController(getConfig, onUpdate),
		projectFooter: (snapshot, config, stale, theme) => {
			const glyphs = (glyphModule.resolveGlyphSet as (mode: string) => UpstreamGlyphSet)(config.glyphs);
			const segments = (usage.usageSegments as (
				snapshot: UpstreamSnapshot,
				options: { showResetTimes: boolean; glyphs: UpstreamGlyphSet },
			) => UpstreamSegment[])(snapshot, { showResetTimes: config.showResetTimes, glyphs });
			// Upstream leads with its own "Usage:" label; this surface names itself.
			const labelled =
				segments[0]?.text.trim() === "Usage:"
					? [{ ...segments[0], text: FOOTER_PREFIX }, ...segments.slice(1)]
					: segments;
			const colored = labelled
				.map((segment) => theme.fg(SEVERITY_COLORS[segment.severity] ?? "dim", segment.text))
				.join("");
			const line = `${colored}${stale ? theme.fg("warning", " · stale") : ""}`;
			return (formatModule.sanitizeStatusText as (text: string) => string)(line);
		},
		pooling: {
			isService: multiproviderModule.isMultiproviderService as (
				value: unknown,
			) => value is UpstreamMultiproviderService,
			setService: multiproviderModule.setActiveMultiproviderService as (
				service: UpstreamMultiproviderService | undefined,
			) => void,
		},
	};
}

type Lifecycle =
	| { kind: "idle" }
	| { kind: "ready"; controller: UpstreamController }
	| { kind: "unavailable" };

function isEligibleContext(ctx: ExtensionContext): boolean {
	return ctx.hasUI && ctx.model?.provider === PROVIDER_ID;
}

/**
 * Wire the footer adapter into pi.
 *
 * `dependencies` exists so behavior tests can drive the lifecycle with a stub
 * provider; production passes the installed-package loader.
 */
export function createOpenCodeGoUsageExtension(
	dependencies: FooterDependencies = { loadProvider: loadInstalledProvider },
): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		let lifecycle: Lifecycle = { kind: "idle" };
		/** In-flight provider load, shared by concurrent activations. */
		let loading: Promise<void> | undefined;
		let bindings: ProviderBindings | undefined;
		let activeContext: ExtensionContext | undefined;
		let generation = 0;
		let announcedService: unknown;
		let subscribedService: UpstreamMultiproviderService | undefined;
		let unsubscribeAccounts: (() => void) | undefined;
		let diagnosticsShown = 0;

		const warnOnce = (ctx: ExtensionContext, message: string): void => {
			if (diagnosticsShown > 0) return;
			diagnosticsShown++;
			ctx.ui.notify(message, "warning");
		};

		const clearFooter = (ctx: ExtensionContext | undefined): void => {
			if (ctx?.hasUI) ctx.ui.setStatus(FOOTER_STATUS_KEY, undefined);
		};

		/** Repaint from the controller that is current right now. */
		const update = (ctx: ExtensionContext): void => {
			if (lifecycle.kind !== "ready" || bindings === undefined) return;
			const snapshot = lifecycle.controller.snapshot;
			if (snapshot === undefined) {
				clearFooter(ctx);
				return;
			}
			ctx.ui.setStatus(
				FOOTER_STATUS_KEY,
				bindings.projectFooter(snapshot, bindings.readConfig(), lifecycle.controller.isStale(), ctx.ui.theme),
			);
		};

		const footerConfig = (source: ProviderBindings): UpstreamUsageConfig => ({
			// Native display stays off; this adapter is the only surface.
			...source.readConfig(),
			enabled: true,
			showOnlyOnProvider: true,
		});

		const unsubscribeFromAccounts = (): void => {
			unsubscribeAccounts?.();
			unsubscribeAccounts = undefined;
			subscribedService = undefined;
		};

		const applyService = (loaded: ProviderBindings, service: UpstreamMultiproviderService): void => {
			loaded.pooling.setService(service);
			if (subscribedService === service) return;
			unsubscribeFromAccounts();
			subscribedService = service;
			unsubscribeAccounts = service.onActiveAccountChanged(PROVIDER_ID, restartForActiveAccount);
		};

		/** A pooled account switch bills different budgets: replace the controller. */
		const restartForActiveAccount = (): void => {
			if (lifecycle.kind !== "ready" || bindings === undefined || activeContext === undefined) return;
			const loaded = bindings;
			clearFooter(activeContext);
			lifecycle.controller.shutdown();
			const controller = loaded.createController(() => footerConfig(loaded), update);
			lifecycle = { kind: "ready", controller };
			controller.start(activeContext);
		};

		const deactivate = (ctx?: ExtensionContext): void => {
			generation++;
			if (lifecycle.kind === "ready") lifecycle.controller.shutdown();
			if (lifecycle.kind !== "unavailable") lifecycle = { kind: "idle" };
			clearFooter(ctx ?? activeContext);
		};

		const activate = async (ctx: ExtensionContext): Promise<void> => {
			if (!isEligibleContext(ctx)) {
				deactivate(ctx);
				return;
			}
			activeContext = ctx;
			if (lifecycle.kind === "ready" || lifecycle.kind === "unavailable") return;
			if (loading !== undefined) {
				await loading;
				return;
			}

			const requestGeneration = generation;
			const pending = (async () => {
				try {
					bindings = bindings ?? (await dependencies.loadProvider());
				} catch {
					if (requestGeneration === generation) {
						lifecycle = { kind: "unavailable" };
						warnOnce(
							ctx,
							`OpenCode Go footer: could not load ${PACKAGE_NAME}. Repair the install and reload pi.`,
						);
					}
					return;
				}
				if (requestGeneration !== generation) return;

				const native = bindings.readConfig();
				if (native.enabled) {
					lifecycle = { kind: "unavailable" };
					warnOnce(
						ctx,
						`OpenCode Go footer: native usage is still enabled, so the footer stays off. ` +
							`Set usage.enabled to false in ${CONFIG_BASENAME} and reload pi.`,
					);
					return;
				}

				if (announcedService !== undefined && bindings.pooling.isService(announcedService)) {
					applyService(bindings, announcedService);
				}

				const loaded = bindings;
				const controller = loaded.createController(() => footerConfig(loaded), update);
				lifecycle = { kind: "ready", controller };
				controller.start(ctx);
			})();
			loading = pending;
			try {
				await pending;
			} finally {
				if (loading === pending) loading = undefined;
			}
		};

		pi.on("session_start", async (_event, ctx) => {
			diagnosticsShown = 0;
			generation++;
			lifecycle = { kind: "idle" };
			activeContext = undefined;
			await activate(ctx);
		});

		pi.on("model_select", async (_event, ctx) => {
			await activate(ctx);
		});

		pi.on("turn_end", (_event, ctx) => {
			if (lifecycle.kind !== "ready") return;
			void lifecycle.controller.refresh(ctx);
		});

		pi.on("session_shutdown", () => {
			deactivate();
			unsubscribeFromAccounts();
			bindings?.pooling.setService(undefined);
			activeContext = undefined;
		});

		pi.events.on(MULTIPROVIDER_SERVICE_EVENT, (value: unknown) => {
			announcedService = value;
			if (bindings === undefined || !bindings.pooling.isService(value)) return;
			applyService(bindings, value);
		});
	};
}

export default createOpenCodeGoUsageExtension();
