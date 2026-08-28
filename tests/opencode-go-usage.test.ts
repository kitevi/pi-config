import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { describe, it, vi } from "vitest";
import {
	createOpenCodeGoUsageExtension,
	formatOpenCodeGoUsage,
	loadOpenCodeGoUsage,
	parseOpenCodeGoUsage,
} from "../extensions/opencode-go-usage.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
};

void describe("OpenCode Go usage footer", () => {
	void it("formats the authoritative aggregate quotas and reset times", () => {
		const nowMs = Date.UTC(2026, 7, 30, 0, 0, 0);
		const result = parseOpenCodeGoUsage({
			usage: {
				rolling: {
					status: "ok",
					percent: 0,
					resetsAt: new Date(nowMs + 249 * 60_000).toISOString(),
				},
				weekly: {
					status: "ok",
					percent: 85,
					resetsAt: new Date(nowMs + 3_000 * 60_000).toISOString(),
				},
				monthly: {
					status: "ok",
					percent: 58,
					resetsAt: new Date(nowMs + 9_600 * 60_000).toISOString(),
				},
			},
		});

		assert.equal(result.ok, true);
		if (!result.ok) assert.fail("expected an OpenCode Go usage snapshot");
		assert.equal(
			formatOpenCodeGoUsage(plainTheme, result.value, nowMs),
			"5h:0% used (↺in 4h9m) wk:85% used (↺in 2d2h) mo:58% used (↺in 6d16h)",
		);
	});

	void it("loads usage with the Pi OpenCode Go API key", async () => {
		let request: { input: RequestInfo | URL; init?: RequestInit } | undefined;
		const nowMs = Date.UTC(2026, 7, 30);
		const runtime = {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				request = { input, init };
				return new Response(JSON.stringify({
					usage: {
						rolling: {
							status: "ok",
							percent: 0.3,
							resetsAt: new Date(nowMs + 249 * 60_000).toISOString(),
						},
					},
				}), { status: 200 });
			},
			now: () => nowMs,
		};
		const registry = {
			getApiKeyForProvider: async (provider: string) => {
				assert.equal(provider, "opencode-go");
				return "opencode-key-123";
			},
		};

		const result = await loadOpenCodeGoUsage(
			registry,
			runtime,
			new AbortController().signal,
		);

		assert.equal(result.ok, true);
		assert.ok(request);
		assert.equal(String(request.input), "https://opencode.ai/zen/go/v1/usage");
		assert.equal(request.init?.method, "GET");
		assert.equal(request.init?.redirect, "error");
		const headers = new Headers(request.init?.headers);
		assert.equal(headers.get("authorization"), "Bearer opencode-key-123");
		assert.equal(headers.get("accept"), "application/json");
	});

	void it("shows authoritative used quotas when an OpenCode Go session starts", async () => {
		const handlers = new Map<string, (...args: any[]) => unknown>();
		const statuses = new Map<string, string | undefined>();
		const nowMs = Date.UTC(2026, 7, 30);
		const runtime = {
			fetch: async () => new Response(JSON.stringify({
				usage: {
					rolling: {
						status: "ok",
						percent: 0.3,
						resetsAt: new Date(nowMs + 60_000).toISOString(),
					},
					weekly: {
						status: "ok",
						percent: 85.2,
						resetsAt: new Date(nowMs + 3_000 * 60_000).toISOString(),
					},
					monthly: {
						status: "ok",
						percent: 58.7,
						resetsAt: new Date(nowMs + 9_600 * 60_000).toISOString(),
					},
				},
			}), { status: 200 }),
			now: () => nowMs,
		};

		createOpenCodeGoUsageExtension(runtime)({
			on: (event: string, handler: (...args: any[]) => unknown) => {
				handlers.set(event, handler);
			},
		} as any);
		const ctx = {
			hasUI: true,
			model: { provider: "opencode-go" },
			modelRegistry: { getApiKeyForProvider: async () => "opencode-key-123" },
			ui: {
				theme: plainTheme,
				setStatus: (id: string, text: string | undefined) => statuses.set(id, text),
			},
		};

		await handlers.get("session_start")?.({}, ctx);
		assert.equal(
			statuses.get("opencode-go-usage"),
			"5h:0.3% used (↺in 1m) wk:85.2% used (↺in 2d2h) mo:58.7% used (↺in 6d16h)",
		);
		await handlers.get("session_shutdown")?.({}, ctx);
	});

	void it("preserves the precision returned by the usage endpoint", () => {
		const nowMs = Date.UTC(2026, 7, 30);
		const result = parseOpenCodeGoUsage({
			usage: {
				weekly: {
					status: "ok",
					percent: 85.25,
					resetsAt: new Date(nowMs + 60_000).toISOString(),
				},
			},
		});

		assert.equal(result.ok, true);
		if (!result.ok) assert.fail("expected an OpenCode Go usage snapshot");
		assert.equal(
			formatOpenCodeGoUsage(plainTheme, result.value, nowMs),
			"wk:85.25% used (↺in 1m)",
		);
	});

	void it("rejects unknown quota-limit states at the JSON boundary", () => {
		const result = parseOpenCodeGoUsage({
			usage: {
				rolling: {
					status: "temporarily-degraded",
					percent: 8,
					resetsAt: "2026-08-30T05:00:00.000Z",
				},
			},
		});

		assert.deepEqual(result, { ok: false, error: { kind: "invalid_response" } });
	});

	void it("omits malformed windows without inventing false headroom", () => {
		const resetsAt = "2026-08-30T05:00:00.000Z";
		const result = parseOpenCodeGoUsage({
			usage: {
				rolling: { status: "ok", percent: null, resetsAt },
				weekly: { status: "ok", percent: "85.2", resetsAt },
				monthly: { status: "ok", percent: 140, resetsAt },
				bonus: { status: "ok", percent: 4.2, resetsAt },
			},
		});

		assert.deepEqual(result, { ok: false, error: { kind: "invalid_response" } });
	});

	void it("does not call OpenCode without a Pi provider key", async () => {
		let fetches = 0;
		const result = await loadOpenCodeGoUsage(
			{ getApiKeyForProvider: async () => undefined },
			{
				fetch: async () => {
					fetches++;
					return new Response("{}", { status: 200 });
				},
				now: () => 0,
			},
			new AbortController().signal,
		);

		assert.deepEqual(result, {
			ok: false,
			error: { kind: "config", reason: "missing_api_key" },
		});
		assert.equal(fetches, 0);
	});

	void it("refreshes after a turn only when the quota cache has expired", async () => {
		let nowMs = 0;
		let fetches = 0;
		const handlers = new Map<string, (...args: any[]) => unknown>();
		const statuses: Array<string | undefined> = [];
		const runtime = {
			fetch: async () => {
				fetches++;
				return new Response(JSON.stringify({
					usage: {
						monthly: {
							status: "ok",
							percent: 58.7,
							resetsAt: new Date(nowMs + 3_600_000).toISOString(),
						},
					},
				}), { status: 200 });
			},
			now: () => nowMs,
		};
		createOpenCodeGoUsageExtension(runtime)({
			on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
		} as any);
		const ctx = {
			hasUI: true,
			model: { provider: "opencode-go" },
			modelRegistry: { getApiKeyForProvider: async () => "opencode-key-123" },
			ui: {
				theme: plainTheme,
				setStatus: (id: string, text: string | undefined) => {
					if (id === "opencode-go-usage") statuses.push(text);
				},
			},
		};

		await handlers.get("session_start")?.({}, ctx);
		await handlers.get("turn_end")?.({}, ctx);
		nowMs = 59_999;
		await handlers.get("turn_end")?.({}, ctx);
		assert.equal(fetches, 1);

		nowMs = 60_001;
		await handlers.get("turn_end")?.({}, ctx);
		assert.equal(fetches, 2);
		assert.deepEqual(statuses.filter((status) => status !== undefined).length, 4);
		await handlers.get("session_shutdown")?.({}, ctx);
	});

	void it("backs off briefly after a usage request fails", async () => {
		let nowMs = 0;
		let fetches = 0;
		const handlers = new Map<string, (...args: any[]) => unknown>();
		const statuses: Array<string | undefined> = [];
		createOpenCodeGoUsageExtension({
			fetch: async () => {
				fetches++;
				return new Response("private provider error", { status: 500 });
			},
			now: () => nowMs,
		})({
			on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
		} as any);
		const ctx = {
			hasUI: true,
			model: { provider: "opencode-go" },
			modelRegistry: { getApiKeyForProvider: async () => "opencode-key-123" },
			ui: {
				theme: plainTheme,
				setStatus: (id: string, text: string | undefined) => statuses.push(text),
			},
		};

		await handlers.get("session_start")?.({}, ctx);
		await handlers.get("turn_end")?.({}, ctx);
		assert.equal(fetches, 1);

		nowMs = 10_001;
		await handlers.get("turn_end")?.({}, ctx);
		assert.equal(fetches, 2);
		await handlers.get("session_shutdown")?.({}, ctx);
		assert.equal(statuses.some((status) => typeof status === "string"), false);
	});

	void it("aborts and clears its status when a non-Go model is selected", async () => {
		let requestSignal: AbortSignal | undefined;
		const handlers = new Map<string, (...args: any[]) => unknown>();
		const statuses: Array<string | undefined> = [];
		createOpenCodeGoUsageExtension({
			fetch: (_input, init) => new Promise<Response>((_resolve, reject) => {
				requestSignal = init?.signal ?? undefined;
				requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason));
			}),
			now: () => 0,
		})({
			on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
		} as any);
		const ctx = {
			hasUI: true,
			model: { provider: "opencode-go/kimi-k3" },
			modelRegistry: { getApiKeyForProvider: async () => "opencode-key-123" },
			ui: {
				theme: plainTheme,
				setStatus: (id: string, text: string | undefined) => statuses.push(text),
			},
		};

		const started = handlers.get("session_start")?.({}, ctx) as Promise<unknown>;
		await new Promise((resolve) => setTimeout(resolve, 0));
		await handlers.get("model_select")?.({ model: { provider: "kimi-coding" } }, ctx);
		await started;

		assert.equal(requestSignal?.aborted, true);
		assert.equal(statuses.some((status) => typeof status === "string"), false);
	});

	void it("times out while consuming the usage response body", async () => {
		vi.useFakeTimers();
		try {
			let requestSignal: AbortSignal | undefined;
			const caller = new AbortController();
			const pending = loadOpenCodeGoUsage(
				{ getApiKeyForProvider: async () => "opencode-key-123" },
				{
					fetch: async (_input, init) => {
						requestSignal = init?.signal ?? undefined;
						return {
							ok: true,
							status: 200,
							json: async () => new Promise<unknown>((_resolve, reject) => {
								requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason));
							}),
						} as Response;
					},
					now: () => 0,
				},
				caller.signal,
			);

			await vi.advanceTimersByTimeAsync(15_000);
			const result = await pending;

			assert.equal(requestSignal?.aborted, true);
			assert.deepEqual(result, { ok: false, error: { kind: "timeout" } });
		} finally {
			vi.useRealTimers();
		}
	});

	void it("deduplicates simultaneous lifecycle refreshes", async () => {
		const handlers = new Map<string, (...args: any[]) => unknown>();
		let fetches = 0;
		let releaseRequest: () => void = () => {};
		createOpenCodeGoUsageExtension({
			fetch: () => {
				fetches++;
				return new Promise<Response>((resolve) => {
					releaseRequest = () => resolve(new Response(JSON.stringify({
						usage: {
							rolling: {
								status: "ok",
								percent: 8,
								resetsAt: "2026-08-30T05:00:00.000Z",
							},
						},
					}), { status: 200 }));
				});
			},
			now: () => 0,
		})({
			on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
		} as any);
		const ctx = {
			hasUI: true,
			model: { provider: "opencode-go" },
			modelRegistry: { getApiKeyForProvider: async () => "opencode-key-123" },
			ui: {
				theme: plainTheme,
				setStatus: () => undefined,
			},
		};

		const started = handlers.get("session_start")?.({}, ctx) as Promise<unknown>;
		await new Promise((resolve) => setTimeout(resolve, 0));
		const turn = handlers.get("turn_end")?.({}, ctx) as Promise<unknown>;
		assert.equal(fetches, 1);
		releaseRequest();
		await Promise.all([started, turn]);
		await handlers.get("session_shutdown")?.({}, ctx);
		assert.equal(fetches, 1);
	});

	void it("starts showing usage when an OpenCode Go model is selected", async () => {
		let fetches = 0;
		const handlers = new Map<string, (...args: any[]) => unknown>();
		const statuses: Array<string | undefined> = [];
		createOpenCodeGoUsageExtension({
			fetch: async () => {
				fetches++;
				return new Response(JSON.stringify({
					usage: {
						weekly: {
							status: "ok",
							percent: 61,
							resetsAt: "2026-08-31T00:00:00.000Z",
						},
					},
				}), { status: 200 });
			},
			now: () => Date.UTC(2026, 7, 30),
		})({
			on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
		} as any);
		const ctx = {
			hasUI: true,
			model: { provider: "kimi-coding" },
			modelRegistry: { getApiKeyForProvider: async () => "opencode-key-123" },
			ui: {
				theme: plainTheme,
				setStatus: (id: string, text: string | undefined) => statuses.push(text),
			},
		};

		await handlers.get("session_start")?.({}, ctx);
		assert.equal(fetches, 0);
		const selected = { provider: "opencode-go/glm-5.3" };
		ctx.model = selected;
		await handlers.get("model_select")?.({ model: selected }, ctx);

		assert.equal(fetches, 1);
		assert.equal(statuses.at(-1), "wk:61% used (↺in 1d)");
		await handlers.get("session_shutdown")?.({}, ctx);
	});

	void it("uses the local extension without a generic usage package", async () => {
		const settings = await readFile(new URL("../settings.json", import.meta.url), "utf8");

		assert.doesNotMatch(settings, /pi-(?:quotas|usage)/);
		assert.match(settings, /@dustydonkey\/pi-spinner/);
	});
});
