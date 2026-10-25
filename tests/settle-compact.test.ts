import { describe, it } from "vitest";
import { assert } from "vitest";
import plugin, { SETTLE_COMPACT_PERCENT } from "../extensions/settle-compact.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function setup(percent: number | null | undefined, pending = false) {
	const handlers = new Map<string, Handler>();
	plugin({ on: (event: string, handler: Handler) => handlers.set(event, handler) } as never);

	const notices: Array<{ message: string; level: string }> = [];
	let compactions = 0;
	let onError: ((error: Error) => void) | undefined;
	const ctx = {
		hasPendingMessages: () => pending,
		getContextUsage: () =>
			percent === undefined ? undefined : { tokens: percent === null ? null : 1, contextWindow: 100, percent },
		ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
		compact: (options?: { onError?: (error: Error) => void }) => {
			compactions++;
			onError = options?.onError;
		},
	};
	const settle = (aborted = false) => handlers.get("agent_settled")?.({ type: "agent_settled", aborted }, ctx);
	return { settle, notices, compactions: () => compactions, fail: (error: Error) => onError?.(error) };
}

void describe("settle-compact", () => {
	void it("compacts at the threshold once the agent settles", () => {
		const guard = setup(SETTLE_COMPACT_PERCENT);
		guard.settle();
		assert.equal(guard.compactions(), 1);
		assert.match(guard.notices[0]?.message ?? "", /90%/);
	});

	void it("leaves context below the threshold alone", () => {
		const guard = setup(SETTLE_COMPACT_PERCENT - 0.1);
		guard.settle();
		assert.equal(guard.compactions(), 0);
		assert.equal(guard.notices.length, 0);
	});

	void it("skips aborted runs", () => {
		const guard = setup(95);
		guard.settle(true);
		assert.equal(guard.compactions(), 0);
	});

	void it("skips when a queued message will start the next run", () => {
		const guard = setup(95, true);
		guard.settle();
		assert.equal(guard.compactions(), 0);
	});

	void it("skips when usage is unknown", () => {
		for (const percent of [null, undefined]) {
			const guard = setup(percent);
			guard.settle();
			assert.equal(guard.compactions(), 0);
		}
	});

	void it("warns when compaction fails", () => {
		const guard = setup(95);
		guard.settle();
		guard.fail(new Error("nothing to compact"));
		assert.deepEqual(guard.notices.at(-1), {
			message: "Settle compaction failed: nothing to compact",
			level: "warning",
		});
	});
});
