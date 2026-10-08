import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createOpenCodeGoUsageExtension,
	type ProviderBindings,
	type UpstreamController,
	type UpstreamUsageConfig,
} from "../extensions/opencode-go-usage.ts";

interface StubController extends UpstreamController {
	line: ReturnType<typeof vi.fn<UpstreamController["line"]>>;
	paint(): void;
}

function harness(load: () => Promise<ProviderBindings>, hasUI = true) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const statuses = new Map<string, string | undefined>();
	const notify = vi.fn();
	const setWidget = vi.fn();
	const ctx = {
		mode: "tui",
		hasUI,
		model: { provider: "other" },
		ui: {
			setStatus: (key: string, text: string | undefined) => void statuses.set(key, text),
			setWidget,
			notify,
		},
	} as unknown as ExtensionContext;
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
			void handlers.set(name, handler),
	} as unknown as ExtensionAPI;

	createOpenCodeGoUsageExtension({ loadProvider: load })(pi);
	return {
		ctx, statuses, notify, setWidget,
		emit: async (name: string) => handlers.get(name)?.({}, ctx),
		select: async (provider: string) => {
			ctx.model = { provider } as ExtensionContext["model"];
			await handlers.get("model_select")?.({}, ctx);
		},
	};
}

function provider() {
	const controllers: StubController[] = [];
	const readConfig = vi.fn((): UpstreamUsageConfig => ({ enabled: false, showOnlyOnProvider: true }));
	const bindings: ProviderBindings = {
		readConfig,
		createController: (getConfig, update) => {
			expect(getConfig().enabled).toBe(true);
			expect(getConfig().showOnlyOnProvider).toBe(true);
			let current: ExtensionContext | undefined;
			const controller: StubController = {
				line: vi.fn<UpstreamController["line"]>(() => "Usage: 5h: 63%"),
				start: vi.fn((ctx: ExtensionContext) => {
					current = ctx;
					update(ctx);
				}),
				refresh: vi.fn(async (ctx: ExtensionContext) => update(ctx)),
				shutdown: vi.fn(),
				paint: () => { if (current) update(current); },
			};
			controllers.push(controller);
			return controller;
		},
	};
	return { bindings, controllers, readConfig };
}

