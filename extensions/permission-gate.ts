/**
 * Permission gate
 *
 * A tripwire, not a policy engine: the model-facing system guidance owns
 * judgment calls, and this extension only asks before calls whose failure would
 * be catastrophic, leak credentials, or write Git history and working trees
 * (commits, pushes, rebases, and whole-tree checkouts are recoverable in
 * principle but easy to do by accident, so they ask). Routine work never
 * prompts.
 *
 * Everything pivots on a small rule table matched against the raw command text
 * — no lexer, no session state, no block/ask split. A rule match raises one ask;
 * no match lets the call run. There is no block decision: with no UI the ask
 * fails closed, and a declined ask blocks the call and aborts the turn so the
 * model cannot immediately retry the same work in another form.
 *
 * Known blind spots, accepted deliberately: variable-target deletions
 * (`find "$d" -delete`, `find | xargs rm`) cannot be judged statically, and the
 * POSIX-shaped patterns do not parse PowerShell idioms (`Remove-Item
 * -Recurse`). Judgment-shaped calls — publishing, truncates — belong to the
 * system prompt, not here.
 *
 * Static text matching cannot stop a determined bypass (an obfuscated payload
 * defeats any matcher); it prevents the plausible accident. For a hard
 * boundary, run Pi in a container instead — see docs/security.md upstream.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

export type Assessment =
	| { decision: "allow" }
	| { decision: "ask"; reason: string; target: string };

export type AssessmentContext = { cwd?: string };

type Rule = { reason: string; test: RegExp | ((text: string, cwd: string) => boolean) };

// ─── rules ───────────────────────────────────────────────────────────────────
// One entry per invariant. Keep each test readable enough to audit at a glance;
// a false positive costs one dialog, a false negative costs nothing the user
// cannot recover from — except here, so these stay few and deliberate.

const HOME = homedir();

const SECRETS: RegExp[] = [
	/\.ssh\/id_\w+(?![\w.])/, // private SSH keys; *.pub and ssh config stay open
	/\.gnupg(?:\/|\b)/,
	/\.aws\/credentials\b/,
	/\.config\/gcloud\b/,
	/\.azure\//,
	/\.docker\/config\.json\b/,
	/\.kube\/config\b/,
	/\.git-credentials\b/,
	/\.config\/gh\/hosts\.yml\b/,
	/\.pi\/agent\/auth\.json\b/,
];

// Recursive rm/chmod/chown aimed outside the project. Every target is
// resolved against the project before judging, so in-project targets stay
// silent while /, ~, .., the project root itself, a bare glob, or .git ask.
const RECURSIVE_TOOLS = new Set(["rm", "chmod", "chown", "chgrp"]);
const SAFE_ROOTS = ["/tmp", "/var/tmp"];

// Normalize paths lexically before judging them: ./.., cwd/../x, and
// /tmp/../home/x must not pass because their prefixes look harmless.
const isCriticalTarget = (arg: string, cwd: string) => {
	const stripped = arg.replace(/^["']+|["']+$/g, "");
	if (/^(?:\.|\.\/|\*|\.\/\*)$/.test(stripped)) return true;
	if (stripped.endsWith(".git") || stripped.endsWith(".git/")) return true;
	const expanded = stripped.replace(/^(?:~|\$\{?HOME\}?)(?=\/|$)/, HOME);
	const absolute = resolve(cwd, expanded);
	if (absolute === cwd) return true;
	if (absolute.startsWith(`${cwd}${sep}`)) return false;
	return !SAFE_ROOTS.some((root) => absolute.startsWith(`${root}${sep}`));
};

const recursiveOutsideProject = (text: string, cwd: string) =>
	text.split(/[;&|\n()`]+/).some((segment) => {
		const words = segment
			.trim()
			.split(/\s+/)
			.map((word) => word.replace(/^["']+|["']+$/g, ""));
		const at = words.findIndex((word) => RECURSIVE_TOOLS.has(word.replace(/^.*\//, "")));
		if (at < 0) return false;
		const args = words.slice(at + 1);
		const recursive = args.some((arg) => /^-[a-zA-Z]*[rR]/.test(arg) || arg === "--recursive");
		return recursive && args.some((arg) => !arg.startsWith("-") && isCriticalTarget(arg, cwd));
	});

const RULES: Rule[] = [
	{ reason: "touches credential material", test: (text) => SECRETS.some((secret) => secret.test(text)) },
	{ reason: "recursively deletes or re-permissions files outside the project", test: recursiveOutsideProject },
	{
		reason: "writes a disk device or filesystem",
		test: /\b(?:mkfs(?:\.\w+)?|wipefs|fdisk|sfdisk|sgdisk|parted|blkdiscard)\b|\bof=\/dev\/(?!null\b)|>\s*\/dev\/(?:sd|nvme|hd|vd|xvd|mmcblk|rdisk|disk)/,
	},
	{
		reason: "rewrites or deletes remote Git history",
		test: /\bgit\b[^;&|\n]*\bpush\b[^;&|\n]*(?:\s(?:-[a-zA-Z]*f|--force(?:-with-lease)?|--mirror|--delete|-d)\b|\s\+\S|\s:\S)/,
	},
	{ reason: "records a Git commit", test: /\bgit\b[^;&|\n]*\bcommit\b/ },
	{ reason: "pushes to a remote Git repository", test: /\bgit\b[^;&|\n]*\bpush\b/ },
	{
		reason: "discards uncommitted work",
		test: /\bgit\b[^;&|\n]*\b(?:reset\b[^;&|\n]*--hard|clean\b[^;&|\n]*\s(?:-[a-z]*f|--force))/,
	},
	// Whole-tree checkout/restore discards every uncommitted change at once.
	// restore --staged . (or -S) only unstages, so staged-only restores stay
	// silent unless --worktree (or -W) joins them.
	{
		reason: "discards uncommitted work",
		test: /\bgit\b[^;&|\n]*\b(?:checkout|restore)\b(?:(?![^;&|\n]*\s(?:--staged|-S)\b)|(?=[^;&|\n]*\s(?:--worktree|-W)\b))[^;&|\n]*\s\.(?:[\s;&|]|$)/,
	},
	// filter-branch and filter-repo rewrite existing commits; rebase rewrites
	// the local branch (--abort undoes one, so it stays silent).
	{
		reason: "rewrites local Git history",
		test: /\bgit\b[^;&|\n]*\b(?:filter-branch|filter-repo)\b|\bgit\b[^;&|\n]*\brebase\b(?![^;&|\n]*\s--abort\b)/,
	},
	{ reason: "runs with elevated privileges", test: /(?:^|[\s;&|('"])(?:sudo|doas|pkexec|run0)\s/ },
	{
		reason: "drops database objects",
		test: /\b(?:psql|mysql|mariadb|sqlite3|sqlcmd|mongosh|duckdb)\b[^\n]*\bdrop\s+(?:database|schema|table)\b/i,
	},
];

// ─── assessment ──────────────────────────────────────────────────────────────

const firstMatch = (text: string, cwd: string) =>
	RULES.find(({ test }) => (typeof test === "function" ? test(text, cwd) : test.test(text)))?.reason;

const stringInput = (input: unknown, key: string) => {
	if (typeof input !== "object" || input === null) return "";
	const value = Reflect.get(input, key);
	return typeof value === "string" ? value.trim() : "";
};

const SHELL_TOOLS = new Set(["bash", "powershell"]);
const PATH_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write"]);

export const assessToolCall = (toolName: string, input: unknown, context: AssessmentContext = {}): Assessment => {
	const cwd = context.cwd ?? process.cwd();
	if (SHELL_TOOLS.has(toolName)) {
		const command = stringInput(input, "command");
		if (!command) return { decision: "allow" };
		const reason = firstMatch(command, cwd);
		return reason ? { decision: "ask", reason, target: command } : { decision: "allow" };
	}
	if (PATH_TOOLS.has(toolName)) {
		const path = stringInput(input, "path");
		if (!path) return { decision: "allow" };
		const absolute = resolve(cwd, path.replace(/^~(?=\/|$)/, HOME));
		const reason = SECRETS.some((secret) => secret.test(absolute)) ? "touches credential material" : undefined;
		return reason ? { decision: "ask", reason, target: `${toolName}: ${path}` } : { decision: "allow" };
	}
	return { decision: "allow" };
};

// ─── runtime ─────────────────────────────────────────────────────────────────

const ASK_ALLOW = "Allow once";
const ASK_DENY = "Block it";
const MAX_PREVIEW_LINES = 30;

const askTimeoutMs = () => {
	const override = Number(process.env["PI_GATE_ASK_TIMEOUT_MS"]);
	return override > 0 ? override : 60_000;
};

const preview = (target: string) => {
	const lines = target.split("\n");
	if (lines.length <= MAX_PREVIEW_LINES) return target;
	return `${lines.slice(0, MAX_PREVIEW_LINES).join("\n")}\n… (${lines.length - MAX_PREVIEW_LINES} more lines)`;
};

export default function (pi: ExtensionAPI) {
	// Pi can issue parallel tool calls, while its built-in selector owns one UI
	// slot and can overwrite an unresolved ask. Keep one review active and use
	// an epoch so a denial blocks siblings queued behind it.
	let askSlot: Promise<void> = Promise.resolve();
	let askEpoch = 0;

	pi.on("agent_start", () => {
		askEpoch++;
	});

	pi.on("tool_call", async (event, ctx) => {
		const assessment = assessToolCall(event.toolName, event.input, { cwd: ctx.cwd });
		if (assessment.decision === "allow") return undefined;

		const reason = `Permission gate: ${assessment.reason}.`;
		if (!ctx.hasUI) return { block: true, reason: `${reason} Confirmation needs an interactive session.` };

		const timeoutMs = askTimeoutMs();
		const signal = ctx.signal;
		const myEpoch = askEpoch;
		const previous = askSlot;
		let releaseSlot: () => void = () => {};
		askSlot = new Promise((resolve) => {
			releaseSlot = resolve;
		});

		await previous;
		if (askEpoch !== myEpoch || signal?.aborted) {
			releaseSlot();
			return { block: true, reason };
		}

		let choice: string | undefined;
		const controller = new AbortController();
		const cancelAsk = () => controller.abort();
		signal?.addEventListener("abort", cancelAsk, { once: true });
		try {
			pi.events.emit("permission_gate:ask", { reason: assessment.reason, target: assessment.target, timeoutMs });
		} catch {
			// Notification listeners are advisory; the ask must still run.
		}
		try {
			choice = await ctx.ui.select(
				`⚠ Permission gate: ${assessment.reason}\n\n${preview(assessment.target)}`,
				[ASK_DENY, ASK_ALLOW],
				{ timeout: timeoutMs, signal: controller.signal },
			);
		} finally {
			signal?.removeEventListener("abort", cancelAsk);
			releaseSlot();
		}

		if (choice === ASK_ALLOW && askEpoch === myEpoch && !signal?.aborted) return undefined;
		if (signal?.aborted && !controller.signal.aborted) return { block: true, reason };

		// Declined, dismissed, or unanswered: block the call and end the turn so
		// the model cannot immediately retry the same work in another form.
		askEpoch++;
		const outcome = `${reason} The user did not approve this call and the turn was stopped. Do not retry it in another form; wait for the user.`;
		setTimeout(() => {
			try {
				ctx.abort();
			} catch {
				// The run may already have ended; nothing to abort.
			}
		}, 0);
		return { block: true, reason: outcome };
	});
}
