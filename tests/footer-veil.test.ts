import { assert } from "vitest";
import { afterEach, beforeEach, describe, it } from "vitest";
import { FooterComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import footerVeilExtension from "../extensions/footer-veil.ts";
import {
	filterUsageStatuses,
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

	void it("returns the same map when nothing is veiled", () => {
		const statuses = statusMap(["fabric-prewalk", "armed"]);
		assert.strictEqual(filterUsageStatuses(statuses, true), statuses);
	});

	void it("returns an empty map when every status is a usage widget", () => {
		const statuses = statusMap(["synthetic-usage", "week:82%"]);
		assert.strictEqual(filterUsageStatuses(statuses, true).size, 0);
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

	function setup() {
		const ui = fakeUI();
		const shortcuts: Record<string, { handler: (ctx: never) => Promise<void> }> = {};
		const events: Record<string, Array<(event: never, ctx: never) => Promise<void>>> = {};
		const pi = {
			registerShortcut: (id: string, def: { handler: (ctx: never) => Promise<void> }) => {
				shortcuts[id] = def;
			},
			on: (event: string, handler: (ev: never, ctx: never) => Promise<void>) => {
				(events[event] ??= []).push(handler);
			},
		};
		footerVeilExtension(pi as never);
		const ctx = { hasUI: true as const, cwd: "/work", ui };
		return { shortcuts, events, ctx, ui };
	}

	async function sessionStart(s: ReturnType<typeof setup>): Promise<void> {
		for (const handler of s.events["session_start"] ?? []) await handler(undefined as never, s.ctx as never);
	}

	let savedRender: unknown;
	beforeEach(() => {
		savedRender = FooterComponent.prototype.render;
	});
	afterEach(() => {
		FooterComponent.prototype.render = savedRender as typeof FooterComponent.prototype.render;
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
});
