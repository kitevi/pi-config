import { ExtensionSelectorComponent, initTheme, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, TUI, visibleWidth, type Component, type KeybindingsManager, type Terminal } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { afterEach, assert, beforeAll, beforeEach, it, vi } from "vitest";
import gate from "../extensions/permission-gate.ts";
import { showAskDialog } from "../extensions/permission-gate/ask-ui.ts";
import { ASK_ALLOW, ASK_DENY } from "../extensions/permission-gate/presentation.ts";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

type Dialog = Component & { dispose?: () => void };
type Factory = (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (choice?: string) => void) => Dialog;
type Outcome = { block?: boolean; reason?: string } | undefined;
const cleanups: Array<() => void> = [];

beforeAll(() => initTheme("dark"));
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv("PI_GATE_ASK_TIMEOUT_MS", "60000");
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

// Mount the real gate's component in pi's real TUI. Only terminal I/O and
// extension services are fake; keys go through TUI's focused-overlay dispatch.
const install = () => {
	let input = (_data: string) => {};
	const terminal = {
		columns: 80, rows: 24, kittyProtocolActive: false,
		start(onInput: (data: string) => void) { input = onInput; },
		stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
		clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
	} satisfies Terminal;
	const tui = new TUI(terminal);
	tui.start();
	let component: Dialog | undefined;
	let close = (_choice?: string) => {};
	const dialogs: Dialog[] = [];
	const selectors: string[] = [];
	const mount = (factory: Factory, options?: Parameters<ExtensionContext["ui"]["custom"]>[1]) =>
		new Promise<string | undefined>((resolve) => {
			let closed = false;
			let mounted: Dialog;
			let overlay: ReturnType<TUI["showOverlay"]> | undefined;
			const done = (choice?: string) => {
				if (closed) return;
				closed = true;
				overlay?.hide();
				mounted?.dispose?.();
				resolve(choice);
			};
			close = done;
			mounted = factory(tui, theme, getKeybindings(), done);
			component = mounted;
			dialogs.push(mounted);
			const sizing = typeof options?.overlayOptions === "function" ? options.overlayOptions() : options?.overlayOptions;
			overlay = tui.showOverlay(mounted, sizing);
		});
	const abort = vi.fn();
	const sent = vi.fn();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	gate({ on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
		events: { emit() {} }, sendMessage: sent } as never);
	const ctx = {
		cwd: process.cwd(), hasUI: true, abort,
		ui: {
			notify: vi.fn(), custom: mount,
			select: (title: string, choices: string[], options: { timeout?: number }) => {
				selectors.push(title);
				return mount((tui, _theme, _keys, done) => new ExtensionSelectorComponent(
					title, choices, done, () => done(), { tui, timeout: options.timeout },
				));
			},
		},
	};
	let id = 0;
	const call = (command: string) => handlers.get("tool_call")!(
		{ toolCallId: `ui-${++id}`, toolName: "bash", input: { command } }, ctx,
	) as Promise<Outcome>;
	const frame = () => {
		assert.ok(component, "the real permission handler must open a dialog");
		const width = terminal.columns; // includes the opaque padding owned by the dialog
		const lines = component.render(width);
		assert.isAtMost(lines.length, terminal.rows, `permission dialog overflows: ${lines.length} rows in a ${terminal.rows}-row terminal`);
		for (const line of lines) assert.isAtMost(visibleWidth(line), width, "rendered rows must fit the width");
		const plain = lines.map(stripVTControlCharacters);
		return { lines, plain, text: plain.join("\n") };
	};
	const dispose = () => { close(); component?.dispose?.(); tui.stop(); };
	cleanups.push(dispose);
	return { abort, call, ctx, dialogs, dispose, frame, key: (data: string) => input(data), selectors, sent, terminal,
		startAgentRun: () => handlers.get("agent_start")?.({}, ctx),
		endAgentRun: () => handlers.get("agent_end")?.({}, ctx),
	};
};

// These commands are only assessed/rendered, never executed.
const scriptCommand = (count: number) => `python3 -c '${Array.from({ length: count }, (_, i) =>
	`print("SCRIPT_LINE_${String(i).padStart(3, "0")}")`).join("\n")}\nopen("unused-fixture", "w")'`;
