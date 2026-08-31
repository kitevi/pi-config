/*
 * Codex usage behavior is derived from @latentminds/pi-quotas.
 *
 * MIT License
 * Copyright (c) 2025-2026 Latent Minds Pty Ltd
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export type RateLimitLabel = `${number}${"s" | "m" | "h" | "d"}`;

export interface CodexRateLimitWindow {
	label: RateLimitLabel;
	remainingPercent: number;
	resetsAt?: Date;
}

export interface CodexUsageSnapshot {
	windows: readonly CodexRateLimitWindow[];
}

export type CodexUsageFailure =
	| { kind: "config"; reason: "missing_access_token" | "missing_account_id" }
	| { kind: "http"; status: number }
	| { kind: "timeout" | "cancelled" | "network" | "invalid_response" };

export type CodexUsageResult =
	| { ok: true; value: CodexUsageSnapshot }
	| { ok: false; error: CodexUsageFailure };

export type CodexUsageParseResult =
	| { ok: true; value: CodexUsageSnapshot }
	| { ok: false; error: { kind: "invalid_response" } };

export interface CodexModelRegistry {
	getApiKeyForProvider(provider: string): Promise<string | undefined>;
}

export interface CodexUsageRuntime {
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
	readTextFile(path: string): Promise<string>;
	now(): number;
	agentDir(): string;
	homeDir(): string;
}

interface CodexAuth {
	accessToken: string;
	accountId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function resolveCodexAuth(
	registry: CodexModelRegistry,
	runtime: CodexUsageRuntime,
): Promise<{ ok: true; value: CodexAuth } | { ok: false; error: CodexUsageFailure }> {
	const accessToken = await registry.getApiKeyForProvider("openai-codex");
	if (!accessToken) {
		return { ok: false, error: { kind: "config", reason: "missing_access_token" } };
	}

	let accountId: string | undefined;
	try {
		const credentials = JSON.parse(
			await runtime.readTextFile(join(runtime.agentDir(), "auth.json")),
		) as unknown;
		if (isRecord(credentials)) {
			const credential = credentials["openai-codex"];
			if (isRecord(credential) && typeof credential.accountId === "string") {
				accountId = credential.accountId;
			}
		}
	} catch {
		// Fall through to the Codex CLI credential file.
	}
	if (!accountId) {
		try {
			const codexAuth = JSON.parse(
				await runtime.readTextFile(join(runtime.homeDir(), ".codex", "auth.json")),
			) as unknown;
			if (isRecord(codexAuth) && isRecord(codexAuth.tokens)) {
				const candidate = codexAuth.tokens.account_id ?? codexAuth.tokens.accountId;
				if (typeof candidate === "string") accountId = candidate;
			}
		} catch {
			// Missing or unreadable Codex CLI auth is a configuration failure below.
		}
	}
	if (!accountId) {
		return { ok: false, error: { kind: "config", reason: "missing_account_id" } };
	}

	return { ok: true, value: { accessToken, accountId } };
}

export async function loadCodexUsage(
	registry: CodexModelRegistry,
	runtime: CodexUsageRuntime,
	signal: AbortSignal,
): Promise<CodexUsageResult> {
	let auth: Awaited<ReturnType<typeof resolveCodexAuth>>;
	try {
		auth = await resolveCodexAuth(registry, runtime);
	} catch {
		return { ok: false, error: { kind: "network" } };
	}
	if (!auth.ok) return auth;

	const timeoutController = new AbortController();
	const timeout = setTimeout(() => {
		timeoutController.abort(new DOMException("Request timed out", "TimeoutError"));
	}, 15_000);
	const requestSignal = AbortSignal.any([signal, timeoutController.signal]);

	const abortFailure = (): CodexUsageFailure => {
		const timedOut =
			requestSignal.reason instanceof Error && requestSignal.reason.name === "TimeoutError";
		return { kind: timedOut ? "timeout" : signal.aborted ? "cancelled" : "network" };
	};

	try {
		let response: Response;
		try {
			response = await runtime.fetch("https://chatgpt.com/backend-api/wham/usage", {
				method: "GET",
				headers: {
					Authorization: `Bearer ${auth.value.accessToken}`,
					"ChatGPT-Account-Id": auth.value.accountId,
					Accept: "application/json",
					Origin: "https://chatgpt.com",
					Referer: "https://chatgpt.com/",
					"User-Agent": "Mozilla/5.0",
				},
				signal: requestSignal,
			});
		} catch {
			return { ok: false, error: abortFailure() };
		}
		if (!response.ok) {
			return { ok: false, error: { kind: "http", status: response.status } };
		}

		let raw: unknown;
		try {
			raw = await response.json();
		} catch {
			return {
				ok: false,
				error: requestSignal.aborted ? abortFailure() : { kind: "invalid_response" },
			};
		}
		return parseCodexUsage(raw);
	} finally {
		clearTimeout(timeout);
	}
}

function finiteNumber(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const number = Number(value);
	return Number.isFinite(number) ? number : undefined;
}

function parseResetTime(value: unknown): Date | undefined {
	const number = finiteNumber(value);
	if (number === undefined) return undefined;
	const date = new Date(number > 10 ** 11 ? number : number * 1000);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

function durationLabel(seconds: number): RateLimitLabel {
	if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
	if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

function parseRateLimitWindow(
	value: unknown,
	fallbackSeconds: number,
): CodexRateLimitWindow | undefined {
	if (!isRecord(value)) return undefined;
	const remainingPercent =
		finiteNumber(value.percent_left) ??
		finiteNumber(value.remaining_percent) ??
		(() => {
			const usedPercent = finiteNumber(value.used_percent);
			return usedPercent === undefined ? undefined : 100 - usedPercent;
		})();
	if (remainingPercent === undefined) return undefined;
	const rawSeconds = finiteNumber(value.limit_window_seconds);
	const seconds = rawSeconds !== undefined && rawSeconds > 0 ? rawSeconds : fallbackSeconds;
	const resetsAt = parseResetTime(value.reset_at ?? value.reset_time_ms);

	return {
		label: durationLabel(seconds),
		remainingPercent: Math.max(0, Math.min(100, remainingPercent)),
		...(resetsAt ? { resetsAt } : {}),
	};
}

export function parseCodexUsage(raw: unknown): CodexUsageParseResult {
	if (!isRecord(raw)) {
		return { ok: false, error: { kind: "invalid_response" } };
	}
	const rateLimit = isRecord(raw.rate_limit)
		? raw.rate_limit
		: isRecord(raw.rate_limits)
			? raw.rate_limits
			: undefined;
	if (!rateLimit) return { ok: false, error: { kind: "invalid_response" } };

	const primary =
		rateLimit.primary_window ??
		rateLimit.primary ??
		rateLimit.five_hour_limit ??
		rateLimit.five_hour;
	const secondary =
		rateLimit.secondary_window ??
		rateLimit.secondary ??
		rateLimit.weekly_limit ??
		rateLimit.weekly;
	const windows = [
		parseRateLimitWindow(primary, 5 * 60 * 60),
		parseRateLimitWindow(secondary, 7 * 24 * 60 * 60),
	].filter((window): window is CodexRateLimitWindow => window !== undefined);

	return { ok: true, value: { windows } };
}

export interface ThemeLike {
	fg(color: string, text: string): string;
}

export function formatTimeRemaining(resetsAt: Date, nowMs: number): string {
	const ms = resetsAt.getTime() - nowMs;
	if (ms <= 0) return "now";

	const totalMinutes = Math.ceil(ms / 60_000);
	const totalHours = Math.floor(totalMinutes / 60);
	const days = Math.floor(totalHours / 24);
	const hours = totalHours % 24;
	const minutes = totalMinutes % 60;

	if (days >= 1) {
		return `${days}d${hours > 0 ? `${hours}h` : ""}${minutes > 0 ? `${minutes}m` : ""}`;
	}
	if (hours >= 1) return `${hours}h${minutes > 0 ? `${minutes}m` : ""}`;
	if (totalMinutes >= 1) return `${totalMinutes}m`;
	return `${Math.ceil(ms / 1000)}s`;
}

function usageColor(remainingPercent: number): "success" | "warning" | "error" {
	if (remainingPercent <= 10) return "error";
	if (remainingPercent <= 20) return "warning";
	return "success";
}

export function formatCodexUsage(
	theme: ThemeLike,
	snapshot: CodexUsageSnapshot,
	nowMs: number,
): string | undefined {
	if (snapshot.windows.length === 0) return undefined;

	return snapshot.windows
		.map((window) => {
			const remaining = Math.max(0, Math.min(100, Math.round(window.remainingPercent)));
			const color = usageColor(remaining);
			const labelColor = color === "success" ? "dim" : color;
			const label = theme.fg(labelColor, `${window.label}:`);
			const value = theme.fg(color, `${remaining}% left`);
			const reset = window.resetsAt
				? theme.fg("dim", ` (↺in ${formatTimeRemaining(window.resetsAt, nowMs)})`)
				: "";
			return `${label}${value}${reset}`;
		})
		.join(" ");
}

const STATUS_ID = "codex-usage";
const REFRESH_INTERVAL_MS = 60_000;

const defaultRuntime: CodexUsageRuntime = {
	fetch: (input, init) => globalThis.fetch(input, init),
	readTextFile: (path) => readFile(path, "utf8"),
	now: () => Date.now(),
	agentDir: () => getAgentDir(),
	homeDir: () => homedir(),
};

export function createCodexUsageExtension(
	runtime: CodexUsageRuntime = defaultRuntime,
): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		let timer: ReturnType<typeof setInterval> | undefined;
		let controller: AbortController | undefined;
		let inFlight: Promise<void> | undefined;
		let cached: CodexUsageSnapshot | undefined;
		let nextFetchAt = 0;

		const stop = (ctx?: ExtensionContext): void => {
			if (timer) clearInterval(timer);
			timer = undefined;
			controller?.abort();
			controller = undefined;
			inFlight = undefined;
			cached = undefined;
			nextFetchAt = 0;
			if (ctx?.hasUI) ctx.ui.setStatus(STATUS_ID, undefined);
		};

		const refresh = async (ctx: ExtensionContext): Promise<void> => {
			if (!ctx.hasUI || ctx.model?.provider !== "openai-codex") return;
			const now = runtime.now();
			if (now < nextFetchAt) {
				if (cached) {
					ctx.ui.setStatus(STATUS_ID, formatCodexUsage(ctx.ui.theme, cached, now));
				}
				return;
			}
			if (inFlight) return inFlight;

			const requestController = new AbortController();
			controller = requestController;
			const request = (async () => {
				const result = await loadCodexUsage(
					ctx.modelRegistry,
					runtime,
					requestController.signal,
				);
				if (requestController.signal.aborted) return;
				const completedAt = runtime.now();
				if (!result.ok) {
					nextFetchAt = completedAt + 10_000;
					ctx.ui.setStatus(STATUS_ID, undefined);
					return;
				}
				cached = result.value;
				nextFetchAt = completedAt + REFRESH_INTERVAL_MS;
				ctx.ui.setStatus(
					STATUS_ID,
					formatCodexUsage(ctx.ui.theme, result.value, completedAt),
				);
			})();
			inFlight = request;
			try {
				await request;
			} finally {
				if (inFlight === request) inFlight = undefined;
				if (controller === requestController) controller = undefined;
			}
		};

		const activate = async (ctx: ExtensionContext, provider: string | undefined): Promise<void> => {
			stop(ctx);
			if (!ctx.hasUI || provider !== "openai-codex") return;
			timer = setInterval(() => {
				void refresh(ctx).catch(() => undefined);
			}, REFRESH_INTERVAL_MS);
			timer.unref?.();
			await refresh(ctx);
		};

		pi.on("session_start", async (_event, ctx) => {
			await activate(ctx, ctx.model?.provider);
		});

		pi.on("turn_end", async (_event, ctx) => {
			await refresh(ctx);
		});

		pi.on("model_select", async (event, ctx) => {
			await activate(ctx, event.model.provider);
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			stop(ctx);
		});
	};
}

export default createCodexUsageExtension();
