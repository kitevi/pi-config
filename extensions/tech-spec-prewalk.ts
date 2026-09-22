/**
 * Tech-Spec Prewalk
 *
 * Automatically arms fabric prewalk whenever the tech-spec skill is invoked
 * (`/skill:tech-spec`, or the bare `/tech-spec` alias). Uses the acknowledged
 * prewalk request protocol from pi-fabric (`pi-fabric/protocol`):
 * emit `pi-fabric:prewalk:request:v1` with `{ version: 1, context, claim, respond }`
 * on the shared extension event bus. Fabric claims the request synchronously
 * (first claimant wins), then responds `{ ok: true }` once prewalk is armed or
 * `{ ok: false, error }` after cancellation or failure. An unclaimed request
 * means no compatible Fabric runtime is installed.
 *
 * Mirrors the protocol shape structurally (like max-reasoning.ts) so this file
 * does not depend on pi-fabric's published types at build time.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Same channel as `FABRIC_PREWALK_REQUEST_EVENT` in `pi-fabric/protocol`. */
export const PREWALK_REQUEST_EVENT = "pi-fabric:prewalk:request:v1";

/** Skill command forms that arm prewalk: `/skill:tech-spec` and `/tech-spec`. */
const TECH_SPEC_COMMAND_RE = /^\/(?:skill:)?tech-spec(?:\s|$)/i;

/** Upper bound on waiting for Fabric's arm acknowledgment so a slow (or
 *  interactive, e.g. model-picker) arm cannot stall the input pipeline
 *  indefinitely. Fabric still completes the arm after the timeout. */
export const PREWALK_ARM_TIMEOUT_MS = 15_000;

export type FabricPrewalkRequestResultV1 = { ok: true } | { ok: false; error: string };

export type PrewalkArmOutcome =
	| { status: "armed" }
	| { status: "failed"; error: string }
	| { status: "unclaimed" }
	| { status: "timeout" };

/** Minimal slice of ExtensionAPI.events: the shared inter-extension bus. */
export interface PrewalkEventBus {
	emit(channel: string, data: unknown): void;
}

/** The request envelope Fabric reads via `readFabricPrewalkRequestV1`. */
export interface FabricPrewalkRequestV1 {
	version: 1;
	context: ExtensionContext;
	claim: () => boolean;
	respond: (result: FabricPrewalkRequestResultV1) => void;
}

/** True when raw user input invokes the tech-spec skill (with or without args). */
export function isTechSpecInvocation(text: string): boolean {
	return TECH_SPEC_COMMAND_RE.test(text.trim());
}

/**
 * Request an acknowledged fabric prewalk arm. Resolves with the arm outcome:
 * `armed` / `failed` once Fabric responds, `unclaimed` when no Fabric runtime
 * claimed the request synchronously during emit, or `timeout` when claimed but
 * unacknowledged within `timeoutMs`.
 */
export function requestPrewalkArm(
	events: PrewalkEventBus,
	context: ExtensionContext,
	options: { timeoutMs?: number } = {},
): Promise<PrewalkArmOutcome> {
	const timeoutMs = options.timeoutMs ?? PREWALK_ARM_TIMEOUT_MS;
	return new Promise((resolve) => {
		let claimed = false;
		let settled = false;
		const settle = (outcome: PrewalkArmOutcome): void => {
			if (settled) return;
			settled = true;
			resolve(outcome);
		};
		const request: FabricPrewalkRequestV1 = {
			version: 1,
			context,
			// Fabric calls claim() synchronously during emit; the first claimant
			// owns the request. Never re-claim after the outcome settled.
			claim: () => {
				if (claimed || settled) return false;
				claimed = true;
				return true;
			},
			respond: (result) => {
				settle(result.ok ? { status: "armed" } : { status: "failed", error: result.error });
			},
		};
		events.emit(PREWALK_REQUEST_EVENT, request);
		if (!claimed) {
			// Emit is synchronous: nothing claimed means no Fabric runtime listens.
			settle({ status: "unclaimed" });
			return;
		}
		setTimeout(() => settle({ status: "timeout" }), timeoutMs);
	});
}

export default function techSpecPrewalk(pi: ExtensionAPI): void {
	pi.on("input", async (event, ctx) => {
		if (!isTechSpecInvocation(event.text)) return;
		// Await the ack so prewalk is armed before the skill turn runs: the
		// acknowledged protocol exists to serialize work after the arm.
		const outcome = await requestPrewalkArm(pi.events, ctx);
		switch (outcome.status) {
			case "armed":
				ctx.ui.notify("tech-spec: fabric prewalk armed.", "info");
				break;
			case "failed":
				ctx.ui.notify(`tech-spec: fabric prewalk not armed: ${outcome.error}`, "error");
				break;
			case "unclaimed":
				ctx.ui.notify(
					"tech-spec: no Fabric runtime claimed the prewalk request; is pi-fabric installed?",
					"warning",
				);
				break;
			case "timeout":
				ctx.ui.notify(
					"tech-spec: fabric prewalk arm not acknowledged in time; it may still arm shortly.",
					"warning",
				);
				break;
		}
		return { action: "continue" };
	});
}
