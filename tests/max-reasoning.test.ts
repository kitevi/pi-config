import { assert } from "vitest";
import { describe, it } from "vitest";
import plugin, {
	applyMaxReasoning,
	isMatchedModel,
	type ThinkingLevel,
	type ThinkingModel,
} from "../extensions/max-reasoning.ts";

// A mock ThinkingLevelApi must replicate the runtime contract the extension
// relies on: setThinkingLevel(level) clamps the requested level against the
// model's supported levels before storing it, so a later getThinkingLevel()
// returns the clamped level. pi-ai's clampThinkingLevel() walks down from the
// requested level to the nearest supported one; these fixtures hard-code the
// clamp outcomes of the real maps they stand in for.

// lilac's GLM 5.2 (patch.json): minimal unsupported, low/medium/high → "high",
// xhigh omitted, max → "max". Requesting "max" lands on "max".
const glm52: ThinkingModel = { id: "zai-org/glm-5.2", reasoning: true };
const GLM_5_2_TOP: ThinkingLevel = "max";

// openrouter's deepseek-v4-pro (pi-ai catalog): max explicitly unsupported,
// xhigh is the top. Requesting "max" clamps to "xhigh".
const deepseekV4Pro: ThinkingModel = { id: "deepseek/deepseek-v4-pro", reasoning: true };
const DEEPSEEK_TOP: ThinkingLevel = "xhigh";

// A reasoning model with no thinkingLevelMap: standard levels through "high"
// are supported, xhigh/max are not. Requesting "max" clamps to "high".
const kimi: ThinkingModel = { id: "moonshotai/kimi-k2.6", reasoning: true };
const KIMI_TOP: ThinkingLevel = "high";

// Matched by default (any reasoning model) — exclusion is an opt-out.
const claude: ThinkingModel = { id: "anthropic/claude-opus-4-7", reasoning: true };
const CLAUDE_TOP: ThinkingLevel = "max";

// Non-reasoning models are never touched.
const glmEmbed: ThinkingModel = { id: "zai-org/glm-embedding", reasoning: false };

function makeApi(start: ThinkingLevel, clampTo: ThinkingLevel) {
	const setCalls: ThinkingLevel[] = [];
	let current = start;
	const api = {
		getThinkingLevel: (): ThinkingLevel => current,
		setThinkingLevel: (level: ThinkingLevel) => {
			setCalls.push(level);
			// Runtime clamp: "max" lands on the model's top supported level.
			current = level === "max" ? clampTo : level;
		},
	};
	return { api, setCalls };
}

function makeUi() {
	const notes: string[] = [];
	const notifyUi = {
		notify: (message: string, type?: string) => {
			notes.push(type ? `${type}:${message}` : message);
		},
	};
	return { notifyUi, notes };
}

void describe("isMatchedModel", () => {
	void it("matches any reasoning model, regardless of family", () => {
		assert.strictEqual(isMatchedModel(glm52), true);
		assert.strictEqual(isMatchedModel(deepseekV4Pro), true);
		assert.strictEqual(isMatchedModel(kimi), true);
		assert.strictEqual(isMatchedModel(claude), true);
		assert.strictEqual(isMatchedModel({ id: "openai/gpt-5.6", reasoning: true }), true);
		// Id-less models match: the runtime's reasoning flag is authoritative,
		// and there is no id to exclude by.
		assert.strictEqual(isMatchedModel({ reasoning: true }), true);
	});

	void it("does not match non-reasoning models", () => {
		assert.strictEqual(isMatchedModel(glmEmbed), false);
		assert.strictEqual(isMatchedModel({ id: "openai/gpt-4o", reasoning: false }), false);
		assert.strictEqual(isMatchedModel(undefined), false);
		assert.strictEqual(isMatchedModel({}), false);
	});
});

