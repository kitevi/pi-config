/**
 * Desktop Notifications Extension
 *
 * Requests CSI mode 1004 focus reports and raises attention notifications only
 * after Pi's terminal surface is known to be unfocused. Ghostty uses native OSC
 * 777 notifications on both Linux and macOS; OS focus/notification adapters are
 * conservative best-effort fallbacks when terminal protocols are unavailable.
 *
 * The agent_settled "waiting" notification is debounced: when a new agent run
 * starts within the delay (auto-retry, compaction retry, queued follow-up),
 * the settle was transient and no notification is sent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile, spawn } from "node:child_process";

const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";
type RunDetached = (command: string, args: string[]) => void;
type ReadCommand = (command: string, args: string[]) => Promise<string | undefined>;

type FocusState = "unknown" | "focused" | "unfocused";

const DEFAULT_SETTLE_NOTIFY_DELAY_MS = 10_000;

export type DesktopNotificationDependencies = {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	writeTerminal: (data: string) => void;
	runDetached: RunDetached;
	readCommand?: ReadCommand;
	/** Delay before honoring agent_settled; a resumed run cancels the notification. */
	settleNotifyDelayMs?: number;
	setTimer?: (fn: () => void, delayMs: number) => unknown;
	clearTimer?: (handle: unknown) => void;
};

const runtimeDependencies: DesktopNotificationDependencies = {
	platform: process.platform,
	env: process.env,
	writeTerminal: (data) => process.stdout.write(data),
	readCommand: (command, args) =>
		new Promise((resolve) => {
			execFile(command, args, { encoding: "utf8", timeout: 1000 }, (error, stdout) => {
				resolve(error ? undefined : stdout);
			});
		}),
	runDetached: (command, args) => {
		try {
			const child = spawn(command, args, { detached: true, stdio: "ignore" });
			child.on("error", () => {});
			child.unref();
		} catch {
			// Desktop notifications are best-effort.
		}
	},
};

const safeNotificationField = (value: string) =>
	value
		.replace(/[\x00-\x1f\x7f;]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 200);

export const createDesktopNotificationSender = (dependencies: DesktopNotificationDependencies) => {
	const terminal = `${dependencies.env.TERM_PROGRAM ?? ""} ${dependencies.env.TERM ?? ""}`.toLowerCase();
	const usesOsc777 = /ghostty|iterm|wezterm|rxvt/.test(terminal);

	return (rawTitle: string, rawBody: string) => {
		const title = safeNotificationField(rawTitle);
		const body = safeNotificationField(rawBody);

		try {
			if (dependencies.env.KITTY_WINDOW_ID) {
				dependencies.writeTerminal(`\x1b]99;i=pi:d=0;${title}\x1b\\\x1b]99;i=pi:p=body;${body}\x1b\\`);
				return;
			}
			if (usesOsc777) {
				dependencies.writeTerminal(`\x1b]777;notify;${title};${body}\x1b\\`);
				return;
			}
		} catch {
			// Fall through to the operating-system adapter.
		}

		try {
			if (dependencies.platform === "linux") {
				dependencies.runDetached("notify-send", ["--app-name", "Pi", "--urgency", "normal", title, body]);
			}
			if (dependencies.platform === "darwin") {
				dependencies.runDetached("osascript", [
					"-e",
					"on run argv",
					"-e",
					"display notification (item 2 of argv) with title (item 1 of argv)",
					"-e",
					"end run",
					title,
					body,
				]);
			}
		} catch {
			// Desktop notifications are best-effort.
		}
	};
};

const parseWindowId = (value: string | undefined) => {
	if (!value) return undefined;
	const match = value.trim().match(/^(?:0x[0-9a-f]+|\d+)$/i);
	if (!match) return undefined;
	try {
		return BigInt(match[0]);
	} catch {
		return undefined;
	}
};

const MAC_TERMINAL_APPLICATIONS: Record<string, string> = {
	apple_terminal: "terminal",
	ghostty: "ghostty",
	"iterm.app": "iterm2",
	kitty: "kitty",
	vscode: "code",
	wezterm: "wezterm",
};

