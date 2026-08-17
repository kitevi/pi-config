/**
 * Compact Before Model Switch
 *
 * When you change the active model (`/model` or Ctrl+P cycling), attempt to
 * compact the session first, so the context handed to the new model is as
 * small as possible. A switch that starts from a small context window is
 * where a big previous conversation hurts most.
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
	pi.on("model_select", async (event, ctx) => {
		if (!USER_SOURCES.has(event.source)) return;
		attemptCompact(ctx);
	});
}