const settleMount = async () => { await Promise.resolve(); await Promise.resolve(); };
const position = (frame: ReturnType<ReturnType<typeof install>["frame"]>) => {
	const match = frame.text.match(/Review (\d+)–(\d+)\/(\d+)/);
	assert.ok(match, "the viewport must advertise its position");
	return match.slice(1).map(Number);
};
const collectReview = (ui: ReturnType<typeof install>) => {
	ui.key("\x1b[H");
	const rows = new Map<number, string>();
	for (let page = 0; page < 10000; page++) {
		const frame = ui.frame();
		assert.include(frame.text, ASK_DENY, "deny stays visible while scrolling");
		assert.include(frame.text, ASK_ALLOW, "allow stays visible while scrolling");
		const [start, end, total] = position(frame);
		for (let row = start; row <= end; row++) rows.set(row, frame.plain[3 + row - start]);
		if (end === total) {
			assert.equal(rows.size, total, "no rendered row may be skipped by paging");
			return [...rows.values()].join("\n");
		}
		ui.key("\x1b[6~");
	}
	throw new Error("paging never reached the end of the review");
};

it.each([1, 2, 60, 1000])("keeps a %i-line permission script inside the terminal and makes every line reachable", async (count) => {
	const ui = install();
	const pending = ui.call(scriptCommand(count));
	await settleMount();
	ui.frame();
	const review = collectReview(ui);
	assert.equal(new Set(review.match(/SCRIPT_LINE_\d+/g)).size, count);
	ui.key("\x1b[H");
	assert.include(ui.frame().text, "REVIEW THIS", "Home returns to the start");
	ui.key("\x1b");
	assert.isTrue((await pending)?.block);
	assert.isEmpty(ui.selectors, "an interactive dismissal must not reopen a selector");
});

it("preserves the entire wrapped command, including long tokens, tabs, and Unicode, after resizing", async () => {
	const ui = install();
	const command = `python3 -c 'print("START_${"ab界🙂".repeat(200)}_END")\n\topen("unused-fixture", "w")'`;
	const pending = ui.call(command);
	await settleMount();
	for (const [columns, rows] of [[80, 24], [40, 12], [120, 40]]) {
		ui.terminal.columns = columns;
		ui.terminal.rows = rows;
		ui.frame();
		const review = collectReview(ui);
		assert.include(review.replace(/\s/g, ""), command.replace(/\s/g, ""));
		ui.key("\x1b[F");
		const [, end, total] = position(ui.frame());
		assert.equal(end, total);
	}
	ui.key("\x1b");
	await pending;
});

it("scrolling keys never select allow, and Enter still denies by default", async () => {
	const ui = install();
	const pending = ui.call(scriptCommand(60));
	await settleMount();
	const hint = ui.frame().plain.find((line) => line.includes("PgUp"))!;
	assert.include(hint, "↑/k/PgUp · ↓/j/PgDn scroll");
	assert.equal(hint.match(/↑/g)?.length, 1);
	assert.equal(hint.match(/↓/g)?.length, 1);
	ui.key("\x1b[B");
	assert.equal(position(ui.frame())[0], 2);
	ui.key("\x1b[A");
	assert.equal(position(ui.frame())[0], 1);
	ui.key("\x1b[6~");
	assert.isAbove(position(ui.frame())[0], 1);
	ui.key("\x1b[5~");
	assert.equal(position(ui.frame())[0], 1);
	ui.key("j");
	assert.equal(position(ui.frame())[0], 2);
	ui.key("k");
	assert.equal(position(ui.frame())[0], 1);
	ui.key("\x1b[F");
	assert.include(ui.frame().text, "SCRIPT_LINE_059");
	ui.key("\x1b[H");
	assert.include(ui.frame().text, `→ ${ASK_DENY}`);
	ui.key("\r");
	assert.isTrue((await pending)?.block);
	assert.isFalse(ui.abort.mock.calls.length > 0, "abort remains deferred until the block result is delivered");
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(ui.abort.mock.calls.length, 1);
});

it.each(["\t", "\x1b[C"])("allows only after explicitly choosing allow with %j", async (choose) => {
	const ui = install();
	const pending = ui.call("rm unused-fixture");
	await settleMount();
	ui.frame();
	ui.key(choose);
	assert.include(ui.frame().text, `→ ${ASK_ALLOW}`);
	ui.key("\r");
	assert.isUndefined(await pending);
	assert.isEmpty(ui.sent.mock.calls);
	ui.dispose();
	assert.equal(vi.getTimerCount(), 0, "allow must dispose the countdown and backstop");
});

