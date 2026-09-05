import { initTheme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, getKeybindings, TUI, type Component, type Terminal } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { assert, beforeAll, it } from "vitest";
import { showAskDialog } from "../extensions/permission-gate/ask-ui.ts";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

beforeAll(() => initTheme("dark"));

// Component-only snapshots miss transparent overlay margins. Inspect pi's real
// composed frame, including the ordinary content underneath the permission UI.
type Compositor = {
	compositeOverlays(lines: string[], width: number, height: number): string[];
	extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null;
};

it.each([1, 100])("covers background characters and the editor cursor behind a %i-line review", async (lineCount) => {
	const terminal = {
		columns: 80, rows: 24, kittyProtocolActive: false,
		start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
		clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
	} satisfies Terminal;
	const tui = new TUI(terminal, true);
	const compositor = tui as unknown as Compositor;
	const controller = new AbortController();
	let dialog: (Component & { dispose?: () => void }) | undefined;
	let overlay: ReturnType<TUI["showOverlay"]> | undefined;
	tui.addChild({
		render: (width) => Array.from({ length: terminal.rows * 3 }, () =>
			CURSOR_MARKER + "U" + " ".repeat(width - 2) + "X"),
		invalidate() {},
	});
	const ctx = {
		ui: {
			custom: (factory: Function, options: { overlayOptions: Parameters<TUI["showOverlay"]>[1] }) =>
				new Promise<string | undefined>((resolve) => {
					dialog = factory(tui, theme, getKeybindings(), resolve);
					overlay = tui.showOverlay(dialog!, options.overlayOptions);
				}),
		},
	};
	const prompt = Array.from({ length: lineCount }, (_, index) => `REVIEW BODY ${index}`).join("\n");
	const pending = showAskDialog(ctx as never, prompt, { signal: controller.signal, timeout: 60000 });
	try {
		for (const [columns, rows] of [[80, 24], [40, 12], [120, 40]]) {
			terminal.columns = columns;
			terminal.rows = rows;
			for (const key of ["", "\t", "\x1b[F", "\x1b[H"]) {
				if (key) dialog!.handleInput?.(key);
				const lines = compositor.compositeOverlays(tui.render(columns), columns, rows);
				const plain = lines.slice(-rows).map((line) => stripVTControlCharacters(line.replaceAll(CURSOR_MARKER, "")));
				assert.ok(plain.some((line) => /Review \d/.test(line)), "the real permission overlay must be visible");
				for (const line of plain) {
					assert.equal(line[0], " ", `background bleeds through at the left edge: ${JSON.stringify(line.trimEnd())}`);
					assert.equal(line.at(-1), " ", "the right edge must also be opaque");
				}
				assert.equal(plain[0].trim(), "", "top padding must be opaque");
				assert.equal(plain.at(-1)!.trim(), "", "bottom padding must be opaque");
				assert.isNull(compositor.extractCursorPosition(lines, rows), "a covered editor cursor must not be revived");
			}
		}
		overlay!.hide();
		assert.isNotNull(compositor.extractCursorPosition(tui.render(terminal.columns), terminal.rows), "closing the review restores the underlying editor cursor");
	} finally {
		controller.abort();
		dialog?.dispose?.();
		overlay?.hide();
		tui.stop();
		await pending;
	}
});