void describe("applyMaxReasoning", () => {
	void it("requests max and lands on the model's top (max for GLM 5.2)", () => {
		const { api, setCalls } = makeApi("high", GLM_5_2_TOP);
		const { notifyUi, notes } = makeUi();
		assert.strictEqual(applyMaxReasoning(api, glm52, notifyUi), "max");
		assert.deepStrictEqual(setCalls, ["max"]);
		assert.deepStrictEqual(notes, ["info:zai-org/glm-5.2: reasoning set to max"]);
	});

	void it("reports the clamped level when max is unsupported (xhigh for deepseek)", () => {
		const { api, setCalls } = makeApi("high", DEEPSEEK_TOP);
		const { notifyUi, notes } = makeUi();
		assert.strictEqual(applyMaxReasoning(api, deepseekV4Pro, notifyUi), "xhigh");
		assert.deepStrictEqual(setCalls, ["max"]);
		assert.deepStrictEqual(notes, ["info:deepseek/deepseek-v4-pro: reasoning set to xhigh"]);
	});

	void it("clamps to high for a reasoning model with no map", () => {
		const { api, setCalls } = makeApi("low", KIMI_TOP);
		const { notifyUi, notes } = makeUi();
		assert.strictEqual(applyMaxReasoning(api, kimi, notifyUi), "high");
		assert.deepStrictEqual(setCalls, ["max"]);
		assert.deepStrictEqual(notes, ["info:moonshotai/kimi-k2.6: reasoning set to high"]);
	});

	void it("applies to any reasoning model, not just a hard-coded list", () => {
		const { api, setCalls } = makeApi("high", CLAUDE_TOP);
		assert.strictEqual(applyMaxReasoning(api, claude, undefined), "max");
		assert.deepStrictEqual(setCalls, ["max"]);
	});

	void it("is a no-op when already at the model's top", () => {
		const { api, setCalls } = makeApi("max", GLM_5_2_TOP);
		const { notifyUi, notes } = makeUi();
		assert.strictEqual(applyMaxReasoning(api, glm52, notifyUi), "max");
		assert.deepStrictEqual(setCalls, ["max"]);
		assert.deepStrictEqual(notes, []);
	});

	void it("ignores non-reasoning models entirely", () => {
		const { api, setCalls } = makeApi("off", "off");
		const { notifyUi, notes } = makeUi();
		assert.strictEqual(applyMaxReasoning(api, glmEmbed, notifyUi), undefined);
		assert.deepStrictEqual(setCalls, []);
		assert.deepStrictEqual(notes, []);
	});

	void it("ignores models that clamp all the way down to off", () => {
		const { api, setCalls } = makeApi("high", "off");
		const { notifyUi, notes } = makeUi();
		assert.strictEqual(applyMaxReasoning(api, { id: "some/odd-reasoning", reasoning: true }, notifyUi), undefined);
		assert.deepStrictEqual(setCalls, ["max"]);
		assert.deepStrictEqual(notes, []);
	});

	void it("works without a ui (silent)", () => {
		const { api, setCalls } = makeApi("high", GLM_5_2_TOP);
		assert.strictEqual(applyMaxReasoning(api, glm52, undefined), "max");
		assert.deepStrictEqual(setCalls, ["max"]);
	});

	void it("keeps the level when notify throws", () => {
		const { api, setCalls } = makeApi("high", GLM_5_2_TOP);
		const throwingUi = {
			notify: () => {
				throw new Error("no ui");
			},
		};
		assert.strictEqual(applyMaxReasoning(api, glm52, throwingUi), "max");
		assert.deepStrictEqual(setCalls, ["max"]);
	});
});

void describe("maxReasoning extension wiring", () => {
	function createMockPi(start: ThinkingLevel) {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const setCalls: ThinkingLevel[] = [];
		let current = start;
		// The runtime clamps against the *current* model each event carries, so the
		// mock takes that model's top level per fire() call rather than once at setup.
		let clampTo: ThinkingLevel = start;
		const pi = {
			getThinkingLevel: () => current,
			setThinkingLevel: (level: ThinkingLevel) => {
				setCalls.push(level);
				current = level === "max" ? clampTo : level;
			},
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers.set(event, handler);
			},
		};
		const fire = (event: string, ev: unknown, ctx: unknown, modelTop: ThinkingLevel) => {
			clampTo = modelTop;
			return handlers.get(event)?.(ev, ctx);
		};
		return { pi, setCalls, fire };
	}

	void it("bumps to max on model_select for a GLM model", () => {
		const { pi, setCalls, fire } = createMockPi("high");
		plugin(pi as never);
		fire("model_select", { model: glm52 }, { ui: { notify: () => {} } }, GLM_5_2_TOP);
		assert.deepStrictEqual(setCalls, ["max"]);
	});

	void it("falls back to ctx.model when event.model is missing", () => {
		const { pi, setCalls, fire } = createMockPi("medium");
		plugin(pi as never);
		fire("model_select", { model: undefined }, { model: kimi, ui: { notify: () => {} } }, KIMI_TOP);
		assert.deepStrictEqual(setCalls, ["max"]);
	});

	void it("bumps to max on session_start for the active model", () => {
		const { pi, setCalls, fire } = createMockPi("high");
		plugin(pi as never);
		fire("session_start", {}, { model: glm52, ui: { notify: () => {} } }, GLM_5_2_TOP);
		assert.deepStrictEqual(setCalls, ["max"]);
	});

	void it("clamps to xhigh for a deepseek model", () => {
		const { pi, fire } = createMockPi("high");
		plugin(pi as never);
		fire("model_select", { model: deepseekV4Pro }, { ui: { notify: () => {} } }, DEEPSEEK_TOP);
		assert.strictEqual(pi.getThinkingLevel(), "xhigh");
	});

	void it("bumps any reasoning model, including unlisted families like claude", () => {
		const { pi, setCalls, fire } = createMockPi("low");
		plugin(pi as never);
		fire("session_start", {}, { model: claude, ui: { notify: () => {} } }, CLAUDE_TOP);
		assert.deepStrictEqual(setCalls, ["max"]);
	});

	void it("does not touch a non-reasoning model on session_start", () => {
		const { pi, setCalls, fire } = createMockPi("low");
		plugin(pi as never);
		fire("session_start", {}, { model: glmEmbed, ui: { notify: () => {} } }, "off");
		assert.deepStrictEqual(setCalls, []);
	});
});