it.each(["dark", "light"])("marks the selected action with pi's %s theme colors", async (themeName) => {
	initTheme(themeName);
	try {
		const ui = install();
		const pending = ui.call(scriptCommand(60));
		await settleMount();
		const check = (allow: boolean) => {
			const frame = ui.frame();
			const color = allow ? "success" : "error";
			const selected = allow ? ASK_ALLOW : ASK_DENY;
			const unselected = allow ? ASK_DENY : ASK_ALLOW;
			const styled = frame.lines.join("\n");
			assert.include(styled, theme.fg(color, theme.bold(`→ ${selected} (Enter)`)));
			assert.include(styled, theme.fg("muted", `  ${unselected}`));
			assert.notInclude(frame.text, "Enter:");
			assert.notInclude(frame.text, "Enter confirm");
			assert.equal(frame.text.split("(Enter)").length - 1, 1, "exactly one Enter target");
		};
		check(false);
		ui.key("\t");
		check(true);
		ui.key("\x1b[Z");
		check(false);
		ui.key("\x1b[C");
		check(true);
		ui.key("\x1b[D");
		check(false);
		ui.key("\r");
		assert.isTrue((await pending)?.block);
	} finally {
		initTheme("dark");
	}
});

it("keeps the viewport stable when selection changes across terminal widths", async () => {
	const ui = install();
	const pending = ui.call(scriptCommand(60));
	await settleMount();
	for (let columns = 22; columns <= 100; columns++) {
		ui.terminal.columns = columns;
		const denied = ui.frame();
		assert.include(denied.text, `→ ${columns - 2 < 25 ? "Block" : ASK_DENY} (Enter)`);
		ui.key("\t");
		const allowed = ui.frame();
		assert.include(allowed.text, `→ ${columns - 2 < 25 ? "Allow once" : ASK_ALLOW} (Enter)`);
		assert.equal(allowed.plain.length, denied.plain.length);
		assert.deepEqual(position(allowed), position(denied), "choosing an action must not move the review");
		ui.key("\x1b[Z");
	}
	ui.key("\x1b");
	await pending;
});

it("expires on the original deadline while scrolling, with timeout wording and no leaked timers", async () => {
	vi.stubEnv("PI_GATE_ASK_TIMEOUT_MS", "2500");
	const ui = install();
	const pending = ui.call(scriptCommand(60));
	await settleMount();
	assert.include(ui.frame().text, "(3s)");
	await vi.advanceTimersByTimeAsync(1000);
	ui.key("\x1b[6~");
	assert.include(ui.frame().text, "(2s)");
	await vi.advanceTimersByTimeAsync(1500);
	assert.match((await pending)?.reason ?? "", /timed out/);
	await vi.runOnlyPendingTimersAsync();
	assert.equal(ui.abort.mock.calls.length, 1);
	ui.dispose();
	assert.equal(vi.getTimerCount(), 0);
});

it("serializes concurrent custom asks and gives the next ask a fresh deadline and deny selection", async () => {
	const ui = install();
	const first = ui.call("rm first-fixture");
	const second = ui.call("rm second-fixture");
	await settleMount();
	assert.equal(ui.dialogs.length, 1);
	assert.include(ui.frame().text, "rm first-fixture");
	await vi.advanceTimersByTimeAsync(59000);
	ui.key("\t");
	ui.key("\r");
	assert.isUndefined(await first);
	await settleMount();
	assert.equal(ui.dialogs.length, 2);
	assert.include(ui.frame().text, "rm second-fixture");
	assert.include(ui.frame().text, "(60s)");
	assert.include(ui.frame().text, `→ ${ASK_DENY}`);
	ui.key("\x1b");
	assert.isTrue((await second)?.block);
});

it("fails closed in a tiny terminal and recovers on resize", async () => {
	const ui = install();
	const pending = ui.call(scriptCommand(60));
	await settleMount();
	ui.frame();
	ui.key("\t");
	ui.terminal.rows = 4;
	ui.terminal.columns = 12;
	ui.frame();
	ui.key("\r"); // Must not approve an unreadable prompt.
	ui.terminal.rows = 24;
	ui.terminal.columns = 80;
	assert.include(ui.frame().text, `→ ${ASK_DENY}`);
	ui.key("\r");
	assert.isTrue((await pending)?.block);
});

