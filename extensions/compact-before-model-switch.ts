/**
 * Compact Before Model Switch
 *
 * When you change the active model (`/model` or Ctrl+P cycling), attempt to
 * compact the session first, so the context handed to the new model is as
 * small as possible. A switch that starts from a small context window is
 * where a big previous conversation hurts most.
 *
 * Rate limiting, because frequent model switching would otherwise compact far
 * too often: at most one compaction per PROMPT_COOLDOWN user prompts
 * (counted via before_agent_start, which fires once per submitted prompt),
 * and never when the context is already below MIN_TOKENS_FOR_ATTEMPT. Any
 * completed compaction resets the cooldown — a fresh context doesn't need
 * re-compacting no matter how it was compacted. Note the reset only lands
 * via our own onComplete: pi's session_compact event has no way to attribute
 * its reason back to this extension (extension-triggered compactions all
 * arrive as "manual"), so a manual /compact that completes between the model
 * switch and a failed attempt is intentionally not double-counted.
 *
 * This only attempts: when there is nothing to compact (session too small,
 * compaction already in progress, agent busy) the failure is expected and
 * shown as an info notification rather than an error.
 *
 * Only user-initiated switches (event.source "set" | "cycle") trigger the
 * compaction. Session "restore" also emits model_select, and compacting there
 * could fire while the agent is mid-turn (plus silently rewriting a session
 * that was just restored is surprising), so it is skipped.
 *
 * With pi-fabric's engine this is its deterministic compactor; with
 * `compaction.engine: "pi"` it is pi's LLM compactor — either way it goes
 * through ctx.compact(), the same path as /compact.
 *
 * Loaded as a global extension via ~/.pi/agent/extensions/compact-before-model-switch.ts
 * (symlinked from this repo by bootstrap.mjs).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Model-select sources that count as a deliberate user switch. */
const USER_SOURCES = new Set(["set", "cycle"]);

/** Minimum user prompts between two pre-switch compactions. Light model
 *  browsing typically can't get past this; a worked session slips through
 *  once every ~N prompts. */
export const PROMPT_COOLDOWN = 20;

/** Don't attempt compaction below this context size. Fabric's deterministic
 *  engine refuses sessions whose retained tail would be too small (its
 *  minimum cut is ~4k tokens), so a compaction attempt under ~6k tokens is
 *  guaranteed to fail with "Nothing to compact"; skip the round trip. */
export const MIN_TOKENS_FOR_ATTEMPT = 6000;

type CompactState = { promptsSinceCompact: number };

/** True when a compaction attempt is allowed: cooldown elapsed and the
 *  context is big enough to have something worth compacting. */
export function shouldAttemptCompact(state: CompactState, currentTokens: number | null): boolean {
	if (state.promptsSinceCompact < PROMPT_COOLDOWN) return false;
	if (currentTokens !== null && currentTokens < MIN_TOKENS_FOR_ATTEMPT) return false;
	return true;
}

function attemptCompact(ctx: ExtensionContext): void {
	ctx.compact({
		onComplete: () => {
			ctx.ui.notify("Compacted session before model switch", "info");
		},
		onError: (error) => {
			// Expected failures are fine: "Nothing to compact (session too
			// small)" or a compaction already in flight. Informational only.
			ctx.ui.notify(`Pre-switch compaction skipped: ${error.message}`, "info");
		},
	});
}

export default function compactBeforeModelSwitch(pi: ExtensionAPI): void {
	// In-memory, per-session (extension instances are per-session). Starts at
	// the cooldown so the first model switch in a session always considers
	// compacting — /resume reloads extensions, which re-arms it, but resumed
	// sessions are small right after a compaction anyway.
	const state: CompactState = { promptsSinceCompact: PROMPT_COOLDOWN };

	// before_agent_start fires once per user-submitted prompt (turn_start
	// would fire per LLM turn inside tool-call loops).
	pi.on("before_agent_start", async () => {
		state.promptsSinceCompact++;
	});

	// Any completed compaction — ours, /compact, threshold, overflow — means
	// the context is fresh; restart the cooldown.
	pi.on("session_compact", async () => {
		state.promptsSinceCompact = 0;
	});

	pi.on("model_select", async (event, ctx) => {
		if (!USER_SOURCES.has(event.source)) return;
		const currentTokens = ctx.getContextUsage()?.tokens ?? null;
		if (!shouldAttemptCompact(state, currentTokens)) return;
		// Arm the cooldown now. onComplete resets it to 0 via session_compact;
		// leaving it at the cooldown on failure means the next switch retries
		// — desired, since the context only ever grows until a compaction lands.
		state.promptsSinceCompact = 0;
		attemptCompact(ctx);
	});
}
