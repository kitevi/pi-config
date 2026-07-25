/**
 * GLM Max Reasoning
 *
 * When a GLM model (any model whose id contains "glm" — e.g. zai-org/glm-5.2,
 * zai-org/glm-5.1, glm-4.6) becomes active, automatically raise pi's thinking
 * level to the highest level that model supports, if it isn't already there.
 *
 * Different providers expose different top levels — lilac's GLM 5.2 offers
 * "max", others cap at "xhigh" or "high" — so the target is read from the live
 * model's `thinkingLevelMap` rather than hard-coded. The level-support logic
 * mirrors @earendil-works/pi-ai's getSupportedThinkingLevels() so the chosen
 * level always matches what the runtime would clamp "max" down to:
 *   - non-reasoning models only support "off"
 *   - a map entry of `null` hides a level
 *   - extended levels (xhigh, max) are unsupported unless explicitly mapped
 *   - standard levels (off..high) are supported unless explicitly `null`
 *
 * It acts only on model selection and session start, so a manual Shift+Tab
 * change afterwards is respected for the rest of the session.
 *
 * Loaded as a global extension via ~/.pi/agent/extensions/glm-max-reasoning.ts
 * (symlinked from this repo by bootstrap.mjs).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// pi's thinking levels, low → high. Matches the EXTENDED_THINKING_LEVELS of the
// pi-ai version that pi-coding-agent bundles (which includes "max"). Defined
// locally rather than imported so this extension does not couple to a
// specific pi-ai version's exported types.
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

// Minimal slice of a pi-ai Model that this extension reads. Kept structural so
// the real `Model<any>` from pi-coding-agent satisfies it without importing a
// pi-ai version that may disagree about whether "max" exists.
export interface ThinkingModel {
	id?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

/** Matches GLM model ids across providers: zai-org/glm-5.2, glm-4.6, chatglm3, … */
const GLM_ID = /glm/i;

/** True for any model whose id contains "glm". */
export function isGlmModel(model: { id?: string } | undefined): model is ThinkingModel & { id: string } {
	return !!model?.id && GLM_ID.test(model.id);
}

/**
 * The thinking levels a model supports, low → high. Replicates pi-ai's
 * getSupportedThinkingLevels() so the result tracks what the runtime clamps to.
 */
export function getSupportedThinkingLevels(model: ThinkingModel | undefined): ThinkingLevel[] {
	if (!model?.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/** The highest thinking level a model supports, or undefined if it has none. */
export function highestThinkingLevel(model: ThinkingModel | undefined): ThinkingLevel | undefined {
	const supported = getSupportedThinkingLevels(model);
	return supported[supported.length - 1];
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
 * If `model` is a GLM reasoning model, raise the thinking level to the highest
 * level it supports — unless it is already there. Returns the level it set or
 * kept, or undefined if it did nothing (non-GLM model, non-reasoning model, or
 * already at the top). The runtime's setThinkingLevel clamps and only
 * persists/emits on real change, but we short-circuit the no-op case ourselves
 * so we don't fire a spurious "set to max" notification.
 */
export function applyGlmMaxReasoning(
	api: ThinkingLevelApi,
	model: ThinkingModel | undefined,
	ui: NotifyUi | undefined,
): ThinkingLevel | undefined {
	if (!isGlmModel(model)) return undefined;
	const target = highestThinkingLevel(model);
	// Non-reasoning GLM model, or a degenerate map with no supported levels.
	if (!target || target === "off") return undefined;
	const current = api.getThinkingLevel();
	if (current === target) return current;
	api.setThinkingLevel(target);
	try {
		ui?.notify(`GLM ${model.id}: reasoning set to ${target}`, "info");
	} catch {
		// ui may be unavailable (print mode / stale runner) — level still applied.
	}
	return target;
}

export default function glmMaxReasoning(pi: ExtensionAPI): void {
	// /model, Ctrl+P cycling, and session restore. The runtime has already
	// re-clamped the thinking level for the new model before this event fires.
	pi.on("model_select", async (event, ctx) => {
		applyGlmMaxReasoning(pi, event.model ?? ctx.model, ctx.ui);
	});

	// model_select does not fire on a fresh startup, so cover the initial model
	// here. Also re-runs on /new, /resume, /fork, and /reload. Idempotent: a
	// no-op when the level is already at the model's top.
	pi.on("session_start", async (_event, ctx) => {
		applyGlmMaxReasoning(pi, ctx.model, ctx.ui);
	});
}
