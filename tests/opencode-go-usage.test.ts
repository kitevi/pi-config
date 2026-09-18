import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createOpenCodeGoUsageExtension,
	type ProviderBindings,
	type UpstreamController,
	type UpstreamMultiproviderService,
	type UpstreamSnapshot,
	type UpstreamUsageConfig,
} from "../extensions/opencode-go-usage.ts";

const SNAPSHOT: UpstreamSnapshot = { capturedAt: 0, windows: [], isLimited: false, bankedResets: null };

interface StubController extends UpstreamController {
	/** Repaint from the captured context, imitating a late controller callback. */
	paint(): void;
}

interface Harness {
	ctx: ExtensionContext;
	statuses: Map<string, string | undefined>;
	notify: ReturnType<typeof vi.fn>;
	setWidget: ReturnType<typeof vi.fn>;
	service(value: unknown): void;
	emit(name: string): Promise<unknown>;
	select(provider: string): Promise<unknown>;
}

function harness(load: () => Promise<ProviderBindings>): Harness {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let serviceListener: (value: unknown) => void = () => {};
	const statuses = new Map<string, string | undefined>();
	const notify = vi.fn();
	const setWidget = vi.fn();
	const ctx = {
		mode: "tui",
		hasUI: true,
		model: { provider: "other" },
		ui: {
			setStatus: (key: string, text: string | undefined) => void statuses.set(key, text),
			setWidget,
			notify,
			theme: { fg: (_color: string, text: string) => text },
		},
	} as unknown as ExtensionContext;
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
			void handlers.set(name, handler),
		events: {
			on: (_name: string, listener: (value: unknown) => void) => {
				serviceListener = listener;
				return () => {};
			},
		},
	} as unknown as ExtensionAPI;

	createOpenCodeGoUsageExtension({ loadProvider: load })(pi);

	return {
		ctx,
		statuses,
		notify,
		setWidget,
		service: (value) => serviceListener(value),
		emit: async (name) => handlers.get(name)?.({}, ctx),
		select: async (provider) => {
			const model = { provider } as ExtensionContext["model"];
			ctx.model = model;
			await handlers.get("model_select")?.({ model }, ctx);
		},
	};
}

function provider(): {
	bindings: ProviderBindings;
	controllers: StubController[];
	readConfig: ReturnType<typeof vi.fn>;
} {
	const controllers: StubController[] = [];
	const readConfig = vi.fn(
		(): UpstreamUsageConfig => ({
			enabled: false,
			refreshIntervalMs: 60_000,
			showOnlyOnProvider: true,
			showResetTimes: true,
			glyphs: "auto",
			placement: "belowEditor",
		}),
	);
	const bindings: ProviderBindings = {
		readConfig,
		createController: (getConfig, update) => {
			expect(getConfig().enabled).toBe(true);
			let current: ExtensionContext | undefined;
			const controller: StubController = {
				snapshot: SNAPSHOT,
				isEligible: () => true,
				isStale: () => false,
				start: vi.fn((ctx: ExtensionContext) => {
					current = ctx;
					update(ctx);
				}),
				refresh: vi.fn(async () => {}),
				shutdown: vi.fn(),
				paint: () => {
					if (current) update(current);
				},
			};
			controllers.push(controller);
			return controller;
		},
		projectFooter: () => "Go left: 5h: 63%",
		pooling: {
			isService: (value: unknown): value is UpstreamMultiproviderService =>
				typeof (value as { onActiveAccountChanged?: unknown } | null)?.onActiveAccountChanged ===
				"function",
			setService: vi.fn(),
		},
	};
	return { bindings, controllers, readConfig };
}

void describe("OpenCode Go footer adapter", () => {
	void it("loads only on activation and writes only its own footer slot", async () => {
		const p = provider();
		const load = vi.fn(async () => p.bindings);
		const h = harness(load);

		await h.emit("session_start");
		expect(load).not.toHaveBeenCalled();

		await h.select("opencode-go");
		expect(load).toHaveBeenCalledTimes(1);
		expect(h.statuses.get("opencode-go-usage-footer")).toBe("Go left: 5h: 63%");
		expect(h.setWidget).not.toHaveBeenCalled();

		await h.emit("turn_end");
		expect(p.controllers[0].refresh).toHaveBeenCalledTimes(1);

		await h.select("other");
		expect(p.controllers[0].shutdown).toHaveBeenCalled();
		p.controllers[0].paint();
		expect(h.statuses.get("opencode-go-usage-footer")).toBeUndefined();

		await h.select("opencode-go");
		expect(p.controllers).toHaveLength(2);

		await h.emit("session_shutdown");
		expect(p.controllers[1].shutdown).toHaveBeenCalled();
	});

	void it("coalesces loading and ignores completion after shutdown", async () => {
		const p = provider();
		let resolve!: (bindings: ProviderBindings) => void;
		const load = vi.fn(
			() =>
				new Promise<ProviderBindings>((resolveLoad) => {
					resolve = resolveLoad;
				}),
		);
		const h = harness(load);

		const first = h.select("opencode-go");
		const second = h.select("opencode-go");
		expect(load).toHaveBeenCalledTimes(1);

		await h.emit("session_shutdown");
		resolve(p.bindings);
		await Promise.all([first, second]);

		expect(p.controllers).toHaveLength(0);
	});

	void it("fails closed once when loading is incompatible", async () => {
		const load = vi.fn(async () => {
			throw new Error("secret upstream detail");
		});
		const h = harness(load);

		await h.select("opencode-go");
		await h.emit("turn_end");
		await h.select("opencode-go");

		expect(load).toHaveBeenCalledTimes(1);
		expect(h.notify).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(h.notify.mock.calls)).not.toContain("secret upstream detail");
	});

	void it("refuses a second poller when native usage is enabled", async () => {
		const p = provider();
		p.readConfig.mockReturnValue({
			enabled: true,
			refreshIntervalMs: 60_000,
			showOnlyOnProvider: true,
			showResetTimes: true,
			glyphs: "auto",
			placement: "belowEditor",
		});
		const h = harness(async () => p.bindings);

		await h.select("opencode-go");

		expect(p.controllers).toHaveLength(0);
		expect(h.notify).toHaveBeenCalledTimes(1);
	});

	void it("seeds an early pooled service and restarts on account changes", async () => {
		const p = provider();
		const h = harness(async () => p.bindings);
		let changed: (() => void) | undefined;
		const unsubscribe = vi.fn();
		const service: UpstreamMultiproviderService = {
			onActiveAccountChanged: vi.fn((_providerId: string, callback: () => void) => {
				changed = callback;
				return unsubscribe;
			}),
		};

		h.service(service);
		await h.select("opencode-go");
		expect(p.bindings.pooling.setService).toHaveBeenCalledWith(service);

		changed?.();
		await vi.waitFor(() => expect(p.controllers).toHaveLength(2));
		expect(p.controllers[0].shutdown).toHaveBeenCalled();

		await h.emit("session_shutdown");
		expect(unsubscribe).toHaveBeenCalled();
	});
});
