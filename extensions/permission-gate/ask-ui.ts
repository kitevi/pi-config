import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ASK_ALLOW, ASK_DENY } from "./presentation.ts";

type AskOptions = { signal: AbortSignal; timeout: number };

// ui.select renders its title at unbounded height and only navigates the choices.
// Keep the whole review in memory, with a viewport over *wrapped* display rows.
export async function showAskDialog(ctx: ExtensionContext, prompt: string, options: AskOptions) {
	if (options.signal.aborted) return undefined;
	let opened = false;
	const choice = await ctx.ui.custom?.<string | undefined>((tui, theme, keybindings, done) => {
		opened = true;
		const body = new Text(prompt, 0, 0);
		const deadline = Date.now() + options.timeout;
		let scroll = 0;
		let pageSize = 1;
		let maxScroll = 0;
		let allow = false;
		let reviewReady = false;
		let closed = false;

		const cleanup = () => {
			closed = true;
			clearTimeout(timeout);
			clearInterval(countdown);
			options.signal.removeEventListener("abort", cancel);
		};
		const finish = (value?: string) => {
			if (closed) return;
			cleanup();
			done(value);
		};
		const cancel = () => finish();
		const timeout = setTimeout(cancel, options.signal.aborted ? 0 : options.timeout);
		const countdown = setInterval(() => tui.requestRender(), 1000);
		options.signal.addEventListener("abort", cancel, { once: true });

		const content = {
			render(width: number) {
				// Reserve the two padding rows painted by the outer component.
				const height = Math.max(1, tui.terminal.rows - 2);
				const fit = (line: string) => truncateToWidth(line, width, "", true);
				const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
				const title = fit(theme.fg("warning", theme.bold(`⚠ Permission gate ask (${seconds}s)`)));
				const hints = new Text(
					theme.fg("dim", "↑/k/PgUp · ↓/j/PgDn scroll · Home/End · Tab/←→ choose · Esc cancel"), 0, 0,
				).render(width);
				// One spacer row separates the review from the controls; the Enter
				// marker lives on the selected option so its label never shifts layout.
				const fixedRows = 6 + hints.length; // title, border, spacer, position, two choices
				reviewReady = width >= 20 && height > fixedRows;
				if (!reviewReady) {
					allow = false;
					return [title, fit("Resize terminal to review"), fit("Esc cancel")].slice(0, height);
				}

				const lines = body.render(width);
				pageSize = height - fixedRows;
				maxScroll = Math.max(0, lines.length - pageSize);
				scroll = Math.max(0, Math.min(scroll, maxScroll));
				const visible = lines.slice(scroll, scroll + pageSize);
				const position = `Review ${scroll + 1}–${scroll + visible.length}/${lines.length}` +
					(scroll > 0 ? " ↑" : "") + (scroll < maxScroll ? " ↓" : "");
				const compactLabels = width < visibleWidth(`→ ${ASK_ALLOW} (Enter)`);
				const actionColor = allow ? "success" : "error";
				const option = (label: string, selected: boolean) => fit(
					selected
						? theme.fg(actionColor, theme.bold(`→ ${label} (Enter)`))
						: theme.fg("muted", `  ${label}`),
				);
				return [
					title,
					theme.fg("border", "─".repeat(width)),
					...visible,
					...Array(Math.max(0, pageSize - visible.length)).fill(" ".repeat(width)),
					fit(""),
					fit(theme.fg("dim", position)),
					option(compactLabels ? "Block" : ASK_DENY, !allow),
					option(compactLabels ? "Allow once" : ASK_ALLOW, allow),
					...hints,
				];
			},
			handleInput(data: string) {
				if (closed) return;
				if (Date.now() >= deadline) return cancel();
				if (keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.ctrl("c"))) return cancel();
				if (!reviewReady) return;
				if (keybindings.matches(data, "tui.select.confirm") || data === "\n") {
					return finish(allow ? ASK_ALLOW : ASK_DENY);
				}
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) allow = !allow;
				else if (matchesKey(data, Key.left)) allow = false;
				else if (matchesKey(data, Key.right)) allow = true;
				else if (keybindings.matches(data, "tui.select.up") || data === "k") scroll--;
				else if (keybindings.matches(data, "tui.select.down") || data === "j") scroll++;
				else if (matchesKey(data, Key.pageUp)) scroll -= pageSize;
				else if (matchesKey(data, Key.pageDown)) scroll += pageSize;
				else if (matchesKey(data, Key.home)) scroll = 0;
				else if (matchesKey(data, Key.end)) scroll = maxScroll;
				else return;
				scroll = Math.max(0, Math.min(scroll, maxScroll));
				tui.requestRender();
			},
			invalidate() { body.invalidate(); },
			// Hosts may tear down an overlay without first answering it.
			dispose: cancel,
		};
		return {
			...content,
			render(width: number) {
				// Overlay margins are transparent: they exposed background glyphs and
				// editor cursor markers. Own the whole rectangle, including its padding.
				const height = Math.max(1, tui.terminal.rows);
				const inset = width > 2 ? " " : "";
				const blank = " ".repeat(width);
				const lines = content.render(Math.max(1, width - 2 * inset.length))
					.map((line) => inset + line + inset);
				if (height > 2) lines.unshift(blank);
				while (lines.length < height) lines.push(blank);
				return lines.slice(0, height);
			},
		};
	}, {
		overlay: true,
		overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 },
	});
	if (opened) return choice;

	// RPC custom() is a no-op that never invokes the factory. Keep its native
	// select request (and older selector-only hosts), but never reopen a dismissal.
	return ctx.ui.select(`⚠️ Permission gate ask\n\n${prompt}\n\nAllow?`, [ASK_DENY, ASK_ALLOW], options);
}
