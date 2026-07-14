import assert from "node:assert";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	collectSkillGuideEntries,
	loadSkillGuideConfig,
	parseSkillGuideConfig,
	registerSkillGuide,
	renderSkillGuide,
	shortenSkillSummary,
	type SkillGuideConfig,
} from "../extensions/skill-guide.ts";

const plainTheme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
};

const config: SkillGuideConfig = {
	title: "Skill index",
	showOnStartup: true,
	hideOnPrompt: true,
	placement: "aboveEditor",
	maxSummaryLength: 30,
	summaryOverrides: {
		"code-review": "Review a diff vs its spec.",
	},
};

const commands = [
	{
		name: "skill:improve-codebase-architecture",
		description: "Scan a codebase for deepening opportunities, then grill through one.",
		source: "skill",
		sourceInfo: {},
	},
	{
		name: "other-command",
		description: "Not a skill",
		source: "extension",
		sourceInfo: {},
	},
	{
		name: "skill:code-review",
		description: "A deliberately long upstream description that should be overridden.",
		source: "skill",
		sourceInfo: {},
	},
] as never[];

void describe("skill guide config", () => {
	void it("applies defaults and accepts summary overrides", () => {
		const parsed = parseSkillGuideConfig({
			summaryOverrides: { "code-review": "Review a diff." },
		});

		assert.strictEqual(parsed.title, "Skill index");
		assert.strictEqual(parsed.showOnStartup, true);
		assert.strictEqual(parsed.hideOnPrompt, true);
		assert.strictEqual(parsed.placement, "aboveEditor");
		assert.strictEqual(parsed.maxSummaryLength, 30);
		assert.strictEqual(parsed.summaryOverrides["code-review"], "Review a diff.");
	});

	void it("keeps every configured summary within the display budget", () => {
		const configured = loadSkillGuideConfig(
			fileURLToPath(new URL("../extensions/skill-guide.json", import.meta.url)),
		);

		assert.strictEqual(configured.maxSummaryLength, 30);
		for (const [skill, summary] of Object.entries(configured.summaryOverrides)) {
			assert.ok(summary.length <= 30, `${skill} summary is ${summary.length} characters`);
		}
	});

	void it("rejects malformed display settings", () => {
		assert.throws(() => parseSkillGuideConfig({ placement: "sidebar" }), /placement/);
		assert.throws(() => parseSkillGuideConfig({ maxSummaryLength: 12 }), /at least 24/);
		assert.throws(() => parseSkillGuideConfig({ summaryOverrides: [] }), /must be an object/);
	});
});

void describe("skill guide entries", () => {
	void it("includes every skill command, sorts it, and uses configured overrides", () => {
		const entries = collectSkillGuideEntries(commands, config);

		assert.deepStrictEqual(
			entries.map((entry) => entry.command),
			["/skill:code-review", "/skill:improve-codebase-architecture"],
		);
		assert.strictEqual(entries[0]?.summary, "Review a diff vs its spec.");
		assert.strictEqual(entries[1]?.summary, "Scan a codebase for…");
	});

	void it("shortens long descriptions without cutting the final word in half", () => {
		const summary = shortenSkillSummary(
			"This description is intentionally much longer than the configured summary budget and keeps going.",
			48,
		);

		assert.ok(summary.endsWith("…"));
		assert.ok(summary.length <= 48);
		assert.doesNotMatch(summary, /configur…$/);
	});

	void it("never renders a line wider than the terminal", () => {
		const entries = collectSkillGuideEntries(commands, config);
		for (const width of [52, 100]) {
			const lines = renderSkillGuide(entries, config, width, plainTheme as never);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
	});
});

void describe("skill guide extension", () => {
	void it("hides after every prompt when reopened", async () => {
		const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
		const widgetCalls: Array<{ content: unknown; options?: unknown }> = [];
		const notifications: string[] = [];
		let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;

		const pi = {
			on(event: string, handler: (event: any, ctx: any) => any) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerCommand(_name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
				commandHandler = command.handler;
			},
			getCommands: () => commands,
		};
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				setWidget(_key: string, content: unknown, options?: unknown) {
					widgetCalls.push({ content, options });
				},
				notify(message: string) {
					notifications.push(message);
				},
			},
		};

		registerSkillGuide(pi as never, () => config);
		await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);

		assert.strictEqual(widgetCalls.length, 1);
		assert.strictEqual(typeof widgetCalls[0]?.content, "function");
		assert.deepStrictEqual(widgetCalls[0]?.options, { placement: "aboveEditor" });
		assert.deepStrictEqual(notifications, []);

		const result = await handlers.get("input")?.[0]?.({ source: "interactive", text: "hello" }, ctx);
		assert.deepStrictEqual(result, { action: "continue" });
		assert.strictEqual(widgetCalls.at(-1)?.content, undefined);

		await commandHandler?.("", ctx);
		assert.strictEqual(typeof widgetCalls.at(-1)?.content, "function");

		await handlers.get("input")?.[0]?.({ source: "interactive", text: "again" }, ctx);
		assert.strictEqual(widgetCalls.at(-1)?.content, undefined);
		assert.strictEqual(widgetCalls.length, 4);
	});
});
