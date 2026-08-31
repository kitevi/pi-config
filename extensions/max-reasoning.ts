/**
 * Max Reasoning
 *
 * Whenever a reasoning model becomes active — any model, any provider,
 * identified by the live model's `reasoning` flag rather than a name list —
 * raise pi's thinking level to the highest level that model supports.
 *
 * The target is not computed here: we request "max" and let the runtime
 * clamp it. pi's setThinkingLevel() routes through pi-ai's
 * getSupportedThinkingLevels()/clampThinkingLevel(), which maps "max" to the
 * model's top supported level (lilac's GLM 5.2 keeps "max", openrouter's
 * deepseek-v4/kimi-k3 clamp to "xhigh", a reasoning model with no map clamps
 * to "high"). pi's Shift+Tab picker treats "max" the same way, so this cannot
 * request a level the model would reject.
 *
 * It acts only on model selection and session start, so a manual Shift+Tab
 * change afterwards is respected for the rest of the session. Manual changes
 * persist via the settings manager and are re-applied to later models, so a
 * model you deliberately run at a lower level must be excluded below.
 *
 * Loaded as a global extension via ~/.pi/agent/extensions/max-reasoning.ts
 * (symlinked from this repo by bootstrap.mjs).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// pi's thinking levels, low → high. Only used for the level type and the
// read-back comparison; the ordering lives in pi-ai, which does the clamping.
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

// Minimal slice of a pi-ai Model that this extension reads. Kept structural so
// the real `Model<any>` satisfies it without importing pi-ai's types.
export interface ThinkingModel {
	id?: string;
	reasoning?: boolean;
}

/** Model families to leave alone, e.g. ["claude"] keeps Claude models at
 *  whatever level you set manually. Case-insensitive substring match against
 *  model.id. Empty = apply to every reasoning model. */
const EXCLUDED_FAMILIES: readonly string[] = [];

/** True for any reasoning model not on the exclusion list. */
export function isMatchedModel(model: ThinkingModel | undefined): boolean {
	if (!model?.reasoning) return false;
	const id = model.id?.toLowerCase();
	return !id || !EXCLUDED_FAMILIES.some((family) => id.includes(family));
}

/** Minimal slice of ExtensionAPI: just the thinking-level controls. */
export interface ThinkingLevelApi {
	getThinkingLevel(): ThinkingLevel;
	setThinkingLevel(level: ThinkingLevel): void;
}

/** Minimal slice of ctx.ui: just notify. */
export interface NotifyUi {
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

/**
 * If `model` is a matched reasoning model, request "max" and let the runtime
 * clamp it to the model's top supported level. Returns the resulting level,
 * or undefined if it did nothing (unmatched/excluded model, or a model whose
 * clamp lands on "off"). The read-back of getThinkingLevel() after
 * setThinkingLevel() tells us where the clamp landed, so the notification
 * names the effective level rather than the requested one. When the level was
 * already at the model's top, the runtime's set is a no-op and we stay silent.
 */
export function applyMaxReasoning(
	api: ThinkingLevelApi,
	model: ThinkingModel | undefined,
	ui: NotifyUi | undefined,
): ThinkingLevel | undefined {
	if (!isMatchedModel(model)) return undefined;
	const before = api.getThinkingLevel();
	api.setThinkingLevel("max");
	const effective = api.getThinkingLevel();
	// Degenerate model whose map supports no level above off.
	if (effective === "off") return undefined;
	// Already at the model's top: the runtime's set was a no-op, stay silent.
	if (effective === before) return effective;
	try {
		ui?.notify(`${model?.id ?? "model"}: reasoning set to ${effective}`, "info");
	} catch {
		// ui may be unavailable (print mode / stale runner) — level still applied.
	}
	return effective;
}

export default function maxReasoning(pi: ExtensionAPI): void {
	// /model, Ctrl+P cycling, and session restore. The runtime has already
	// re-clamped the thinking level for the new model before this event fires.
	pi.on("model_select", async (event, ctx) => {
		applyMaxReasoning(pi, event.model ?? ctx.model, ctx.ui);
	});

	// model_select does not fire on a fresh startup, so cover the initial model
	// here. Also re-runs on /new, /resume, /fork, and /reload. Idempotent: a
	// no-op when the level is already at the model's top.
	pi.on("session_start", async (_event, ctx) => {
		applyMaxReasoning(pi, ctx.model, ctx.ui);
	});
}
