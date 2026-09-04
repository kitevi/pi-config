import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
	SlashCommandInfo,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const WIDGET_ID = "skill-guide";
const DEFAULT_CONFIG_PATH = fileURLToPath(new URL("./skill-guide.json", import.meta.url));
const DEFAULT_MAX_SUMMARY_LENGTH = 30;
const WIDE_LAYOUT_MIN_WIDTH = 76;

export interface SkillGuideConfig {
	title: string;
	showOnStartup: boolean;
	hideOnPrompt: boolean;
	placement: "aboveEditor" | "belowEditor";
	maxSummaryLength: number;
	summaryOverrides: Record<string, string>;
}

export interface SkillGuideEntry {
	command: string;
	skill: string;
	summary: string;
}

type SkillGuideTheme = Pick<Theme, "bold" | "fg">;
type GuideContext = Pick<ExtensionContext, "hasUI" | "mode" | "ui">;
type ConfigLoader = () => SkillGuideConfig;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalBoolean(value: unknown, fallback: boolean, path: string): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
	return value;
}

function optionalString(value: unknown, fallback: string, path: string): string {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${path} must be a non-empty string`);
	}
	return value.trim();
}

export function parseSkillGuideConfig(value: unknown): SkillGuideConfig {
	if (!isRecord(value)) throw new Error("skill guide config must be an object");

	const placement = value.placement ?? "aboveEditor";
	if (placement !== "aboveEditor" && placement !== "belowEditor") {
		throw new Error('placement must be "aboveEditor" or "belowEditor"');
	}

	const maxSummaryLength = value.maxSummaryLength ?? DEFAULT_MAX_SUMMARY_LENGTH;
	if (!Number.isInteger(maxSummaryLength) || (maxSummaryLength as number) < 24) {
		throw new Error("maxSummaryLength must be an integer of at least 24");
	}

	const summaryOverrides: Record<string, string> = {};
	if (value.summaryOverrides !== undefined) {
		if (!isRecord(value.summaryOverrides)) {
			throw new Error("summaryOverrides must be an object");
		}

		for (const [skill, summary] of Object.entries(value.summaryOverrides)) {
			if (typeof summary !== "string" || summary.trim() === "") {
				throw new Error(`summaryOverrides.${skill} must be a non-empty string`);
			}
			summaryOverrides[skill] = summary.trim();
		}
	}

	return {
		title: optionalString(value.title, "Skill index", "title"),
		showOnStartup: optionalBoolean(value.showOnStartup, true, "showOnStartup"),
		hideOnPrompt: optionalBoolean(value.hideOnPrompt, true, "hideOnPrompt"),
		placement,
		maxSummaryLength: maxSummaryLength as number,
		summaryOverrides,
	};
}

export function loadSkillGuideConfig(path = DEFAULT_CONFIG_PATH): SkillGuideConfig {
	return parseSkillGuideConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function shortenSkillSummary(description: string | undefined, maxLength: number): string {
	const normalized = description?.replace(/\s+/g, " ").trim() || "No summary provided.";
	const sentenceEnd = normalized.search(/[.!?](?:\s|$)/);
	const firstSentence = sentenceEnd >= 0 ? normalized.slice(0, sentenceEnd + 1) : normalized;
	const candidate = firstSentence.length >= 20 ? firstSentence : normalized;

	if (candidate.length <= maxLength) return candidate;

	const slice = candidate.slice(0, Math.max(1, maxLength - 1));
	const lastSpace = slice.lastIndexOf(" ");
	const cutoff = lastSpace >= Math.floor(maxLength * 0.6) ? lastSpace : slice.length;
	return `${slice.slice(0, cutoff).trimEnd()}…`;
}

function baseSkillName(commandName: string): string {
	const withoutPrefix = commandName.startsWith("skill:") ? commandName.slice("skill:".length) : commandName;
	return withoutPrefix.replace(/:\d+$/, "");
}

export function collectSkillGuideEntries(
	commands: SlashCommandInfo[],
	config: SkillGuideConfig,
): SkillGuideEntry[] {
	return commands
		.filter((command) => command.source === "skill")
		.map((command): SkillGuideEntry => {
			const skill = baseSkillName(command.name);
			const invocationName = command.name.startsWith("skill:") ? command.name : `skill:${command.name}`;
			const override = config.summaryOverrides[command.name] ?? config.summaryOverrides[skill];
			return {
				command: `/${invocationName}`,
				skill,
				summary: shortenSkillSummary(override ?? command.description, config.maxSummaryLength),
			};
		})
		.sort((left, right) => left.command.localeCompare(right.command));
}

function renderWideEntry(entry: SkillGuideEntry, commandWidth: number, width: number, theme: SkillGuideTheme): string {
	const indent = "  ";
	const gap = "  ";
	const fittedCommand = truncateToWidth(entry.command, commandWidth, "…");
	const commandPadding = " ".repeat(Math.max(0, commandWidth - visibleWidth(fittedCommand)));
	const summaryWidth = Math.max(1, width - visibleWidth(indent) - commandWidth - visibleWidth(gap));
	const fittedSummary = truncateToWidth(entry.summary, summaryWidth, "…");
	return `${indent}${theme.fg("accent", fittedCommand)}${commandPadding}${gap}${theme.fg("muted", fittedSummary)}`;
}

function renderNarrowEntry(entry: SkillGuideEntry, width: number, theme: SkillGuideTheme): string[] {
	const command = truncateToWidth(entry.command, Math.max(1, width - 2), "…");
	const summary = truncateToWidth(entry.summary, Math.max(1, width - 4), "…");
	return [`  ${theme.fg("accent", command)}`, `    ${theme.fg("muted", summary)}`];
}

export function renderSkillGuide(
	entries: SkillGuideEntry[],
	config: SkillGuideConfig,
	width: number,
	theme: SkillGuideTheme,
): string[] {
	const safeWidth = Math.max(1, width);
	const title = `◆ ${config.title} · ${entries.length} loaded`;
	const lines = [truncateToWidth(theme.fg("accent", theme.bold(title)), safeWidth, "…")];

	if (safeWidth >= WIDE_LAYOUT_MIN_WIDTH) {
		const longestCommand = Math.max(0, ...entries.map((entry) => visibleWidth(entry.command)));
		const commandWidth = Math.min(longestCommand, Math.max(20, Math.floor(safeWidth * 0.48)));
		for (const entry of entries) {
			lines.push(renderWideEntry(entry, commandWidth, safeWidth, theme));
		}
	} else {
		for (const entry of entries) lines.push(...renderNarrowEntry(entry, safeWidth, theme));
	}

	lines.push("");
	const behavior = config.hideOnPrompt ? " · hides on next prompt" : "";
	const footer = `/skill-guide toggles · edit extensions/skill-guide.json${behavior}`;
	lines.push(truncateToWidth(theme.fg("dim", footer), safeWidth, "…"));
	return lines;
}

export function registerSkillGuide(pi: ExtensionAPI, loadConfig: ConfigLoader = loadSkillGuideConfig): void {
	let config: SkillGuideConfig | undefined;
	let visible = false;

	const hide = (ctx: GuideContext): void => {
		visible = false;
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(WIDGET_ID, undefined);
	};

	const show = (ctx: GuideContext, nextConfig: SkillGuideConfig): void => {
		if (ctx.mode !== "tui") return;
		// Live-collect: session_start fires before skill discovery finishes.
		ctx.ui.setWidget(
			WIDGET_ID,
			(_tui, theme) => ({
				render: (width) => renderSkillGuide(collectSkillGuideEntries(pi.getCommands(), nextConfig), nextConfig, width, theme),
				invalidate() {},
			}),
			{ placement: nextConfig.placement },
		);
		visible = true;
	};

	const reloadConfig = (ctx: GuideContext): SkillGuideConfig | undefined => {
		try {
			config = loadConfig();
			return config;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) ctx.ui.notify(`Skill guide config error: ${message}`, "error");
			return undefined;
		}
	};

	pi.on("session_start", async (event, ctx) => {
		visible = false;
		// Auto-show once: later starts bypass input-hide (slash commands).
		if (event.reason !== "startup") return;
		const nextConfig = reloadConfig(ctx);
		if (nextConfig?.showOnStartup) show(ctx, nextConfig);
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "interactive" && visible && config?.hideOnPrompt) hide(ctx);
		return { action: "continue" };
	});

	pi.registerCommand("skill-guide", {
		description: "Toggle the user-only list of loaded skills",
		handler: async (_args, ctx) => {
			if (visible) {
				hide(ctx);
				return;
			}

			const nextConfig = reloadConfig(ctx);
			if (nextConfig) show(ctx, nextConfig);
		},
	});
}

export default function skillGuideExtension(pi: ExtensionAPI): void {
	registerSkillGuide(pi);
}
