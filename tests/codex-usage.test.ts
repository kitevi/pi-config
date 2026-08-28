import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { describe, it, vi } from "vitest";
import {
	createCodexUsageExtension,
	formatCodexUsage,
	loadCodexUsage,
	parseCodexUsage,
	type CodexUsageSnapshot,
} from "../extensions/codex-usage.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
};

void describe("Codex usage footer", () => {
	void it("formats rolling usage without cap or spinner status", () => {
		const nowMs = Date.UTC(2026, 7, 29, 12, 0, 0);
		const snapshot: CodexUsageSnapshot = {
			windows: [
				{
					label: "5h",
					remainingPercent: 96,
					resetsAt: new Date(nowMs + (4 * 60 + 56) * 60_000),
				},
				{
					label: "7d",
					remainingPercent: 75,
					resetsAt: new Date(nowMs + (5 * 24 + 20) * 60 * 60_000),
				},
			],
		};

		assert.equal(
			formatCodexUsage(plainTheme, snapshot, nowMs),
			"5h:96% left (↺in 4h56m) 7d:75% left (↺in 5d20h)",
		);
	});

	void it("parses the rolling windows returned by ChatGPT usage", () => {
		const result = parseCodexUsage({
			plan_type: "plus",
			rate_limit: {
				primary_window: {
					used_percent: 4,
					reset_at: 1_788_179_760,
					limit_window_seconds: 18_000,
				},
				secondary_window: {
					used_percent: 25,
					reset_at: 1_788_684_000,
					limit_window_seconds: 604_800,
				},
			},
			credits: { has_credits: true, balance: 42 },
			spend_control: { reached: false },
		});

		assert.equal(result.ok, true);
		if (!result.ok) assert.fail("expected a parsed Codex usage snapshot");
		assert.deepEqual(result.value, {
			windows: [
				{
					label: "5h",
					remainingPercent: 96,
					resetsAt: new Date(1_788_179_760_000),
				},
				{
					label: "7d",
					remainingPercent: 75,
					resetsAt: new Date(1_788_684_000_000),
				},
			],
		});
	});

	void it("accepts alternate Codex fields and falls back to standard durations", () => {
		const result = parseCodexUsage({
			rate_limits: {
				five_hour_limit: {
					percent_left: 61,
					reset_time_ms: 1_788_179_760_000,
					limit_window_seconds: "invalid",
				},
				weekly_limit: {
					remaining_percent: 83,
					reset_time_ms: 1_788_684_000_000,
					limit_window_seconds: 0,
				},
			},
		});

		assert.equal(result.ok, true);
		if (!result.ok) assert.fail("expected alternate Codex usage fields to parse");
		assert.deepEqual(result.value, {
			windows: [
				{
					label: "5h",
					remainingPercent: 61,
					resetsAt: new Date(1_788_179_760_000),
				},
				{
					label: "7d",
					remainingPercent: 83,
					resetsAt: new Date(1_788_684_000_000),
				},
			],
		});
	});

	void it("rejects non-numeric usage fields instead of reporting false headroom", () => {
		const result = parseCodexUsage({
			rate_limit: {
				primary_window: { used_percent: null },
				secondary_window: { percent_left: false },
			},
		});

		assert.equal(result.ok, true);
		if (!result.ok) assert.fail("expected the response envelope to parse");
		assert.deepEqual(result.value.windows, []);
	});

	void it("loads Codex usage with Pi OAuth and ChatGPT account metadata", async () => {
		let request: { input: RequestInfo | URL; init?: RequestInit } | undefined;
		const runtime = {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				request = { input, init };
				return new Response(JSON.stringify({
					rate_limit: {
						primary_window: {
							used_percent: 4,
							reset_at: 1_788_179_760,
							limit_window_seconds: 18_000,
						},
					},
				}), { status: 200 });
			},
			readTextFile: async (path: string) => {
				assert.equal(path, "/agent/auth.json");
				return JSON.stringify({
					"openai-codex": { accountId: "acct_123" },
				});
			},
			now: () => 0,
			agentDir: () => "/agent",
			homeDir: () => "/home",
		};
		const registry = {
			getApiKeyForProvider: async (provider: string) => {
				assert.equal(provider, "openai-codex");
				return "access-token";
			},
		};

		const result = await loadCodexUsage(registry, runtime, new AbortController().signal);

		assert.equal(result.ok, true);
		assert.ok(request);
		assert.equal(String(request.input), "https://chatgpt.com/backend-api/wham/usage");
		assert.equal(request.init?.method, "GET");
		const headers = new Headers(request.init?.headers);
		assert.equal(headers.get("authorization"), "Bearer access-token");
		assert.equal(headers.get("chatgpt-account-id"), "acct_123");
		assert.equal(headers.get("origin"), "https://chatgpt.com");
	});

	void it("contains OAuth resolution failures", async () => {
		const result = await loadCodexUsage(
			{
				getApiKeyForProvider: async () => {
					throw new Error("refresh failed with a private token");
				},
			},
			{
				fetch: async () => {
					throw new Error("fetch must not run");
				},
				readTextFile: async () => "{}",
				now: () => 0,
				agentDir: () => "/agent",
				homeDir: () => "/home",
			},
			new AbortController().signal,
		);

		assert.deepEqual(result, { ok: false, error: { kind: "network" } });
	});

	void it("falls back to the Codex CLI account id", async () => {
		const reads: string[] = [];
		let accountHeader: string | null = null;
		const runtime = {
			fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
				accountHeader = new Headers(init?.headers).get("chatgpt-account-id");
				return new Response(JSON.stringify({ rate_limit: {} }), { status: 200 });
			},
			readTextFile: async (path: string) => {
				reads.push(path);
				if (path === "/agent/auth.json") throw new Error("missing");
				return JSON.stringify({ tokens: { account_id: "acct_cli" } });
			},
			now: () => 0,
			agentDir: () => "/agent",
			homeDir: () => "/home",
		};

		const result = await loadCodexUsage(
			{ getApiKeyForProvider: async () => "access-token" },
			runtime,
			new AbortController().signal,
		);

		assert.equal(result.ok, true);
		assert.deepEqual(reads, ["/agent/auth.json", "/home/.codex/auth.json"]);
		assert.equal(accountHeader, "acct_cli");
	});

	void it("shows rolling usage when a Codex session starts", async () => {
		const nowMs = Date.UTC(2026, 7, 29, 12, 0, 0);
		const handlers = new Map<string, (...args: any[]) => unknown>();
		const statuses: Array<string | undefined> = [];
		const runtime = {
			fetch: async () => new Response(JSON.stringify({
				rate_limit: {
					primary_window: {
						used_percent: 4,
						reset_at: (nowMs + (4 * 60 + 56) * 60_000) / 1000,
						limit_window_seconds: 18_000,
					},
				},
			}), { status: 200 }),
			readTextFile: async () => JSON.stringify({
				"openai-codex": { accountId: "acct_123" },
			}),
			now: () => nowMs,
			agentDir: () => "/agent",
			homeDir: () => "/home",
		};
		createCodexUsageExtension(runtime)({
			on: (event: string, handler: (...args: any[]) => unknown) => {
				handlers.set(event, handler);
			},
		} as any);
		const ctx = {
			hasUI: true,
			model: { provider: "openai-codex" },
			modelRegistry: { getApiKeyForProvider: async () => "access-token" },
			ui: {
				theme: plainTheme,
				setStatus: (id: string, text: string | undefined) => {
					assert.equal(id, "codex-usage");
					statuses.push(text);
				},
			},
		};

		await handlers.get("session_start")?.({}, ctx);

		assert.equal(statuses.at(-1), "5h:96% left (↺in 4h56m)");
		await handlers.get("session_shutdown")?.({}, ctx);
	});

	void it("clears its status when a non-Codex model is selected", async () => {
		const handlers = new Map<string, (...args: any[]) => unknown>();
		const statuses: Array<string | undefined> = [];
		let fetches = 0;
		createCodexUsageExtension({
			fetch: async () => {
				fetches++;
				return new Response(JSON.stringify({ rate_limit: {} }), { status: 200 });
			},
			readTextFile: async () => "{}",
			now: () => 0,
			agentDir: () => "/agent",
			homeDir: () => "/home",
		})({
			on: (event: string, handler: (...args: any[]) => unknown) => {
				handlers.set(event, handler);
			},
		} as any);
		const ctx = {
			hasUI: true,
			model: { provider: "anthropic" },
			modelRegistry: { getApiKeyForProvider: async () => "unused" },
			ui: {
				theme: plainTheme,
				setStatus: (_id: string, text: string | undefined) => statuses.push(text),
			},
		};
		const selectModel = handlers.get("model_select");
		assert.ok(selectModel);

		await selectModel({ model: { provider: "anthropic" } }, ctx);

		assert.deepEqual(statuses, [undefined]);
		assert.equal(fetches, 0);
	});

	void it("refreshes after a turn only when the usage cache has expired", async () => {
		let nowMs = Date.UTC(2026, 7, 29, 12, 0, 0);
		let fetches = 0;
		const handlers = new Map<string, (...args: any[]) => unknown>();
		createCodexUsageExtension({
			fetch: async () => {
				fetches++;
				return new Response(JSON.stringify({ rate_limit: {} }), { status: 200 });
			},
			readTextFile: async () => JSON.stringify({
				"openai-codex": { accountId: "acct_123" },
			}),
			now: () => nowMs,
			agentDir: () => "/agent",
			homeDir: () => "/home",
		})({
			on: (event: string, handler: (...args: any[]) => unknown) => {
				handlers.set(event, handler);
			},
		} as any);
		const ctx = {
			hasUI: true,
			model: { provider: "openai-codex" },
			modelRegistry: { getApiKeyForProvider: async () => "access-token" },
			ui: { theme: plainTheme, setStatus: () => undefined },
		};

		await handlers.get("session_start")?.({}, ctx);
		const turnEnd = handlers.get("turn_end");
		assert.ok(turnEnd);
		await turnEnd({}, ctx);
		assert.equal(fetches, 1);

		nowMs += 60_001;
		await turnEnd({}, ctx);
		assert.equal(fetches, 2);
		await handlers.get("session_shutdown")?.({}, ctx);
	});

	void it("starts showing usage when Codex is selected", async () => {
		const handlers = new Map<string, (...args: any[]) => unknown>();
		const statuses: Array<string | undefined> = [];
		createCodexUsageExtension({
			fetch: async () => new Response(JSON.stringify({
				rate_limit: {
					primary_window: {
						used_percent: 20,
						limit_window_seconds: 18_000,
					},
				},
			}), { status: 200 }),
			readTextFile: async () => JSON.stringify({
				"openai-codex": { accountId: "acct_123" },
			}),
			now: () => 0,
			agentDir: () => "/agent",
			homeDir: () => "/home",
		})({
			on: (event: string, handler: (...args: any[]) => unknown) => {
				handlers.set(event, handler);
			},
		} as any);
		const ctx = {
			hasUI: true,
			model: { provider: "openai-codex" },
			modelRegistry: { getApiKeyForProvider: async () => "access-token" },
			ui: {
				theme: plainTheme,
				setStatus: (_id: string, text: string | undefined) => statuses.push(text),
			},
		};

		await handlers.get("model_select")?.({ model: ctx.model }, ctx);

		assert.equal(statuses.at(-1), "5h:80% left");
		await handlers.get("session_shutdown")?.({}, ctx);
	});

	void it("stops a ChatGPT usage request after fifteen seconds", async () => {
		vi.useFakeTimers();
		try {
			const runtime = {
				fetch: async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
					}),
				readTextFile: async () => JSON.stringify({
					"openai-codex": { accountId: "acct_123" },
				}),
				now: () => 0,
				agentDir: () => "/agent",
				homeDir: () => "/home",
			};
			const pending = loadCodexUsage(
				{ getApiKeyForProvider: async () => "access-token" },
				runtime,
				new AbortController().signal,
			);

			await vi.advanceTimersByTimeAsync(15_000);

			assert.deepEqual(await pending, { ok: false, error: { kind: "timeout" } });
		} finally {
			vi.useRealTimers();
		}
	});

	void it("also times out while reading the ChatGPT response body", async () => {
		vi.useFakeTimers();
		try {
			let requestSignal: AbortSignal | undefined;
			const runtime = {
				fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
					requestSignal = init?.signal ?? undefined;
					return {
						ok: true,
						status: 200,
						json: async () => new Promise<unknown>((_resolve, reject) => {
							requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason));
						}),
					} as Response;
				},
				readTextFile: async () => JSON.stringify({
					"openai-codex": { accountId: "acct_123" },
				}),
				now: () => 0,
				agentDir: () => "/agent",
				homeDir: () => "/home",
			};
			const caller = new AbortController();
			const pending = loadCodexUsage(
				{ getApiKeyForProvider: async () => "access-token" },
				runtime,
				caller.signal,
			);

			await vi.advanceTimersByTimeAsync(15_000);
			const timedOut = requestSignal?.aborted ?? false;
			caller.abort();
			await pending;

			assert.equal(timedOut, true);
		} finally {
			vi.useRealTimers();
		}
	});

	void it("deduplicates simultaneous lifecycle refreshes", async () => {
		const handlers = new Map<string, (...args: any[]) => unknown>();
		let releaseRequest: () => void = () => {};
		const requestGate = new Promise<void>((resolve) => {
			releaseRequest = resolve;
		});
		let fetches = 0;
		createCodexUsageExtension({
			fetch: async () => {
				fetches++;
				await requestGate;
				return new Response(JSON.stringify({ rate_limit: {} }), { status: 200 });
			},
			readTextFile: async () => JSON.stringify({
				"openai-codex": { accountId: "acct_123" },
			}),
			now: () => 0,
			agentDir: () => "/agent",
			homeDir: () => "/home",
		})({
			on: (event: string, handler: (...args: any[]) => unknown) => {
				handlers.set(event, handler);
			},
		} as any);
		const ctx = {
			hasUI: true,
			model: { provider: "openai-codex" },
			modelRegistry: { getApiKeyForProvider: async () => "access-token" },
			ui: { theme: plainTheme, setStatus: () => undefined },
		};

		const startup = Promise.resolve(handlers.get("session_start")?.({}, ctx));
		const turnEnd = Promise.resolve(handlers.get("turn_end")?.({}, ctx));
		await new Promise<void>((resolve) => setImmediate(resolve));
		const observedFetches = fetches;
		releaseRequest();
		await Promise.all([startup, turnEnd]);
		await handlers.get("session_shutdown")?.({}, ctx);

		assert.equal(observedFetches, 1);
	});

	void it("backs off briefly after a usage request fails", async () => {
		let nowMs = 0;
		let fetches = 0;
		const handlers = new Map<string, (...args: any[]) => unknown>();
		createCodexUsageExtension({
			fetch: async () => {
				fetches++;
				return new Response("private provider error", { status: 500 });
			},
			readTextFile: async () => JSON.stringify({
				"openai-codex": { accountId: "acct_123" },
			}),
			now: () => nowMs,
			agentDir: () => "/agent",
			homeDir: () => "/home",
		})({
			on: (event: string, handler: (...args: any[]) => unknown) => {
				handlers.set(event, handler);
			},
		} as any);
		const ctx = {
			hasUI: true,
			model: { provider: "openai-codex" },
			modelRegistry: { getApiKeyForProvider: async () => "access-token" },
			ui: { theme: plainTheme, setStatus: () => undefined },
		};

		await handlers.get("session_start")?.({}, ctx);
		await handlers.get("turn_end")?.({}, ctx);
		assert.equal(fetches, 1);

		nowMs += 10_001;
		await handlers.get("turn_end")?.({}, ctx);
		assert.equal(fetches, 2);
		await handlers.get("session_shutdown")?.({}, ctx);
	});

	void it("uses the local extension instead of a generic usage package", async () => {
		const settings = await readFile(new URL("../settings.json", import.meta.url), "utf8");

		assert.doesNotMatch(settings, /pi-(?:quotas|usage)/);
		assert.match(settings, /@dustydonkey\/pi-spinner/);
	});
});
