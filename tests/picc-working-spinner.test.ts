import { afterEach, assert, describe, it, vi } from "vitest";
import spinner from "../extensions/picc-working-spinner.ts";

type Handler = (event: unknown, context: unknown) => unknown;

function createHarness() {
	const handlers = new Map<string, Handler[]>();
	const workingMessages: Array<string | undefined> = [];
	const notifications: string[] = [];

	spinner({
		on(event: string, handler: Handler) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
	} as never);

	const context = {
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
			setWorkingIndicator() {},
			setWorkingMessage(message?: string) {
				workingMessages.push(message);
			},
		},
	};

	return {
		notifications,
		workingMessages,
		async fire(event: string, payload: unknown = {}) {
			for (const handler of handlers.get(event) ?? []) {
				await handler(payload, context);
			}
		},
	};
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function lastPlain(workingMessages: Array<string | undefined>): string {
	const message = workingMessages.findLast(
		(value): value is string => typeof value === "string",
	);
	assert.ok(message, "expected an animated working message");
	return stripAnsi(message);
}

void describe("picc working spinner", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	void it("shows no thinking status part but still counts streamed tokens", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const harness = createHarness();

		await harness.fire("agent_start");
		await harness.fire("message_update", {
			assistantMessageEvent: { type: "thinking_start" },
		});
		await vi.advanceTimersByTimeAsync(250);

		// The "· thinking" status part is vendored away; the rendered message
		// is just the shimmered verb. VERBS contains a capitalized "Thinking",
		// so the lowercase checks below can only trip on the removed part.
		assert.strictEqual(
			lastPlain(harness.workingMessages).includes("thinking"),
			false,
		);

		// Its successor state, "thought for Ns", is gone too.
		await harness.fire("message_update", {
			assistantMessageEvent: { type: "thinking_end" },
		});
		await vi.advanceTimersByTimeAsync(3_000);
		assert.strictEqual(
			lastPlain(harness.workingMessages).includes("thought"),
			false,
		);

		// Guard against a vacuous pass: streamed deltas must still be picked
		// up and surfaced as a token count.
		await harness.fire("message_update", {
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(400) },
		});
		await vi.advanceTimersByTimeAsync(500);
		assert.match(lastPlain(harness.workingMessages), /↓ \d+ tokens/);

		await harness.fire("agent_end", { willRetry: false });
	});

	void it("does not replace pi-tps with a completion notification", async () => {
		const harness = createHarness();
		await harness.fire("session_start");
		await harness.fire("agent_end", { willRetry: false });
		assert.deepStrictEqual(harness.notifications, []);
	});
});
