/** Single-account OpenCode Go usage in the footer, using the installed provider's controller. */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const FOOTER_STATUS_KEY = "opencode-go-usage-footer";
const PACKAGE_NAME = "pi-opencode-go-provider";

/** Only the provider configuration fields needed by this adapter. */
export interface UpstreamUsageConfig {
	enabled: boolean;
	showOnlyOnProvider: boolean;
}

export interface UpstreamController {
	line(ctx: ExtensionContext): string | undefined;
	start(ctx: ExtensionContext): void;
	refresh(ctx: ExtensionContext, options?: { force?: boolean; notify?: boolean }): Promise<void>;
	shutdown(): void;
}

export interface ProviderBindings {
	readConfig(): UpstreamUsageConfig;
	createController(
		getConfig: () => UpstreamUsageConfig,
		onUpdate: (ctx: ExtensionContext) => void,
	): UpstreamController;
}

// These two modules are upstream internals. Keep the contract small and check it on load.
export async function loadInstalledProvider(): Promise<ProviderBindings> {
	const requireFromAgentNpm = createRequire(join(getAgentDir(), "npm", "noop.js"));
	const root = dirname(requireFromAgentNpm.resolve(`${PACKAGE_NAME}/package.json`));
	const [config, controller] = await Promise.all([
		import(join(root, "config.ts")) as Promise<Record<string, unknown>>,
		import(join(root, "usage-controller.ts")) as Promise<Record<string, unknown>>,
	]);
	const Controller = controller["UsageController"];
	if (typeof config["readUsageConfig"] !== "function" || typeof Controller !== "function") {
		throw new Error("OpenCode Go usage API is incompatible");
	}
	for (const method of ["line", "start", "refresh", "shutdown"]) {
		if (typeof Controller.prototype[method] !== "function") {
			throw new Error(`UsageController.${method} is not a function`);
		}
	}
	const UsageController = Controller as new (
		getConfig: () => UpstreamUsageConfig,
		onUpdate: (ctx: ExtensionContext) => void,
	) => UpstreamController;
	return {
		readConfig: config["readUsageConfig"] as () => UpstreamUsageConfig,
		createController: (getConfig, onUpdate) => new UsageController(getConfig, onUpdate),
	};
}

function formatFooterLine(line: string): string {
	const parts = line.replace(/^Usage: /, "Go left: ").split(" · ");
	const budgets = new Map<string, number>();
	for (const [index, part] of parts.entries()) {
		const label = part.match(/^(?:Go left: )?([^:]+): [0-9]+(?:[.][0-9]+)?%$/)?.[1];
		if (label !== undefined) budgets.set(label, index);
	}
	const moved = new Set<number>();
	for (const [index, part] of parts.entries()) {
		const reset = part.match(/^(?:(.+) )?↺ (.+)$/);
		if (!reset) continue;
		const label = reset[1] ?? (budgets.size === 1 ? budgets.keys().next().value : undefined);
		const budgetIndex = label === undefined ? undefined : budgets.get(label);
		if (budgetIndex === undefined) continue;
		parts[budgetIndex] += ` ↺ ${reset[2]}`;
		moved.add(index);
	}
	return parts.filter((_part, index) => !moved.has(index)).join(" · ");
}

export function createOpenCodeGoUsageExtension(
	dependencies: { loadProvider(): Promise<ProviderBindings> } = { loadProvider: loadInstalledProvider },
): (pi: ExtensionAPI) => void {
	return (pi) => {
		let loading: Promise<ProviderBindings> | undefined;
		let controller: UpstreamController | undefined;
		let activeContext: ExtensionContext | undefined;
		let generation = 0;
		let warned = false;

		const warnOnce = (ctx: ExtensionContext, message: string): void => {
			if (warned) return;
			warned = true;
			ctx.ui.notify(message, "warning");
		};

		const deactivate = (ctx = activeContext): void => {
			generation++;
			const previous = controller;
			controller = undefined;
			activeContext = undefined;
			previous?.shutdown();
			if (ctx?.hasUI) ctx.ui.setStatus(FOOTER_STATUS_KEY, undefined);
		};

		const update = (source: UpstreamController): void => {
			if (controller !== source || activeContext === undefined) return;
			const line = source.line(activeContext);
			activeContext.ui.setStatus(FOOTER_STATUS_KEY, line === undefined ? undefined : formatFooterLine(line));
		};

		const activate = async (ctx: ExtensionContext): Promise<void> => {
			if (!ctx.hasUI || ctx.model?.provider !== "opencode-go") {
				deactivate(ctx);
				return;
			}
			activeContext = ctx;
			const requestGeneration = generation;
			try {
				const bindings = await (loading ??= dependencies.loadProvider());
				if (requestGeneration !== generation || activeContext === undefined) return;
				if (bindings.readConfig().enabled) {
					deactivate();
					warnOnce(ctx, "OpenCode Go footer: native usage is enabled. Run npm run setup and reload pi.");
					return;
				}
				if (controller !== undefined) {
					update(controller);
					return;
				}
				const next = bindings.createController(
					() => ({ ...bindings.readConfig(), enabled: true, showOnlyOnProvider: true }),
					() => update(next),
				);
				controller = next;
				next.start(activeContext);
			} catch {
				if (requestGeneration !== generation) return;
				deactivate();
				warnOnce(ctx, `OpenCode Go footer: could not load ${PACKAGE_NAME}. Repair the install and reload pi.`);
			}
		};

		pi.on("session_start", async (_event, ctx) => {
			warned = false;
			deactivate(ctx);
			await activate(ctx);
		});
		pi.on("model_select", (_event, ctx) => activate(ctx));
		pi.on("turn_end", (_event, ctx) => {
			void controller?.refresh(ctx);
		});
		pi.on("session_shutdown", () => deactivate());
	};
}

export default createOpenCodeGoUsageExtension();
