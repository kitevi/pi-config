import { strict as assert } from "node:assert";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import type { ProviderBindings, UpstreamController } from "../extensions/opencode-go-usage.ts";

type AdapterModule = typeof import("../extensions/opencode-go-usage.ts");
type ControllerModule = {
	UsageController: new (...args: Parameters<ProviderBindings["createController"]>) => UpstreamController;
};
interface JitiLike {
	import<T>(path: string): Promise<T>;
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const requireFromPi = createRequire(join(piRoot, "package.json"));
const installedNpm = join(getAgentDir(), "npm");
const requireFromAgent = createRequire(join(installedNpm, "noop.js"));
const providerRoot = dirname(requireFromAgent.resolve("pi-opencode-go-provider/package.json"));
let agentDir: string;

function createJitiLike(): JitiLike {
	const { createJiti } = requireFromPi("jiti") as {
		createJiti: (base: string, options: Record<string, unknown>) => JitiLike;
	};
	return createJiti(join(piRoot, "dist/core/extensions/loader.js"), {
		moduleCache: false,
		alias: { "@earendil-works/pi-coding-agent": join(piRoot, "dist/index.js") },
	});
}

beforeEach(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "pi-opencode-usage-"));
	await symlink(installedNpm, join(agentDir, "npm"), "dir");
	await writeFile(join(agentDir, "opencode-go-provider.json"), JSON.stringify({
		usage: { enabled: false, refreshIntervalMs: 60_000, showResetTimes: true },
	}));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("OPENCODE_GO_USAGE", undefined);
	vi.stubEnv("OPENCODE_GO_USAGE_INTERVAL_MS", undefined);
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await rm(agentDir, { recursive: true, force: true });
});

async function adapter() {
	const jiti = createJitiLike();
	const extension = await jiti.import<AdapterModule>(join(repoRoot, "extensions/opencode-go-usage.ts"));
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
			void handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	extension.default(pi);
	const statuses = new Map<string, string | undefined>();
	const setWidget = vi.fn();
	const notify = vi.fn();
	const getApiKeyForProvider = vi.fn(async (_provider: string) => "test-key");
	const ctx = {
		mode: "tui",
		hasUI: true,
		model: { provider: "opencode-go" },
		modelRegistry: { getApiKeyForProvider },
		ui: {
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
			setWidget,
			notify,
		},
	} as unknown as ExtensionContext;
	return {
		jiti, extension, ctx, statuses, setWidget, notify, getApiKeyForProvider,
		emit: async (name: string) => handlers.get(name)?.({}, ctx),
		line: () => statuses.get(extension.FOOTER_STATUS_KEY),
	};
}

function usageResponse(): Response {
	return new Response(JSON.stringify({ usage: {
		rolling: { status: "ok", percent: 37, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
		weekly: { status: "ok", percent: 41, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
		monthly: { status: "rate-limited", percent: 100, resetsAt: new Date(Date.now() + 2_592_000_000).toISOString() },
	} }), { status: 200, headers: { "content-type": "application/json" } });
}

void describe("OpenCode Go footer against the installed provider", () => {
	void it("uses the single account and runs one poller while native usage is disabled", async () => {
		const h = await adapter();
		const bindings = await h.extension.loadInstalledProvider();
		assert.equal(bindings.readConfig().enabled, false);
		const { UsageController } = await h.jiti.import<ControllerModule>(join(providerRoot, "usage-controller.ts"));
		const native = new UsageController(bindings.readConfig, () => {});
		const fetch = vi.fn(async () => usageResponse());
		vi.stubGlobal("fetch", fetch);
		const intervals = vi.spyOn(globalThis, "setInterval");
		const clearInterval = vi.spyOn(globalThis, "clearInterval");
		try {
			native.start(h.ctx);
			await native.refresh(h.ctx);
			assert.equal(fetch.mock.calls.length, 0);
			assert.equal(intervals.mock.calls.length, 0);

			await h.emit("session_start");
			await vi.waitFor(() => assert.match(h.line() ?? "", /^Go left: 5h: 63%/));
			assert.match(h.line()!, /7d: 59%/);
			assert.match(h.line()!, /30d: 0%/);
			assert.match(h.line()!, /^Go left: 5h: 63% ↺ [^·]+ · 7d: 59% ↺ [^·]+ · 30d: 0% ↺ [^·]+$/);
			assert.equal(fetch.mock.calls.length, 1);
			assert.equal(intervals.mock.calls.length, 1);
			assert.equal(h.setWidget.mock.calls.length, 0);
			assert.equal(h.notify.mock.calls.length, 0);
			assert.deepEqual(h.getApiKeyForProvider.mock.calls, [["opencode-go"]]);

			await h.emit("turn_end");
			await native.refresh(h.ctx);
			assert.equal(fetch.mock.calls.length, 1);
			h.ctx.model = { provider: "other" } as ExtensionContext["model"];
			await h.emit("model_select");
			assert.equal(h.line(), undefined);
			assert.equal(clearInterval.mock.calls.length, 1);
		} finally {
			await h.emit("session_shutdown");
			native.shutdown();
		}
	}, 30_000);

	void it("keeps the last budgets marked stale when a subsequent usage request fails", async () => {
		const h = await adapter();
		const fetch = vi.fn()
			.mockResolvedValueOnce(usageResponse())
			.mockResolvedValue(new Response("unavailable", { status: 503 }));
		vi.stubGlobal("fetch", fetch);
		try {
			await h.emit("session_start");
			await vi.waitFor(() => assert.match(h.line() ?? "", /^Go left: 5h: 63%/));
			vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
			await h.emit("turn_end");
			await vi.waitFor(() => assert.match(h.line() ?? "", /stale$/));
			assert.equal(fetch.mock.calls.length, 2);
			assert.match(h.line()!, /^Go left: 5h: 63%/);
		} finally {
			await h.emit("session_shutdown");
		}
	}, 30_000);
});
