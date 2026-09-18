import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

// Load the extension exactly the way pi does: jiti, with the SDK alias the CLI
// installs for extensions, against the real installed provider package. These
// checks fail (never skip) when the package or its internal modules move.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const requireFromPi = createRequire(join(piRoot, "package.json"));
const extensionPath = join(repoRoot, "extensions/opencode-go-usage.ts");

interface JitiLike {
	import: (path: string) => Promise<Record<string, any>>;
}

function createJitiLike(): JitiLike {
	const { createJiti } = requireFromPi("jiti") as {
		createJiti: (base: string, options?: Record<string, unknown>) => JitiLike;
	};
	return createJiti(join(piRoot, "dist/core/extensions/loader.js"), {
		moduleCache: false,
		alias: {
			"@earendil-works/pi-coding-agent": join(piRoot, "dist/index.js"),
			"@earendil-works/pi-tui": fileURLToPath(import.meta.resolve("@earendil-works/pi-tui")),
		},
	});
}

function createFakePi(): {
	pi: { on: (name: string, handler: () => unknown) => void; events: { on: () => () => void } };
	handlers: Map<string, (...args: any[]) => any>;
} {
	const handlers = new Map<string, (...args: any[]) => any>();
	return {
		handlers,
		pi: {
			on: (name, handler) => handlers.set(name, handler),
			events: { on: () => () => {} },
		},
	};
}

function createContext(statuses: Map<string, string | undefined>): Record<string, unknown> {
	return {
		mode: "tui",
		hasUI: true,
		model: { provider: "opencode-go" },
		modelRegistry: { getApiKeyForProvider: async () => "test-key" },
		ui: {
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
			setWidget: () => {},
			notify: () => {},
			theme: { fg: (_color: string, text: string) => text },
		},
	};
}

async function waitForStatus(statuses: Map<string, string | undefined>): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const line = statuses.get("opencode-go-usage-footer");
		if (line !== undefined) return line;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("footer status never appeared");
}

void describe("OpenCode Go footer adapter against the installed provider", () => {
	void it("loads the real modules and projects their snapshot", async () => {
		const extension = await createJitiLike().import(extensionPath);
		assert.equal(typeof extension.loadInstalledProvider, "function");

		const bindings = await extension.loadInstalledProvider();
		assert.equal(typeof bindings.createController, "function");
		assert.equal(typeof bindings.projectFooter, "function");
		assert.equal(typeof bindings.pooling.isService, "function");
		assert.equal(typeof bindings.pooling.setService, "function");

		const config = bindings.readConfig();
		assert.equal(typeof config.enabled, "boolean");
		assert.equal(typeof config.showResetTimes, "boolean");

		assert.equal(bindings.pooling.isService({}), false);
		assert.equal(
			bindings.pooling.isService({
				getActiveAccount: () => undefined,
				resolveActiveAccountAuth: () => undefined,
				onActiveAccountChanged: () => () => {},
			}),
			true,
		);

		const now = Date.now();
		const snapshot = {
			capturedAt: now,
			windows: [
				{
					key: "rolling",
					label: "5h",
					status: "ok",
					usedPercent: 37,
					remainingPercent: 63,
					resetsAt: now + 3_600_000,
				},
			],
			isLimited: false,
			bankedResets: null,
		};
		const theme = { fg: (_color: string, text: string) => text };
		assert.match(bindings.projectFooter(snapshot, config, false, theme), /^Go left: 5h: 63%/);
		assert.match(bindings.projectFooter(snapshot, config, true, theme), /stale$/);
	}, 30_000);

	void it("drives a real controller and renders its snapshot into the footer", async () => {
		const extension = await createJitiLike().import(extensionPath);
		const statuses = new Map<string, string | undefined>();
		const { pi, handlers } = createFakePi();
		extension.default(pi);

		const ctx = createContext(statuses);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					usage: {
						rolling: { status: "ok", percent: 37, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
						weekly: { status: "ok", percent: 41, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
						monthly: { status: "rate-limited", percent: 100, resetsAt: new Date(Date.now() + 2_592_000_000).toISOString() },
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as typeof fetch;

		try {
			await handlers.get("session_start")?.({}, ctx);
			const line = await waitForStatus(statuses);
			assert.match(line, /^Go left: 5h: 63%/);
			assert.match(line, /7d: 59%/);
			assert.match(line, /30d: 0%/);
		} finally {
			globalThis.fetch = originalFetch;
			handlers.get("session_shutdown")?.({}, ctx);
		}
	}, 30_000);
});