const probeFallbackFocus = async (dependencies: DesktopNotificationDependencies): Promise<FocusState> => {
	if (!dependencies.readCommand) return "unknown";

	try {
		if (dependencies.platform === "linux" && dependencies.env.DISPLAY && dependencies.env.WINDOWID) {
			const output = await dependencies.readCommand("xprop", ["-root", "_NET_ACTIVE_WINDOW"]);
			const active = output?.match(/window id #\s*(0x[0-9a-f]+|\d+)/i)?.[1];
			const activeId = parseWindowId(active);
			const ownId = parseWindowId(dependencies.env.WINDOWID);
			if (activeId === undefined || ownId === undefined) return "unknown";
			return activeId === ownId ? "focused" : "unfocused";
		}

		if (dependencies.platform === "darwin") {
			const terminal = MAC_TERMINAL_APPLICATIONS[(dependencies.env.TERM_PROGRAM ?? "").toLowerCase()];
			if (!terminal) return "unknown";
			const output = await dependencies.readCommand("osascript", [
				"-e",
				'tell application "System Events" to get name of first application process whose frontmost is true',
			]);
			if (!output?.trim()) return "unknown";
			return output.trim().toLowerCase() === terminal ? "focused" : "unfocused";
		}
	} catch {
		return "unknown";
	}

	return "unknown";
};

export const createDesktopNotificationsExtension = (dependencies: DesktopNotificationDependencies) => {
	return (pi: ExtensionAPI) => {
		let focus: FocusState = "unknown";
		let stopTerminalInput: (() => void) | undefined;
		let focusReportingEnabled = false;
		let tuiSessionActive = false;
		const notify = createDesktopNotificationSender(dependencies);
		const settleDelayMs = dependencies.settleNotifyDelayMs ?? DEFAULT_SETTLE_NOTIFY_DELAY_MS;
		const setTimer = dependencies.setTimer ?? ((fn: () => void, delayMs: number) => setTimeout(fn, delayMs));
		const clearTimer =
			dependencies.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
		let settleTimer: unknown;
		let agentBusy = false;

		const cancelSettleNotification = () => {
			if (settleTimer === undefined) return;
			clearTimer(settleTimer);
			settleTimer = undefined;
		};

		const focusForAttention = async () => {
			if (!tuiSessionActive) return "unknown";
			if (focus !== "unknown") return focus;
			const fallback = await probeFallbackFocus(dependencies);
			if (!tuiSessionActive) return "unknown";
			return focus === "unknown" ? fallback : focus;
		};

		const writeTerminalSafely = (data: string) => {
			try {
				dependencies.writeTerminal(data);
				return true;
			} catch {
				return false;
			}
		};

		const stopFocusTracking = () => {
			stopTerminalInput?.();
			stopTerminalInput = undefined;
			if (focusReportingEnabled) writeTerminalSafely(DISABLE_FOCUS_REPORTING);
			focusReportingEnabled = false;
			tuiSessionActive = false;
			focus = "unknown";
		};

		pi.on("session_start", (_event, ctx) => {
			stopFocusTracking();
			agentBusy = false;
			cancelSettleNotification();
			if (ctx.mode !== "tui") return;
			tuiSessionActive = true;

			stopTerminalInput = ctx.ui.onTerminalInput((data) => {
				let sawFocusReport = false;
				const remaining = data.replace(/\x1b\[([IO])/g, (_report, marker: string) => {
					focus = marker === "I" ? "focused" : "unfocused";
					sawFocusReport = true;
					return "";
				});
				if (!sawFocusReport) return undefined;
				return remaining.length === 0 ? { consume: true } : { data: remaining };
			});
			focusReportingEnabled = writeTerminalSafely(ENABLE_FOCUS_REPORTING);
		});

		pi.on("agent_start", () => {
			// A run starting means any pending settle was transient (auto-retry,
			// compaction retry, queued follow-up); stay silent.
			agentBusy = true;
			cancelSettleNotification();
		});

		pi.on("agent_settled", (_event, ctx) => {
			agentBusy = false;
			cancelSettleNotification();
			if (!ctx.isIdle() || focus === "focused") return;
			const notifyWaiting = () => notify("Pi is waiting for you", "The agent has finished and is ready for input.");
			// Debounce: only notify if the agent is still settled when the delay
			// elapses, re-checking busy/focus state at fire time.
			settleTimer = setTimer(() => {
				settleTimer = undefined;
				if (agentBusy || !ctx.isIdle() || focus === "focused") return;
				if (focus === "unfocused") {
					notifyWaiting();
					return;
				}
				void focusForAttention().then((current) => {
					if (current === "unfocused" && !agentBusy) notifyWaiting();
				});
			}, settleDelayMs);
		});

		const stopGateAskListener = pi.events.on("permission_gate:ask", (data) => {
			if (focus === "focused" || !data || typeof data !== "object") return;
			const timeoutMs = (data as { timeoutMs?: unknown }).timeoutMs;
			const body =
				typeof timeoutMs === "number" && timeoutMs > 0
					? `Approval auto-blocks in ${Math.round(timeoutMs / 1000)}s.`
					: "Approval is waiting.";
			const notifyGateAsk = () => notify("Pi needs permission", body);
			if (focus === "unfocused") {
				notifyGateAsk();
				return;
			}
			void focusForAttention().then((current) => {
				if (current === "unfocused") notifyGateAsk();
			});
		});

		pi.on("session_shutdown", () => {
			stopFocusTracking();
			stopGateAskListener();
			agentBusy = false;
			cancelSettleNotification();
		});
	};
};

export default createDesktopNotificationsExtension(runtimeDependencies);