it("closes on the abort backstop without reopening a selector", async () => {
	const ui = install();
	const controller = new AbortController();
	const pending = showAskDialog(ui.ctx as never, "review body", { signal: controller.signal, timeout: 60000 });
	ui.frame();
	controller.abort();
	assert.isUndefined(await pending);
	assert.isEmpty(ui.selectors);
	ui.dispose();
	assert.equal(vi.getTimerCount(), 0);
});

it("settles on external disposal rather than stranding the ask queue", async () => {
	const ui = install();
	const controller = new AbortController();
	let settled = false;
	const pending = showAskDialog(ui.ctx as never, "review body", { signal: controller.signal, timeout: 60000 })
		.then((choice) => { settled = true; return choice; });
	ui.dialogs[0].dispose?.();
	await settleMount();
	assert.isTrue(settled, "disposing a dialog must resolve its pending ask");
	assert.isUndefined(await pending);
});

it("does not open a dialog for an already-aborted request", async () => {
	const ui = install();
	assert.isUndefined(await showAskDialog(ui.ctx as never, "review body", { signal: AbortSignal.abort(), timeout: 60000 }));
	assert.isEmpty(ui.dialogs);
});

it("cancels active and queued asks when the agent signal aborts", async () => {
	const ui = install();
	const controller = new AbortController();
	Object.defineProperty(ui.ctx, "signal", { value: controller.signal });
	const first = ui.call("rm first-fixture");
	const second = ui.call("rm second-fixture");
	await vi.advanceTimersByTimeAsync(1);
	controller.abort();
	const outcomes = await Promise.all([first, second]);
	assert.isTrue(outcomes.every((outcome) => outcome?.block));
	assert.equal(ui.dialogs.length, 1);
	assert.equal(ui.sent.mock.calls.length, 0, "an external abort must not be reported as a user denial");
	assert.equal(ui.abort.mock.calls.length, 0);
});

it("declining cancels queued asks and the next agent run can ask again", async () => {
	const ui = install();
	const first = ui.call("rm first-fixture");
	const second = ui.call("rm second-fixture");
	await vi.advanceTimersByTimeAsync(1);
	ui.frame();
	ui.key("\x1b");
	assert.isTrue((await first)?.block);
	assert.isTrue((await second)?.block);
	assert.equal(ui.dialogs.length, 1);
	assert.equal(ui.sent.mock.calls.length, 1);
	await vi.advanceTimersByTimeAsync(1);
	assert.equal(ui.abort.mock.calls.length, 1);
	ui.startAgentRun();
	const next = ui.call("rm next-fixture");
	await vi.advanceTimersByTimeAsync(1);
	assert.equal(ui.dialogs.length, 2);
	ui.frame(); ui.key("\t"); ui.key("\r");
	assert.isUndefined(await next);
});

it("ending a run cancels its ask without aborting a subsequent run", async () => {
	const ui = install();
	const pending = ui.call("rm old-fixture");
	await vi.advanceTimersByTimeAsync(1);
	ui.endAgentRun();
	assert.isTrue((await pending)?.block);
	ui.startAgentRun();
	await vi.advanceTimersByTimeAsync(1);
	assert.equal(ui.abort.mock.calls.length, 0);
});

it("a timeout cancels queued asks instead of opening a fresh countdown", async () => {
	const ui = install();
	const first = ui.call("rm first-fixture");
	const second = ui.call("rm second-fixture");
	await vi.advanceTimersByTimeAsync(60001);
	assert.isTrue((await first)?.block);
	assert.isTrue((await second)?.block);
	assert.equal(ui.dialogs.length, 1);
});

it("the backstop settles even when a custom host ignores its signal", async () => {
	const ui = install();
	ui.ctx.ui.custom = () => new Promise<string | undefined>(() => {});
	const pending = ui.call("rm ignored-signal-fixture");
	await vi.advanceTimersByTimeAsync(62001);
	assert.isTrue((await pending)?.block);
});

it("retains RPC's native selector when custom UI is a no-op", async () => {
	const select = vi.fn().mockResolvedValue(ASK_ALLOW);
	const options = { signal: new AbortController().signal, timeout: 60000 };
	const result = await showAskDialog({ ui: { custom: async () => undefined, select } } as never, "full command", options);
	assert.equal(result, ASK_ALLOW);
	assert.deepEqual(select.mock.calls, [["⚠️ Permission gate ask\n\nfull command\n\nAllow?", [ASK_DENY, ASK_ALLOW], options]]);
});
