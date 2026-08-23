import { assert } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";

interface ThemeJson {
	$schema: string;
	name: string;
	vars: Record<string, string | number>;
	colors: Record<string, string | number>;
	export: Record<string, string | number>;
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const expectedSchema =
	"https://raw.githubusercontent.com/earendil-works/pi/1eee081e29c1323c40b98db11d0a62b919831881/packages/coding-agent/src/modes/interactive/theme/theme-schema.json";

const expectedColors = {
	light: {
		accent: "#0969da",
		border: "#d1d9e0",
		borderAccent: "#0969da",
		borderMuted: "#dfe4e9",
		success: "#0969da",
		error: "#bc4c00",
		warning: "#9a6700",
		muted: "#59636e",
		dim: "#818b98",
		text: "#1f2328",
		thinkingText: "#59636e",
		selectedBg: "#ddf4ff",
		scrollbarThumb: "#818b98",
		userMessageBg: "#f6f8fa",
		userMessageText: "#1f2328",
		customMessageBg: "#f6f8fa",
		customMessageText: "#1f2328",
		customMessageLabel: "#0969da",
		toolPendingBg: "#f6f8fa",
		toolSuccessBg: "#ddf4ff",
		toolErrorBg: "#fff1e5",
		toolTitle: "#0969da",
		toolOutput: "#59636e",
		mdHeading: "#0550ae",
		mdLink: "#0969da",
		mdLinkUrl: "#59636e",
		mdCode: "#0550ae",
		mdCodeBlock: "#1f2328",
		mdCodeBlockBorder: "#d1d9e0",
		mdQuote: "#59636e",
		mdQuoteBorder: "#d1d9e0",
		mdHr: "#d1d9e0",
		mdListBullet: "#0969da",
		toolDiffAdded: "#0969da",
		toolDiffRemoved: "#bc4c00",
		toolDiffContext: "#59636e",
		syntaxComment: "#59636e",
		syntaxKeyword: "#bc4c00",
		syntaxFunction: "#8250df",
		syntaxVariable: "#953800",
		syntaxString: "#0a3069",
		syntaxNumber: "#0550ae",
		syntaxType: "#6639ba",
		syntaxOperator: "#1f2328",
		syntaxPunctuation: "#59636e",
		thinkingOff: "#d1d9e0",
		thinkingMinimal: "#818b98",
		thinkingLow: "#0969da",
		thinkingMedium: "#0550ae",
		thinkingHigh: "#033d8b",
		thinkingXhigh: "#0a3069",
		thinkingMax: "#002155",
		bashMode: "#9a6700",
	},
	dark: {
		accent: "#4493f8",
		border: "#3d444d",
		borderAccent: "#1f6feb",
		borderMuted: "#2f353d",
		success: "#58a6ff",
		error: "#f0883e",
		warning: "#d29922",
		muted: "#9198a1",
		dim: "#656c76",
		text: "#f0f6fc",
		thinkingText: "#9198a1",
		selectedBg: "#111d2e",
		scrollbarThumb: "#656c76",
		userMessageBg: "#151b23",
		userMessageText: "#f0f6fc",
		customMessageBg: "#151b23",
		customMessageText: "#f0f6fc",
		customMessageLabel: "#4493f8",
		toolPendingBg: "#151b23",
		toolSuccessBg: "#162945",
		toolErrorBg: "#221a19",
		toolTitle: "#4493f8",
		toolOutput: "#9198a1",
		mdHeading: "#1f6feb",
		mdLink: "#4493f8",
		mdLinkUrl: "#9198a1",
		mdCode: "#79c0ff",
		mdCodeBlock: "#f0f6fc",
		mdCodeBlockBorder: "#3d444d",
		mdQuote: "#9198a1",
		mdQuoteBorder: "#3d444d",
		mdHr: "#3d444d",
		mdListBullet: "#4493f8",
		toolDiffAdded: "#58a6ff",
		toolDiffRemoved: "#f0883e",
		toolDiffContext: "#9198a1",
		syntaxComment: "#9198a1",
		syntaxKeyword: "#f0883e",
		syntaxFunction: "#d2a8ff",
		syntaxVariable: "#ffa657",
		syntaxString: "#a5d6ff",
		syntaxNumber: "#79c0ff",
		syntaxType: "#d2a8ff",
		syntaxOperator: "#f0f6fc",
		syntaxPunctuation: "#9198a1",
		thinkingOff: "#3d444d",
		thinkingMinimal: "#656c76",
		thinkingLow: "#1f6feb",
		thinkingMedium: "#4493f8",
		thinkingHigh: "#58a6ff",
		thinkingXhigh: "#79c0ff",
		thinkingMax: "#a5d6ff",
		bashMode: "#d29922",
	},
} as const;

function loadTheme(variant: keyof typeof expectedColors): ThemeJson {
	return JSON.parse(
		readFileSync(join(repoRoot, "themes", `github-colorblind-${variant}.json`), "utf8"),
	) as ThemeJson;
}

function resolveValue(theme: ThemeJson, value: string | number, seen = new Set<string>()): string | number {
	if (typeof value === "number" || value === "" || value.startsWith("#")) {
		return value;
	}
	assert.ok(!seen.has(value), `Circular theme variable reference: ${value}`);
	assert.ok(value in theme.vars, `Unknown theme variable reference: ${value}`);
	return resolveValue(theme, theme.vars[value], new Set([...seen, value]));
}

function resolveColors(theme: ThemeJson): Record<string, string | number> {
	return Object.fromEntries(
		Object.entries(theme.colors).map(([token, value]) => [token, resolveValue(theme, value)]),
	);
}

function luminance(hex: string): number {
	const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
	const linear = channels.map((channel) =>
		channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
	);
	return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(foreground: string, background: string): number {
	const foregroundLuminance = luminance(foreground);
	const backgroundLuminance = luminance(background);
	return (
		(Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
		(Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
	);
}

void describe("GitHub colorblind themes", () => {
	void it("maps Pi tokens to the approved Primer colorblind functional colors", () => {
		assert.deepStrictEqual({
			light: resolveColors(loadTheme("light")),
			dark: resolveColors(loadTheme("dark")),
		}, expectedColors);
	});

	void it("uses the immutable schema for the pinned Pi release", () => {
		for (const variant of ["light", "dark"] as const) {
			assert.strictEqual(loadTheme(variant).$schema, expectedSchema);
		}
	});

	void it("makes thinking levels progressively more prominent", () => {
		for (const variant of ["light", "dark"] as const) {
			const colors = resolveColors(loadTheme(variant)) as Record<string, string>;
			const background = variant === "light" ? "#ffffff" : "#0d1117";
			const levels = [
				"thinkingOff",
				"thinkingMinimal",
				"thinkingLow",
				"thinkingMedium",
				"thinkingHigh",
				"thinkingXhigh",
				"thinkingMax",
			];
			const contrasts = levels.map((level) => contrast(colors[level], background));
			assert.ok(
				contrasts.every((value, index) => index === 0 || value > contrasts[index - 1]),
				`${variant} thinking contrast is not increasing: ${contrasts.join(", ")}`,
			);
		}
	});

	void it("keeps tool text readable on every tool background", () => {
		for (const variant of ["light", "dark"] as const) {
			const colors = resolveColors(loadTheme(variant)) as Record<string, string>;
			for (const foreground of ["toolTitle", "toolOutput"] as const) {
				for (const background of ["toolPendingBg", "toolSuccessBg", "toolErrorBg"] as const) {
					const ratio = contrast(colors[foreground], colors[background]);
					assert.ok(
						ratio >= 4.5,
						`${variant} ${foreground} on ${background} has ${ratio.toFixed(2)}:1 contrast`,
					);
				}
			}
		}
	});
});
