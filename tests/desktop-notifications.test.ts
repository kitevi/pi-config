import { assert } from "vitest";
import { describe, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import {
	createDesktopNotificationsExtension,
	createDesktopNotificationSender,
	type DesktopNotificationDependencies,
} from "../extensions/desktop-notifications.ts";

type ExtensionHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type ScheduledTimer = { fn: () => void; delayMs: number; cancelled: boolean };

const createHarness = (overrides: Partial<DesktopNotificationDependencies> = {}) => {
	const lifecycle = new Map<string, ExtensionHandler>();
	const channels = new Map<string, Set<(data: unknown) => void>>();
	const writes: string[] = [];
	let terminalInput: TerminalInputHandler | undefined;
	const scheduled: ScheduledTimer[] = [];

	const pi = {
		on(event: string, handler: ExtensionHandler) {
			lifecycle.set(event, handler);
		},
		events: {
			emit(channel: string, data: unknown) {
				for (const handler of channels.get(channel) ?? []) handler(data);
			},
			on(channel: string, handler: (data: unknown) => void) {
				const handlers = channels.get(channel) ?? new Set();
				handlers.add(handler);
				channels.set(channel, handlers);
				return () => handlers.delete(handler);
			},
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		mode: "tui",
		ui: {
			onTerminalInput(handler: TerminalInputHandler) {
				terminalInput = handler;
				return () => {
					terminalInput = undefined;
				};
			},
		},
		isIdle: () => true,
	} as unknown as ExtensionContext;

	createDesktopNotificationsExtension({
		platform: "linux",
		env: { TERM_PROGRAM: "ghostty" },
		writeTerminal: (data) => writes.push(data),
		runDetached: () => {},
		setTimer: (fn: () => void, delayMs: number) => {
			const timer: ScheduledTimer = { fn, delayMs, cancelled: false };
			scheduled.push(timer);
			return timer;
		},
		clearTimer: (handle: unknown) => {
			(handle as ScheduledTimer).cancelled = true;
		},
		...overrides,
	})(pi);

	return {
		ctx,
		writes,
		emit: (channel: string, data: unknown) => pi.events.emit(channel, data),
		channelListeners: (channel: string) => channels.get(channel)?.size ?? 0,
		pendingSettleTimers: () => scheduled.filter((timer) => !timer.cancelled).length,
		flushTimers: async () => {
			for (const timer of scheduled.splice(0)) {
				if (!timer.cancelled) timer.fn();
			}
			// Drain focus-fallback promises chained off the timer callbacks.
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
		run: (event: string, data: unknown = { type: event }) => lifecycle.get(event)?.(data, ctx),
		input: (data: string) => {
			assert.ok(terminalInput, "session_start must install a terminal input listener");
			return terminalInput(data);
		},
	};
};

void describe("desktop notifications", () => {
	it("notifies through Ghostty when Pi settles while its surface is unfocused", async () => {
		const harness = createHarness();

		harness.run("session_start");
		assert.ok(harness.writes.includes("\x1b[?1004h"), "focus reporting must be enabled");
		assert.deepStrictEqual(harness.input("\x1b[O"), { consume: true });

		harness.writes.length = 0;
		harness.run("agent_settled");

		// The waiting notification is debounced: nothing fires synchronously.
		assert.deepStrictEqual(harness.writes, []);
		assert.strictEqual(harness.pendingSettleTimers(), 1);

		await harness.flushTimers();

		assert.deepStrictEqual(harness.writes, ["\x1b]777;notify;Pi is waiting for you;The agent has finished and is ready for input.\x1b\\"]);
	});

	it("stays silent when a new agent run resumes before the settle debounce fires", async () => {
		const harness = createHarness();

		harness.run("session_start");
		harness.input("\x1b[O");
		harness.writes.length = 0;

		harness.run("agent_settled");
		assert.strictEqual(harness.pendingSettleTimers(), 1);

		// Auto-retry/continuation resumed the agent: the settle was transient.
		harness.run("agent_start");
		assert.strictEqual(harness.pendingSettleTimers(), 0);

		await harness.flushTimers();
		assert.deepStrictEqual(harness.writes, []);
	});

	it("notifies when the permission gate asks while Pi is unfocused", () => {
		const harness = createHarness();

		harness.run("session_start");
		harness.input("\x1b[O");
		harness.writes.length = 0;
		harness.emit("permission_gate:ask", {
			ids: ["ask.rm"],
			target: "rm private-file",
			timeoutMs: 60_000,
		});

		assert.deepStrictEqual(harness.writes, ["\x1b]777;notify;Pi needs permission;Approval auto-blocks in 60s.\x1b\\"]);
	});

	it("keeps both attention notifications quiet while Pi is focused", () => {
		const harness = createHarness();

		harness.run("session_start");
		assert.deepStrictEqual(harness.input("\x1b[I"), { consume: true });
		harness.writes.length = 0;
		harness.emit("permission_gate:ask", { timeoutMs: 60_000 });
		harness.run("agent_settled");

		assert.deepStrictEqual(harness.writes, []);
		assert.strictEqual(harness.pendingSettleTimers(), 0);
	});

	it("removes focus reports without swallowing adjacent terminal input", async () => {
		const harness = createHarness();

		harness.run("session_start");
		assert.deepStrictEqual(harness.input("\x1b[Oa"), { data: "a" });
		harness.writes.length = 0;
		harness.run("agent_settled");
		await harness.flushTimers();

		assert.strictEqual(harness.writes.length, 1);
	});

	it("falls back to notify-send on Linux when the terminal has no native notification protocol", () => {
		const commands: Array<{ command: string; args: string[] }> = [];
		const notify = createDesktopNotificationSender({
			platform: "linux",
			env: { TERM: "xterm-256color" },
			writeTerminal: () => {
				throw new Error("native terminal notification should not be attempted");
			},
			runDetached: (command, args) => commands.push({ command, args }),
		});

		notify("Pi is waiting for you", "Ready for input.");

		assert.deepStrictEqual(commands, [
			{
				command: "notify-send",
				args: ["--app-name", "Pi", "--urgency", "normal", "Pi is waiting for you", "Ready for input."],
			},
		]);
	});

	it("falls back to osascript on macOS when the terminal has no native notification protocol", () => {
		const commands: Array<{ command: string; args: string[] }> = [];
		const notify = createDesktopNotificationSender({
			platform: "darwin",
			env: { TERM: "xterm-256color" },
			writeTerminal: () => {
				throw new Error("native terminal notification should not be attempted");
			},
			runDetached: (command, args) => commands.push({ command, args }),
		});

		notify("Pi is waiting for you", "Ready for input.");

		assert.deepStrictEqual(commands, [
			{
				command: "osascript",
				args: [
					"-e",
					"on run argv",
					"-e",
					"display notification (item 2 of argv) with title (item 1 of argv)",
					"-e",
					"end run",
					"Pi is waiting for you",
					"Ready for input.",
				],
			},
		]);
	});

	it("uses the X11 active window as a focus fallback when no terminal report arrived", async () => {
		const commands: Array<{ command: string; args: string[] }> = [];
		const harness = createHarness({
			env: { TERM: "xterm-256color", DISPLAY: ":0", WINDOWID: "6291459" },
			readCommand: async () => "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x700003\n",
			runDetached: (command, args) => commands.push({ command, args }),
		});

		harness.run("session_start");
		harness.run("agent_settled");
		await harness.flushTimers();

		assert.strictEqual(commands[0]?.command, "notify-send");
	});

	it("uses the frontmost macOS application as a focus fallback when no terminal report arrived", async () => {
		const reads: Array<{ command: string; args: string[] }> = [];
		const harness = createHarness({
			platform: "darwin",
			env: { TERM_PROGRAM: "ghostty" },
			readCommand: async (command, args) => {
				reads.push({ command, args });
				return "Finder\n";
			},
		});

		harness.run("session_start");
		harness.writes.length = 0;
		harness.run("agent_settled");
		await harness.flushTimers();

		assert.strictEqual(reads[0]?.command, "osascript");
		assert.match(harness.writes[0] ?? "", /Pi is waiting for you/);
	});

	it("does not probe focus or notify outside TUI mode", async () => {
		let reads = 0;
		const commands: string[] = [];
		const harness = createHarness({
			env: { TERM: "xterm-256color", DISPLAY: ":0", WINDOWID: "6291459" },
			readCommand: async () => {
				reads++;
				return "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x700003\n";
			},
			runDetached: (command) => commands.push(command),
		});
		harness.ctx.mode = "rpc";

		harness.run("session_start");
		harness.run("agent_settled");
		await harness.flushTimers();

		assert.strictEqual(reads, 0);
		assert.deepStrictEqual(commands, []);
	});

	it("cancels a pending settle notification when the session shuts down", async () => {
		let reads = 0;
		const commands: string[] = [];
		const harness = createHarness({
			env: { TERM: "xterm-256color", DISPLAY: ":0", WINDOWID: "6291459" },
			readCommand: async () => {
				reads++;
				return "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x700003\n";
			},
			runDetached: (command) => commands.push(command),
		});

		harness.run("session_start");
		harness.run("agent_settled");
		assert.strictEqual(harness.pendingSettleTimers(), 1);

		harness.run("session_shutdown");
		assert.strictEqual(harness.pendingSettleTimers(), 0);
		await harness.flushTimers();

		assert.strictEqual(reads, 0);
		assert.deepStrictEqual(commands, []);
	});

	it("disables focus reporting and releases listeners on session shutdown", () => {
		const harness = createHarness();

		harness.run("session_start");
		harness.writes.length = 0;
		harness.run("session_shutdown");

		assert.deepStrictEqual(harness.writes, ["\x1b[?1004l"]);
		assert.strictEqual(harness.channelListeners("permission_gate:ask"), 0);
		assert.throws(() => harness.input("\x1b[O"), /session_start must install/);
	});

	it("sanitizes control characters before writing a native terminal notification", () => {
		const writes: string[] = [];
		const notify = createDesktopNotificationSender({
			platform: "linux",
			env: { TERM_PROGRAM: "ghostty" },
			writeTerminal: (data) => writes.push(data),
			runDetached: () => {},
		});

		notify("Pi;title\x1b]9;injected", "line one\nline two");

		assert.deepStrictEqual(writes, ["\x1b]777;notify;Pi title ]9 injected;line one line two\x1b\\"]);
	});
});
