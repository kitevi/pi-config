import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assessToolCall } from "./policy.ts";
import { detailsWithWrittenPaths, PermissionGateState } from "./state.ts";
import { ASK_ALLOW, ASK_DENY, describeAskOutcome, formatAskPrompt, formatReason } from "./presentation.ts";

const askTimeoutMs = () => {
	const override = Number(process.env.PI_GATE_ASK_TIMEOUT_MS);
	return override > 0 ? override : 60000;
};
const ASK_TIMEOUT_BACKSTOP_MS = 2000;
const ASK_TIMEOUT_SLACK_MS = 500;

export default function (pi: ExtensionAPI) {
	// Pi's extension selector host mounts exactly one dialog at a time. A second
	// concurrent ask unmounts the first without disposing it or settling its
	// promise, so serialize permission dialogs within this extension instance.
	let askSlot: Promise<void> = Promise.resolve();
	const state = new PermissionGateState();

	const restoreState = (ctx: ExtensionContext) => {
		state.restoreFromBranch(ctx.sessionManager.getBranch());
	};

	pi.on("session_start", (_event, ctx) => restoreState(ctx));
	pi.on("session_tree", (_event, ctx) => restoreState(ctx));

	pi.on("agent_start", () => {
		state.resetRuleHits();
	});

	pi.on("agent_end", () => {
		state.clearPendingWrites();
	});

	pi.on("tool_result", (event) => {
		const writtenPaths = state.completeWrites(event.toolCallId, !event.isError);
		if (writtenPaths.length > 0) return { details: detailsWithWrittenPaths(event.details, writtenPaths) };
	});
	pi.on("tool_call", async (event, ctx) => {
		const assessment = assessToolCall(event.toolName, event.input, { state, cwd: ctx.cwd });
		if (assessment.decision === "allow") {
			state.stageWrites(event.toolCallId, assessment.writes);
			return undefined;
		}

		const ids = assessment.matches.map((match) => match.id);
		const hits = state.noteRuleHits(ids);
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
			state.stageWrites(event.toolCallId, assessment.writes);
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
