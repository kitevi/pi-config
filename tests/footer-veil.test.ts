import { assert } from "vitest";
import { afterEach, beforeEach, describe, it } from "vitest";
import { FooterComponent, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import footerVeilExtension from "../extensions/footer-veil.ts";
import {
	filterUsageStatuses,
	filterUsageWidgets,
	withVeiledExtensionStatuses,
	formatFooterTokenCount,
	injectDumbZoneIntoFooterLine,
	shouldShowDumbZone,
} from "../extensions/footer-veil.ts";

void describe("footer-veil dumb-zone footer marker", () => {
	void it("formats footer token counts like Pi's footer", () => {
		assert.strictEqual(formatFooterTokenCount(999), "999");
		assert.strictEqual(formatFooterTokenCount(1_001), "1.0k");
		assert.strictEqual(formatFooterTokenCount(9_999), "10.0k");
		assert.strictEqual(formatFooterTokenCount(128_000), "128k");
		assert.strictEqual(formatFooterTokenCount(1_250_000), "1.3M");
	});

	void it("only enters the dumb zone after 128k tokens", () => {
		assert.strictEqual(shouldShowDumbZone(undefined), false);
		assert.strictEqual(shouldShowDumbZone({ tokens: null }), false);
		assert.strictEqual(shouldShowDumbZone({ tokens: 128_000 }), false);
		assert.strictEqual(shouldShowDumbZone({ tokens: 128_001 }), true);
	});

	void it("inserts the marker inline after the context window without adding a row", () => {
		const line = "up24k dn3k 68.2%/200k                         model";
		const label = "dumb";
		const result = injectDumbZoneIntoFooterLine(line, 200_000, label, 80);
		assert.match(result, /\/200k dumb/);
		assert.match(result, /model$/);
		assert.strictEqual(result.split("\n").length, 1);
		assert.ok(visibleWidth(result) <= 80);
	});
});

function statusMap(...entries: Array<[string, string]>): Map<string, string> {
	return new Map(entries);
}

void describe("footer-veil usage status filter", () => {
	void it("passes the map through untouched when the veil is lifted", () => {
		const statuses = statusMap(
			["synthetic-usage", "week:82%"],
			["fabric-prewalk", "armed"],
		);
		assert.strictEqual(filterUsageStatuses(statuses, false), statuses);
	});

	void it("drops provider usage keys but keeps unrelated statuses while veiled", () => {
		const statuses = statusMap(
			["synthetic-usage", "week:82%"],
			["opencode-go-usage", "5h:10%"],
			["zro-session", "$1.20"],
			["zro-account", "Pro"],
			["hypercharm-session", "10 hc"],
			["hypercharm-account", "100 hc"],
			["neuralwatt-energy", "1.5J"],
			["neuralwatt-quota", "pro"],
			["neuralwatt-mcr", "MCR abc"],
			["fabric-prewalk", "armed"],
			["other-ext", "visible"],
		);
		const filtered = filterUsageStatuses(statuses, true);
		assert.deepStrictEqual(Array.from(filtered.keys()), ["fabric-prewalk", "other-ext"]);
		assert.strictEqual(filtered.get("fabric-prewalk"), "armed");
	});

	void it("filters Better OpenAI status without mutating its source", () => {
		const statuses = statusMap(["better-openai", "5h:90%"], ["fabric-prewalk", "armed"]);
		assert.deepStrictEqual([...filterUsageStatuses(statuses, true)], [["fabric-prewalk", "armed"]]);
		assert.strictEqual(statuses.get("better-openai"), "5h:90%");
		assert.strictEqual(filterUsageStatuses(statuses, false), statuses);
	});

	void it("returns the same map when nothing is veiled", () => {
		const statuses = statusMap(["fabric-prewalk", "armed"]);
		assert.strictEqual(filterUsageStatuses(statuses, true), statuses);
	});

	void it("returns an empty map when every status is a usage widget", () => {
		const statuses = statusMap(["synthetic-usage", "week:82%"]);
		assert.strictEqual(filterUsageStatuses(statuses, true).size, 0);
	});
});

void describe("footer-veil usage widget filter", () => {
	function widgetMap(...entries: Array<[string, unknown]>): Map<string, unknown> {
		return new Map(entries);
	}

	void it("passes the map through untouched when the veil is lifted", () => {
		const widgets = widgetMap(["hypercharm", { tag: "hc" }], ["fabric-prewalk", { tag: "armed" }]);
		assert.strictEqual(filterUsageWidgets(widgets, false), widgets);
	});

	void it("drops provider usage widget keys but keeps unrelated widgets while veiled", () => {
		const hypercharm = { tag: "hc" };
		const other = { tag: "other" };
		const widgets = widgetMap(
			["hypercharm", hypercharm],
			["zro", { tag: "zro" }],
			["neuralwatt", { tag: "nw" }],
			["other-ext", other],
		);
		const filtered = filterUsageWidgets(widgets, true);
		assert.deepStrictEqual(Array.from(filtered.keys()), ["other-ext"]);
		assert.strictEqual(filtered.get("other-ext"), other);
	});

	void it("returns the same map when nothing is veiled", () => {
		const widgets = widgetMap(["other-ext", { tag: "other" }]);
		assert.strictEqual(filterUsageWidgets(widgets, true), widgets);
	});
});

void describe("footer-veil render wrapper", () => {
	function fakeHost(statuses: Map<string, string>): {
		footerData: { statuses: Map<string, string>; getExtensionStatuses(): Map<string, string> };
	} {
		return {
			footerData: {
				statuses,
				getExtensionStatuses(this: { statuses: Map<string, string> }): Map<string, string> {
					return this.statuses;
				},
			},
		};
	}

	function fakePiRender(host: {
		footerData: { getExtensionStatuses(): ReadonlyMap<string, string> };
	}): string[] {
		return ["pwd", "stats", [...host.footerData.getExtensionStatuses().values()].join(" ")];
	}

	void it("renders the full status line when the veil is lifted", () => {
		const host = fakeHost(statusMap(["synthetic-usage", "week:82%"], ["fabric-prewalk", "armed"]));
		const before = host.footerData.getExtensionStatuses;
		const lines = withVeiledExtensionStatuses(host, false, () => fakePiRender(host));
		assert.deepStrictEqual(lines[2], "week:82% armed");
		assert.strictEqual(host.footerData.getExtensionStatuses, before);
	});

	void it("hides usage statuses from the render while veiled and restores afterwards", () => {
		const host = fakeHost(statusMap(["synthetic-usage", "week:82%"], ["fabric-prewalk", "armed"]));
		const before = host.footerData.getExtensionStatuses;
		const lines = withVeiledExtensionStatuses(host, true, () => fakePiRender(host));
		assert.deepStrictEqual(lines[2], "armed");
		assert.strictEqual(host.footerData.getExtensionStatuses, before);
	});

	void it("restores the original method when the render throws", () => {
		const host = fakeHost(statusMap(["synthetic-usage", "week:82%"]));
		const before = host.footerData.getExtensionStatuses;
		assert.throws(() =>
			withVeiledExtensionStatuses(host, true, () => {
				throw new Error("boom");
			}),
			/boom/,
		);
		assert.strictEqual(host.footerData.getExtensionStatuses, before);
	});

	void it("passes through and warns when the footer shape is unexpected", () => {
		let warnings = 0;
		const lines = withVeiledExtensionStatuses({ noFooterData: true }, true, () => ["only"], () => {
			warnings += 1;
		});
		assert.deepStrictEqual(lines, ["only"]);
		assert.strictEqual(warnings, 1);
	});

	void it("does not warn on unexpected shape when the veil is lifted", () => {
		let warnings = 0;
		withVeiledExtensionStatuses({ noFooterData: true }, false, () => ["only"], () => {
			warnings += 1;
		});
		assert.deepStrictEqual(["only"], ["only"]);
		assert.strictEqual(warnings, 0);
	});
});

void describe("footer-veil extension wiring", () => {
	const shutdowns: Array<() => Promise<void>> = [];
	function fakeUI(): {
		notices: Array<string>;
		notify(message: string): void;
		theme: { fg(_color: string, text: string): string };
	} {
		const notices: Array<string> = [];
		return {
			notices,
			notify(message: string) {
				notices.push(message);
			},
			theme: { fg: (_color: string, text: string) => text },
		};
	}

	function setup(commands = [{ name: "openai-usage-presentation", source: "extension" }]) {
		const ui = fakeUI();
		const sent: Array<{ content: string; options: { expandPromptTemplates?: boolean } }> = [];
		const shortcuts: Record<string, { handler: (ctx: never) => Promise<void> }> = {};
		const events: Record<string, Array<(event: never, ctx: never) => Promise<void>>> = {};
		const pi = {
			getCommands: () => commands,
			sendUserMessage: (content: string, options: { expandPromptTemplates?: boolean }) => {
				sent.push({ content, options });
			},
			registerShortcut: (id: string, def: { handler: (ctx: never) => Promise<void> }) => {
				shortcuts[id] = def;
			},
			on: (event: string, handler: (ev: never, ctx: never) => Promise<void>) => {
				(events[event] ??= []).push(handler);
			},
		};
		footerVeilExtension(pi as never);
		const ctx = { hasUI: true, cwd: "/work", ui };
		shutdowns.push(async () => {
			for (const handler of events["session_shutdown"] ?? []) await handler(undefined as never, ctx as never);
		});
		return { shortcuts, events, ctx, ui, sent, commands };
	}

	async function sessionStart(s: ReturnType<typeof setup>): Promise<void> {
		for (const handler of s.events["session_start"] ?? []) await handler(undefined as never, s.ctx as never);
	}

	async function resourcesDiscover(s: ReturnType<typeof setup>): Promise<void> {
		for (const handler of s.events["resources_discover"] ?? []) await handler(undefined as never, s.ctx as never);
	}

	let savedRender: unknown;
	let savedRenderWidgetContainer: unknown;
	beforeEach(() => {
		savedRender = FooterComponent.prototype.render;
		savedRenderWidgetContainer = (InteractiveMode.prototype as unknown as { renderWidgetContainer: unknown })
			.renderWidgetContainer;
	});
	afterEach(async () => {
		try {
			for (const shutdown of shutdowns.splice(0)) await shutdown();
		} finally {
			FooterComponent.prototype.render = savedRender as typeof FooterComponent.prototype.render;
			(InteractiveMode.prototype as unknown as { renderWidgetContainer: unknown }).renderWidgetContainer =
				savedRenderWidgetContainer;
		}
	});

	void it("synchronizes hidden presentation after session startup", async () => {
		const s = setup();
		await sessionStart(s);
		assert.deepStrictEqual(s.sent, []);
		await resourcesDiscover(s);
		assert.deepStrictEqual(s.sent, [{
			content: "/openai-usage-presentation hide",
			options: { expandPromptTemplates: true },
		}]);
	});

	void it("sends explicit show and hide on consecutive shortcut presses", async () => {
		const s = setup();
		await sessionStart(s);
		await s.shortcuts["ctrl+p"].handler(s.ctx as never);
		await s.shortcuts["ctrl+p"].handler(s.ctx as never);
		assert.deepStrictEqual(s.sent, [
			{ content: "/openai-usage-presentation show", options: { expandPromptTemplates: true } },
			{ content: "/openai-usage-presentation hide", options: { expandPromptTemplates: true } },
		]);
	});

	void it("warns once per session for an unavailable OpenAI command without sending a prompt", async () => {
		const s = setup([]);
		await sessionStart(s);
		await resourcesDiscover(s);
		await s.shortcuts["ctrl+p"].handler(s.ctx as never);
		await s.shortcuts["ctrl+p"].handler(s.ctx as never);
		assert.deepStrictEqual(s.sent, []);
		assert.strictEqual(s.ui.notices.filter((n) => n.includes("OpenAI presentation unavailable")).length, 1);
		await sessionStart(s);
		await resourcesDiscover(s);
		assert.strictEqual(s.ui.notices.filter((n) => n.includes("OpenAI presentation unavailable")).length, 2);
	});

	void it.each(["prompt", "skill"])("does not dispatch a same-named %s as a command", async (source) => {
		const s = setup([{ name: "openai-usage-presentation", source }]);
		await sessionStart(s);
		await resourcesDiscover(s);
		await s.shortcuts["ctrl+p"].handler(s.ctx as never);
		assert.deepStrictEqual(s.sent, []);
	});

	void it.each(["before", "after"])("synchronizes after the fork resets, with the fork loaded %s the veil", async (order) => {
		const s = setup();
		let reset = false;
		const forkStart = async () => {
			assert.deepStrictEqual(s.sent, []);
			reset = true;
		};
		if (order === "before") s.events["session_start"].unshift(forkStart);
		else s.events["session_start"].push(forkStart);
		await sessionStart(s);
		assert.strictEqual(reset, true);
		await resourcesDiscover(s);
		assert.strictEqual(s.sent.at(-1)?.content, "/openai-usage-presentation hide");
	});

	void it.each(["reload", "new", "resume", "fork"])("resynchronizes hidden presentation after %s", async (reason) => {
		const s = setup();
		await sessionStart(s);
		await s.shortcuts["ctrl+p"].handler(s.ctx as never);
		for (const handler of s.events["session_start"]) await handler({ reason } as never, s.ctx as never);
		await resourcesDiscover(s);
		assert.strictEqual(s.sent.at(-1)?.content, "/openai-usage-presentation hide");
	});

	void it("synchronizes the current state rather than a stale startup value", async () => {
		const s = setup();
		await sessionStart(s);
		await s.shortcuts["ctrl+p"].handler(s.ctx as never);
		await resourcesDiscover(s);
		assert.strictEqual(s.sent.at(-1)?.content, "/openai-usage-presentation show");
	});

	void it("does not dispatch commands or warnings without a UI", async () => {
		const s = setup([]);
		s.ctx.hasUI = false;
		await sessionStart(s);
		await resourcesDiscover(s);
		await s.shortcuts["ctrl+p"].handler(s.ctx as never);
		assert.deepStrictEqual(s.sent, []);
		assert.deepStrictEqual(s.ui.notices, []);
	});

	void it("restores the built-in footer on shutdown without sending show", async () => {
		const s = setup();
		const originalRender = FooterComponent.prototype.render;
		await sessionStart(s);
		await resourcesDiscover(s);
		const sent = [...s.sent];
		for (const handler of s.events["session_shutdown"]) await handler(undefined as never, s.ctx as never);
		assert.strictEqual(FooterComponent.prototype.render, originalRender);
		assert.deepStrictEqual(s.sent, sent);
	});

	void it("notifies shown on first ctrl+p toggle", async () => {
		const s = setup();
		await sessionStart(s);
		await s.shortcuts["ctrl+p"].handler(s.ctx as never);
		assert.ok(s.ui.notices.some((n) => n.includes("shown")));
	});

	void it("notifies hidden on second toggle", async () => {
		const s = setup();
		await sessionStart(s);
		await s.shortcuts["ctrl+p"].handler(s.ctx as never);
		await s.shortcuts["ctrl+p"].handler(s.ctx as never);
		assert.ok(s.ui.notices.some((n) => n.includes("hidden")));
	});

	void it("starts a session without a widget surface", async () => {
		const s = setup();
		await sessionStart(s);
		await s.shortcuts["ctrl+p"].handler(s.ctx as never);
		assert.ok(s.ui.notices.some((n) => n.includes("shown")));
	});

	void describe("widget veiling", () => {
		type RenderWidgetContainerFn = (
			container: { children: Array<unknown>; clear(): void; addChild(c: unknown): void },
			widgets: ReadonlyMap<string, unknown>,
			spacerWhenEmpty: boolean,
			leadingSpacer: boolean,
		) => void;

		function protoRenderWidgetContainer(): RenderWidgetContainerFn {
			return (InteractiveMode.prototype as unknown as { renderWidgetContainer: RenderWidgetContainerFn })
				.renderWidgetContainer;
		}

		function fakeContainer(): { children: Array<unknown>; clear(): void; addChild(c: unknown): void } {
			const children: Array<unknown> = [];
			return {
				children,
				clear() {
					children.length = 0;
				},
				addChild(c: unknown) {
					children.push(c);
				},
			};
		}

		void it("patches the widget container render on session start and restores it on shutdown", async () => {
			const s = setup();
			const original = protoRenderWidgetContainer();
			await sessionStart(s);
			assert.notStrictEqual(protoRenderWidgetContainer(), original);
			for (const handler of s.events["session_shutdown"]) await handler(undefined as never, s.ctx as never);
			assert.strictEqual(protoRenderWidgetContainer(), original);
		});

		void it("hides usage widgets while veiled and keeps unrelated widgets", async () => {
			const s = setup();
			await sessionStart(s);
			const container = fakeContainer();
			const other = { tag: "other" };
			protoRenderWidgetContainer().call(
				{ renderWidgets() {} },
				container,
				new Map([
					["hypercharm", { tag: "hc" }],
					["other-ext", other],
				]),
				false,
				false,
			);
			assert.deepStrictEqual(container.children, [other]);
		});

		void it("reveals usage widgets after ctrl+p and refreshes the live host's containers", async () => {
			const s = setup();
			await sessionStart(s);
			let refreshes = 0;
			const host = {
				renderWidgets() {
					refreshes += 1;
				},
			};
			const hypercharm = { tag: "hc" };
			const widgets = () => new Map<string, unknown>([["hypercharm", hypercharm]]);
			const container = fakeContainer();
			protoRenderWidgetContainer().call(host, container, widgets(), false, false);
			assert.deepStrictEqual(container.children, []);
			await s.shortcuts["ctrl+p"].handler(s.ctx as never);
			assert.strictEqual(refreshes, 1);
			protoRenderWidgetContainer().call(host, container, widgets(), false, false);
			assert.deepStrictEqual(container.children, [hypercharm]);
			await s.shortcuts["ctrl+p"].handler(s.ctx as never);
			assert.strictEqual(refreshes, 2);
			protoRenderWidgetContainer().call(host, container, widgets(), false, false);
			assert.deepStrictEqual(container.children, []);
		});

		void it("warns once when the widget surface is missing", async () => {
			const proto = InteractiveMode.prototype as unknown as { renderWidgetContainer: unknown };
			const original = proto.renderWidgetContainer;
			proto.renderWidgetContainer = undefined;
			try {
				const s = setup();
				await sessionStart(s);
				assert.ok(s.ui.notices.some((n) => n.includes("widget surface")));
			} finally {
				proto.renderWidgetContainer = original;
			}
		});
	});
});
