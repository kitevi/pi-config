import { describe, it } from "vitest";
import { assert } from "vitest";
import plugin, { type FetchQuota, type QuotaSnapshot } from "../extensions/xai-quota-guard.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function setup(quota: QuotaSnapshot | Error, activeTools = ["codemode", "x_search", "read"]) {
	const handlers = new Map<string, Handler>();
	let active = activeTools;
	let fetches = 0;
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
		},
	};
	const loadQuota: FetchQuota = async () => {
		fetches++;
		if (quota instanceof Error) throw quota;
		return quota;
	};
	plugin(pi as never, loadQuota);

	const notices: Array<{ message: string; level: string }> = [];
	let aborted = false;
	const ctx = (provider: string) => ({
		model: { provider },
		modelRegistry: { getApiKeyForProvider: async () => "token" },
		ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
		abort: () => {
			aborted = true;
		},
	});
	const fire = (event: string, provider = "xai-oauth") => handlers.get(event)?.({}, ctx(provider));
	return { fire, notices, active: () => active, aborted: () => aborted, fetches: () => fetches };
}

void describe("xai-quota-guard", () => {
	void it("hides x_search at session start and before each run", () => {
		const guard = setup({ percent: 0 });
		guard.fire("session_start");
		assert.deepEqual(guard.active(), ["codemode", "read"]);
		guard.fire("before_agent_start");
		assert.deepEqual(guard.active(), ["codemode", "read"]);
	});

	void it("lets input through below the limit", async () => {
		const guard = setup({ percent: 79.9 });
		assert.deepEqual(await guard.fire("input"), { action: "continue" });
		assert.equal(guard.notices.length, 0);
	});

	void it("refuses input at the limit and names the reset", async () => {
		const guard = setup({ percent: 80, resetsAt: "2026-10-27T14:03:33Z" });
		assert.deepEqual(await guard.fire("input"), { action: "handled" });
		assert.equal(guard.notices[0]?.level, "error");
		assert.match(guard.notices[0]?.message ?? "", /80%.*resets/);
	});

	void it("aborts a running loop at the limit", async () => {
		const guard = setup({ percent: 95 });
		await guard.fire("turn_start");
		assert.equal(guard.aborted(), true);
	});

	void it("ignores other providers without fetching", async () => {
		const guard = setup({ percent: 100 });
		assert.deepEqual(await guard.fire("input", "xai"), { action: "continue" });
		await guard.fire("turn_start", "openai-codex");
		assert.equal(guard.fetches(), 0);
		assert.equal(guard.aborted(), false);
	});

	void it("fails open with a warning when usage cannot be read", async () => {
		const guard = setup(new Error("HTTP 426"));
		assert.deepEqual(await guard.fire("input"), { action: "continue" });
		assert.equal(guard.notices[0]?.level, "warning");
		assert.match(guard.notices[0]?.message ?? "", /HTTP 426/);
	});

	void it("caches the snapshot between input and turn checks", async () => {
		const guard = setup({ percent: 10 });
		await guard.fire("input");
		await guard.fire("turn_start");
		assert.equal(guard.fetches(), 1);
	});
});
