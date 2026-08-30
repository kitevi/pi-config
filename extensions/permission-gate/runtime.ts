import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assessToolCall, commitWrites, noteRuleHits, resetRuleHits } from "./policy.ts";
import { ASK_ALLOW, ASK_DENY, describeAskOutcome, formatAskPrompt, formatReason } from "./presentation.ts";

const askTimeoutMs = () => {
	const override = Number(process.env.PI_GATE_ASK_TIMEOUT_MS);
	return override > 0 ? override : 60000;
};
const ASK_TIMEOUT_BACKSTOP_MS = 2000;
const ASK_TIMEOUT_SLACK_MS = 500;

// Pi's extension selector host mounts exactly one dialog at a time. A second
// concurrent ask unmounts the first without disposing it or settling its
// promise: the orphaned ask then sits invisible until its countdown expires and
// looks like a no-show. Serialize asks so parallel gated calls queue instead.
let askSlot: Promise<void> = Promise.resolve();

// ─── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("agent_start", () => {
		resetRuleHits();
	});

	pi.on("tool_call", async (event, ctx) => {
		const assessment = assessToolCall(event.toolName, event.input);
		if (assessment.decision === "allow") {
			commitWrites(assessment);
			return undefined;
		}

		const ids = assessment.matches.map((match) => match.id);
		const hits = noteRuleHits(ids);
		const reason = formatReason(assessment, hits);

		if (assessment.decision === "block") {
			if (ctx.hasUI) ctx.ui.notify(`Permission gate blocked tool call: ${ids.join(", ")}`, "warning");
			return { block: true, reason };
		}

		if (!ctx.hasUI) return { block: true, reason: `${reason}\n\nConfirmation requires UI.` };

		const askPrompt = formatAskPrompt(assessment, hits, event.toolName === "bash" ? "bash" : undefined);

		// The dialog renders its own countdown from `timeout`; the controller is a
		// backstop for a host that does not honour it. Either way "nobody answered"
		// is told apart from "answered no" by how long the dialog stayed up.
		const timeoutMs = askTimeoutMs();
		const previous = askSlot;
		let releaseSlot: () => void = () => {};
		askSlot = new Promise((resolve) => {
			releaseSlot = resolve;
		});
		await previous;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs + ASK_TIMEOUT_BACKSTOP_MS);
		const startedAt = Date.now();
		let choice: string | undefined;
		try {
			const notifyAsk = { ids, target: assessment.target, timeoutMs };
			try {
				pi.events.emit("permission_gate:ask", notifyAsk);
			} catch {
				// Notification listeners are advisory; the ask must still run.
			}
			try {
				choice = await ctx.ui.select(`⚠️ Permission gate ask\n\n${askPrompt}\n\nAllow?`, [ASK_DENY, ASK_ALLOW], {
					signal: controller.signal,
					timeout: timeoutMs,
				});
			} catch {
				choice = undefined;
			}
		} finally {
			clearTimeout(timer);
			releaseSlot();
		}

		if (choice === ASK_ALLOW) {
			commitWrites(assessment);
			return undefined;
		}

		// A dismissal in the countdown's final slack window is misread as a
		// timeout. Harmless: both kinds abort the turn; only the wording differs.
		const askSecs = Math.round(timeoutMs / 1000);
		const timedOut = controller.signal.aborted || Date.now() - startedAt >= timeoutMs - ASK_TIMEOUT_SLACK_MS;
		const outcome = describeAskOutcome(choice, timedOut, askSecs);
		const outcomeReason = `${outcome.reason}\n\n${reason}`;
		ctx.ui.notify(outcome.notify, "warning");

		// pi's agent loop checks the abort signal before it reads this block
		// reason, so an aborted turn would otherwise hand the model a bare
		// "Operation aborted" with no sign a gate exists. Deliver the reason as a
		// next-turn message, which survives the abort, and defer the abort by a
		// macrotask so the block reason still wins the race inside the loop.
		try {
			pi.sendMessage({ customType: "permission_gate", content: outcomeReason, display: false }, { deliverAs: "nextTurn" });
		} catch {
			// Older hosts may not support custom messages; the block still stands.
		}
		setTimeout(() => {
			try {
				ctx.abort();
			} catch {
				// The run may already have ended; nothing to abort.
			}
		}, 0);

		return { block: true, reason: outcomeReason };
	});
}
