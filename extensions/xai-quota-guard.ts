/**
 * xAI Quota Guard
 *
 * Keeps part of the SuperGrok weekly pool for other Grok clients. On
 * `xai-oauth` models (pi-grok), prompts are refused and running agent loops
 * are aborted once the pool's `creditUsagePercent` reaches 65%. The billing
 * endpoint is unofficial; when it cannot be read, the guard warns and lets
 * the turn through.
 *
 * Also hides pi-grok's `x_search` tool before every run, so searches never
 * draw from the same pool.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const GUARDED_PROVIDER = "xai-oauth";
export const QUOTA_LIMIT_PERCENT = 65;
export const DISABLED_TOOLS = ["x_search"];
export const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

export interface QuotaSnapshot {
	percent: number;
	resetsAt?: string;
}

export type FetchQuota = (token: string) => Promise<QuotaSnapshot>;

export async function fetchQuota(token: string): Promise<QuotaSnapshot> {
	const response = await fetch(BILLING_URL, {
		headers: { Authorization: `Bearer ${token}`, "X-XAI-Token-Auth": "xai-grok-cli" },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`billing endpoint returned HTTP ${response.status}`);
	const body = (await response.json()) as {
		config?: { creditUsagePercent?: unknown; currentPeriod?: { end?: unknown } };
	};
	const config = body.config;
	if (!config?.currentPeriod) throw new Error("billing response has no current period");
	// xAI omits the percentage while the period is still unused.
	const percent = typeof config.creditUsagePercent === "number" ? config.creditUsagePercent : 0;
	const end = config.currentPeriod.end;
	return { percent, ...(typeof end === "string" ? { resetsAt: end } : {}) };
}

export function exhaustedMessage(snapshot: QuotaSnapshot): string {
	const reset = snapshot.resetsAt ? ` It resets ${new Date(snapshot.resetsAt).toLocaleString()}.` : "";
	return `SuperGrok weekly usage is at ${snapshot.percent}%, the ${QUOTA_LIMIT_PERCENT}% limit kept for other Grok clients.${reset} Switch models to continue.`;
}

export default function (pi: ExtensionAPI, loadQuota: FetchQuota = fetchQuota) {
	let cached: { snapshot: QuotaSnapshot; at: number } | undefined;

	const hideDisabledTools = () => {
		const active = pi.getActiveTools();
		const kept = active.filter((name) => !DISABLED_TOOLS.includes(name));
		if (kept.length !== active.length) pi.setActiveTools(kept);
	};

	/** The current snapshot, or undefined when the model is unguarded or the lookup failed. */
	const quotaFor = async (ctx: ExtensionContext): Promise<QuotaSnapshot | undefined> => {
		if (ctx.model?.provider !== GUARDED_PROVIDER) return undefined;
		if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.snapshot;
		try {
			const token = await ctx.modelRegistry.getApiKeyForProvider(GUARDED_PROVIDER);
			if (!token) throw new Error("not logged in");
			const snapshot = await loadQuota(token);
			cached = { snapshot, at: Date.now() };
			return snapshot;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`xAI quota guard could not read usage (${reason}); not blocking.`, "warning");
			return undefined;
		}
	};

	pi.on("session_start", hideDisabledTools);
	pi.on("before_agent_start", hideDisabledTools);

	pi.on("input", async (_event, ctx) => {
		const snapshot = await quotaFor(ctx);
		if (!snapshot || snapshot.percent < QUOTA_LIMIT_PERCENT) return { action: "continue" };
		ctx.ui.notify(exhaustedMessage(snapshot), "error");
		return { action: "handled" };
	});

	// A tool loop keeps requesting without new input, so recheck each turn.
	pi.on("turn_start", async (_event, ctx) => {
		const snapshot = await quotaFor(ctx);
		if (!snapshot || snapshot.percent < QUOTA_LIMIT_PERCENT) return;
		ctx.ui.notify(exhaustedMessage(snapshot), "error");
		ctx.abort();
	});
}