void describe("OpenCode Go footer adapter", () => {
	void it("places each reset countdown directly after its percentage", async () => {
		const p = provider();
		const h = harness(async () => p.bindings);
		await h.select("opencode-go");
		p.controllers[0]!.line.mockReturnValue(
			"Usage: 5h: 100% · 7d: 100% · 30d: 100% · 5h ↺ 3h54m · 7d ↺ 3d3h · 30d ↺ 30d22h",
		);
		p.controllers[0]!.paint();
		expect(h.statuses.get("opencode-go-usage-footer")).toBe(
			"Go left: 5h: 100% ↺ 3h54m · 7d: 100% ↺ 3d3h · 30d: 100% ↺ 30d22h",
		);
	});

	void it.each([
		["a single window", "Usage: 5h: 100% · ↺ 3h54m", "Go left: 5h: 100% ↺ 3h54m"],
		["hidden resets", "Usage: 5h: 100% · 7d: 99%", "Go left: 5h: 100% · 7d: 99%"],
		[
			"partial resets and suffixes",
			"Usage: 5h: 63% · 7d: 59% · 5h ↺ 1h · 2 banked resets · stale",
			"Go left: 5h: 63% ↺ 1h · 7d: 59% · 2 banked resets · stale",
		],
		[
			"unmatched reset text",
			"Usage: 5h: 63% · 8d ↺ 2d",
			"Go left: 5h: 63% · 8d ↺ 2d",
		],
	])("preserves %s when arranging reset countdowns", async (_name, input, expected) => {
		const p = provider();
		const h = harness(async () => p.bindings);
		await h.select("opencode-go");
		p.controllers[0]!.line.mockReturnValue(input);
		p.controllers[0]!.paint();
		expect(h.statuses.get("opencode-go-usage-footer")).toBe(expected);
	});

	void it("loads only on activation and writes only its own footer slot", async () => {
		const p = provider();
		const load = vi.fn(async () => p.bindings);
		const h = harness(load);
		h.statuses.set("another-extension", "keep me");

		await h.emit("session_start");
		expect(load).not.toHaveBeenCalled();
		await h.select("opencode-go");
		expect(load).toHaveBeenCalledTimes(1);
		expect(h.statuses.get("opencode-go-usage-footer")).toBe("Go left: 5h: 63%");
		expect(h.setWidget).not.toHaveBeenCalled();
		await h.emit("turn_end");
		expect(p.controllers[0]?.refresh).toHaveBeenCalledTimes(1);

		await h.select("other");
		expect(p.controllers[0]?.shutdown).toHaveBeenCalledTimes(1);
		p.controllers[0]?.paint();
		expect(h.statuses.get("opencode-go-usage-footer")).toBeUndefined();
		expect(h.statuses.get("another-extension")).toBe("keep me");
		await h.select("opencode-go");
		expect(p.controllers).toHaveLength(2);
		await h.emit("session_shutdown");
		expect(p.controllers[1]?.shutdown).toHaveBeenCalledTimes(1);
	});

	void it("refreshes in the background without delaying turn completion", async () => {
		const p = provider();
		const h = harness(async () => p.bindings);
		await h.select("opencode-go");
		let resolve!: () => void;
		p.controllers[0]!.refresh = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
		let completed = false;
		const turn = h.emit("turn_end").then(() => { completed = true; });
		try {
			await new Promise<void>((done) => setImmediate(done));
			expect(completed).toBe(true);
		} finally {
			resolve();
			await turn;
		}
	});

	void it("does not load the provider without a UI", async () => {
		const load = vi.fn(async () => provider().bindings);
		const h = harness(load, false);
		await h.select("opencode-go");
		expect(load).not.toHaveBeenCalled();
	});

	void it("activates when switched away and back while the provider is loading", async () => {
		const p = provider();
		let resolve!: (bindings: ProviderBindings) => void;
		const pending = new Promise<ProviderBindings>((resolveLoad) => { resolve = resolveLoad; });
		const h = harness(() => pending);
		const first = h.select("opencode-go");
		await h.select("other");
		const second = h.select("opencode-go");
		resolve(p.bindings);
		await Promise.all([first, second]);
		expect(p.controllers).toHaveLength(1);
		expect(h.statuses.get("opencode-go-usage-footer")).toBe("Go left: 5h: 63%");
	});

	void it("coalesces loading and ignores completion after shutdown", async () => {
		const p = provider();
		let resolve!: (bindings: ProviderBindings) => void;
		const load = vi.fn(() => new Promise<ProviderBindings>((resolveLoad) => { resolve = resolveLoad; }));
		const h = harness(load);
		const first = h.select("opencode-go");
		const second = h.select("opencode-go");
		expect(load).toHaveBeenCalledTimes(1);
		await h.emit("session_shutdown");
		resolve(p.bindings);
		await Promise.all([first, second]);
		expect(p.controllers).toHaveLength(0);
	});

	void it("replaces the controller on session start and ignores its late repaint", async () => {
		const p = provider();
		const h = harness(async () => p.bindings);
		await h.select("opencode-go");
		const previous = p.controllers[0]!;
		previous.line.mockReturnValue("Usage: obsolete");

		await h.emit("session_start");
		expect(previous.shutdown).toHaveBeenCalledTimes(1);
		expect(p.controllers).toHaveLength(2);
		previous.paint();
		expect(previous.line).toHaveBeenCalledTimes(1);
		expect(h.statuses.get("opencode-go-usage-footer")).toBe("Go left: 5h: 63%");
		await h.emit("session_shutdown");
	});

	void it("clears the footer when the upstream controller has no display line", async () => {
		const p = provider();
		const h = harness(async () => p.bindings);
		await h.select("opencode-go");
		p.controllers[0]!.line.mockReturnValue(undefined);
		p.controllers[0]!.paint();
		expect(h.statuses.get("opencode-go-usage-footer")).toBeUndefined();
	});

	void it("fails closed once when loading is incompatible", async () => {
		const load = vi.fn(async () => { throw new Error("secret upstream detail"); });
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
		p.readConfig.mockReturnValue({ enabled: true, showOnlyOnProvider: true });
		const h = harness(async () => p.bindings);
		await h.select("opencode-go");
		expect(p.controllers).toHaveLength(0);
		expect(h.notify).toHaveBeenCalledTimes(1);
	});
});
