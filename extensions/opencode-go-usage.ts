import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export type UsedPercent = number & { readonly __brand: "UsedPercent" };

export type OpenCodeGoWindowId = "rolling" | "weekly" | "monthly";
export type OpenCodeGoWindowLabel = "5h" | "wk" | "mo";

export interface OpenCodeGoUsageWindow {
	id: OpenCodeGoWindowId;
	label: OpenCodeGoWindowLabel;
	usedPercent: UsedPercent;
	resetsAt: Date;
	limited: boolean;
}

export interface OpenCodeGoUsageSnapshot {
	source: "opencode-go-server";
	windows: readonly OpenCodeGoUsageWindow[];
}

export type OpenCodeGoUsageFailure =
	| { kind: "config"; reason: "missing_api_key" }
	| { kind: "http"; status: number }
	| { kind: "timeout" }
	| { kind: "cancelled" }
	| { kind: "network" }
	| { kind: "invalid_response" };

export type OpenCodeGoUsageResult =
	| { ok: true; value: OpenCodeGoUsageSnapshot }
	| { ok: false; error: OpenCodeGoUsageFailure };

export interface ThemeLike {
	fg(color: string, text: string): string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUsedPercent(value: unknown): UsedPercent | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	if (value < 0 || value > 100) return undefined;
	return value as UsedPercent;
}

