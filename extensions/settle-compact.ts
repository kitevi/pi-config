/**
 * Settle Compact
 *
 * Compacts once the agent has settled with context use at or above 90%, so
 * compaction lands between tasks instead of in the middle of one. Pi's own
 * threshold (`contextWindow - compaction.reserveTokens`) still fires mid-run
 * as the safety net when a single task outgrows the remaining headroom.
 *
 * Pi treats the compaction as a manual `/compact`, which pi-vcc handles.
 * Aborted runs and runs with queued messages are skipped: the user is about
 * to steer, and the next run would start right behind the compaction.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SETTLE_COMPACT_PERCENT = 90;

export default function (pi: ExtensionAPI) {
	pi.on("agent_settled", (event, ctx) => {
		if (event.aborted || ctx.hasPendingMessages()) return;
		const percent = ctx.getContextUsage()?.percent;
		if (percent == null || percent < SETTLE_COMPACT_PERCENT) return;

		ctx.ui.notify(`Context at ${Math.round(percent)}%; compacting while idle.`, "info");
		ctx.compact({
			onError: (error) => ctx.ui.notify(`Settle compaction failed: ${error.message}`, "warning"),
		});
	});
}