function parseReset(value: unknown): Date | undefined {
	if (typeof value !== "string") return undefined;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

const WINDOW_METADATA = [
	["rolling", "5h"],
	["weekly", "wk"],
	["monthly", "mo"],
] as const;

function parseWindow(
	usage: Record<string, unknown>,
	id: OpenCodeGoWindowId,
	label: OpenCodeGoWindowLabel,
): OpenCodeGoUsageWindow | undefined {
	const raw = usage[id];
	if (!isRecord(raw)) return undefined;
	if (raw.status !== "ok" && raw.status !== "rate-limited") return undefined;
	const usedPercent = parseUsedPercent(raw.percent);
	const resetsAt = parseReset(raw.resetsAt);
	if (usedPercent === undefined || !resetsAt) return undefined;
	return {
		id,
		label,
		usedPercent,
		resetsAt,
		limited: raw.status === "rate-limited",
	};
}

export function parseOpenCodeGoUsage(raw: unknown): OpenCodeGoUsageResult {
	if (!isRecord(raw) || !isRecord(raw.usage)) {
		return { ok: false, error: { kind: "invalid_response" } };
	}

	const windows = WINDOW_METADATA
		.map(([id, label]) => parseWindow(raw.usage as Record<string, unknown>, id, label))
		.filter((window): window is OpenCodeGoUsageWindow => window !== undefined);
	if (windows.length === 0) {
		return { ok: false, error: { kind: "invalid_response" } };
	}

	return { ok: true, value: { source: "opencode-go-server", windows } };
}

export interface OpenCodeGoModelRegistry {
	getApiKeyForProvider(provider: string): Promise<string | undefined>;
}

export interface OpenCodeGoUsageRuntime {
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
	now(): number;
}

const USAGE_API_URL = "https://opencode.ai/zen/go/v1/usage";
const REQUEST_TIMEOUT_MS = 15_000;

export async function loadOpenCodeGoUsage(
	registry: OpenCodeGoModelRegistry,
	runtime: OpenCodeGoUsageRuntime,
	signal: AbortSignal,
): Promise<OpenCodeGoUsageResult> {
	let apiKey: string | undefined;
	try {
		apiKey = await registry.getApiKeyForProvider("opencode-go");
	} catch {
		return { ok: false, error: { kind: "network" } };
	}
	if (!apiKey) {
		return {
			ok: false,
			error: { kind: "config", reason: "missing_api_key" },
		};
	}

	const timeoutController = new AbortController();
	const timeout = setTimeout(() => {
		timeoutController.abort(new DOMException("Request timed out", "TimeoutError"));
	}, REQUEST_TIMEOUT_MS);
	timeout.unref?.();
	const requestSignal = AbortSignal.any([signal, timeoutController.signal]);
	const abortFailure = (): OpenCodeGoUsageFailure => {
		const timedOut =
			requestSignal.reason instanceof Error && requestSignal.reason.name === "TimeoutError";
		return { kind: timedOut ? "timeout" : signal.aborted ? "cancelled" : "network" };
	};

	try {
		let response: Response;
		try {
			response = await runtime.fetch(USAGE_API_URL, {
				method: "GET",
				redirect: "error",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					Accept: "application/json",
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
		return parseOpenCodeGoUsage(raw);
	} finally {
		clearTimeout(timeout);
	}
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

function usageColor(usedPercent: number, limited: boolean): "success" | "warning" | "error" {
	if (limited || usedPercent >= 90) return "error";
	if (usedPercent >= 80) return "warning";
	return "success";
}

function formatUsedPercent(usedPercent: UsedPercent): string {
	return `${String(usedPercent)}% used`;
}

export function formatOpenCodeGoUsage(
	theme: ThemeLike,
	snapshot: OpenCodeGoUsageSnapshot,
	nowMs: number,
): string | undefined {
	if (snapshot.windows.length === 0) return undefined;

	return snapshot.windows
		.map((window) => {
			const color = usageColor(window.usedPercent, window.limited);
			const labelColor = color === "success" ? "dim" : color;
			const label = theme.fg(labelColor, `${window.label}:`);
			const value = theme.fg(color, formatUsedPercent(window.usedPercent));
			const reset = theme.fg("dim", ` (↺in ${formatTimeRemaining(window.resetsAt, nowMs)})`);
			return `${label}${value}${reset}`;
		})
		.join(" ");
}

const STATUS_ID = "opencode-go-usage";
const REFRESH_INTERVAL_MS = 60_000;
const FAILURE_RETRY_MS = 10_000;

const defaultRuntime: OpenCodeGoUsageRuntime = {
	fetch: (input, init) => globalThis.fetch(input, init),
	now: () => Date.now(),
};

function isOpenCodeGoProvider(provider: string | undefined): boolean {
	return provider === "opencode-go" || provider?.startsWith("opencode-go/") === true;
}

export function createOpenCodeGoUsageExtension(
	runtime: OpenCodeGoUsageRuntime = defaultRuntime,
): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		let timer: ReturnType<typeof setInterval> | undefined;
		let controller: AbortController | undefined;
		let inFlight: Promise<void> | undefined;
		let cached: OpenCodeGoUsageSnapshot | undefined;
		let nextFetchAt = 0;
		let generation = 0;

		const stop = (ctx?: ExtensionContext): void => {
			if (timer) clearInterval(timer);
			timer = undefined;
			controller?.abort();
			controller = undefined;
			inFlight = undefined;
			cached = undefined;
			nextFetchAt = 0;
			generation++;
			if (ctx?.hasUI) ctx.ui.setStatus(STATUS_ID, undefined);
		};

		const refresh = async (ctx: ExtensionContext): Promise<void> => {
			if (!ctx.hasUI || !isOpenCodeGoProvider(ctx.model?.provider)) return;
			const requestGeneration = generation;
			const now = runtime.now();
			if (now < nextFetchAt) {
				if (cached) {
					ctx.ui.setStatus(STATUS_ID, formatOpenCodeGoUsage(ctx.ui.theme, cached, now));
				}
				return;
			}
			if (inFlight) return inFlight;

			const requestController = new AbortController();
			controller = requestController;
			const request = (async () => {
				const result = await loadOpenCodeGoUsage(
					ctx.modelRegistry,
					runtime,
					requestController.signal,
				);
				if (requestController.signal.aborted || requestGeneration !== generation) return;
				const completedAt = runtime.now();
				if (!result.ok) {
					nextFetchAt = completedAt + FAILURE_RETRY_MS;
					ctx.ui.setStatus(STATUS_ID, undefined);
					return;
				}
				cached = result.value;
				nextFetchAt = completedAt + REFRESH_INTERVAL_MS;
				ctx.ui.setStatus(
					STATUS_ID,
					formatOpenCodeGoUsage(ctx.ui.theme, result.value, completedAt),
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

		const activate = async (
			ctx: ExtensionContext,
			provider: string | undefined,
		): Promise<void> => {
			stop(ctx);
			if (!ctx.hasUI || !isOpenCodeGoProvider(provider)) return;
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

export default createOpenCodeGoUsageExtension();
