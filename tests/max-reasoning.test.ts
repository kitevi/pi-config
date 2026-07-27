import assert from "node:assert";
import { describe, it } from "node:test";
import plugin, {
	applyMaxReasoning,
	getSupportedThinkingLevels,
	highestThinkingLevel,
	isMatchedModel,
	type ThinkingLevel,
	type ThinkingModel,
} from "../extensions/max-reasoning.ts";

// The GLM 5.2 thinkingLevelMap as registered by the lilac provider (patch.json):
// minimal is unsupported, low/medium/high all map to "high", xhigh is omitted
// (unsupported), and max maps to "max".
const GLM_5_2_MAP: Partial<Record<ThinkingLevel, string | null>> = {
	minimal: null,
	low: "high",
	medium: "high",
	high: "high",
	max: "max",
};

const glm52: ThinkingModel = { id: "zai-org/glm-5.2", reasoning: true, thinkingLevelMap: GLM_5_2_MAP };
// GLM 5.1 has no thinkingLevelMap: standard levels through "high" are supported,
// extended xhigh/max are not, so the top is "high".
const glm51: ThinkingModel = { id: "zai-org/glm-5.1", reasoning: true };
// DeepSeek v4 Pro as registered in pi-ai 0.80.10's openrouter catalog: max is
// explicitly unsupported, xhigh is the top.
const deepseekV4Pro: ThinkingModel = {
	id: "deepseek/deepseek-v4-pro",
	reasoning: true,
	thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: null, xhigh: "xhigh" },
};
const claude: ThinkingModel = { id: "anthropic/claude-sonnet-4-5", reasoning: true };
const glmEmbed: ThinkingModel = { id: "zai-org/glm-embedding", reasoning: false };

void describe("isMatchedModel", () => {
	void it("matches GLM, DeepSeek, and Kimi ids across providers", () => {
		assert.strictEqual(isMatchedModel({ id: "zai-org/glm-5.2" }), true);
		assert.strictEqual(isMatchedModel({ id: "zai-org/glm-5.1" }), true);
		assert.strictEqual(isMatchedModel({ id: "z-ai/glm-5.2" }), true);
		assert.strictEqual(isMatchedModel({ id: "glm-4.6" }), true);
		assert.strictEqual(isMatchedModel({ id: "chatglm3-turbo" }), true);
		assert.strictEqual(isMatchedModel({ id: "deepseek/deepseek-v4-flash" }), true);
		assert.strictEqual(isMatchedModel({ id: "deepseek/deepseek-v4-pro" }), true);
		assert.strictEqual(isMatchedModel({ id: "moonshotai/kimi-k2.6" }), true);
		assert.strictEqual(isMatchedModel({ id: "moonshotai/kimi-k3" }), true);
	});

	void it("does not match other families or missing ids", () => {
		assert.strictEqual(isMatchedModel({ id: "anthropic/claude-sonnet-4-5" }), false);
		assert.strictEqual(isMatchedModel({ id: "openai/gpt-5.6-sol" }), false);
		assert.strictEqual(isMatchedModel({ id: "google/gemma-4-31b-it" }), false);
		assert.strictEqual(isMatchedModel(undefined), false);
		assert.strictEqual(isMatchedModel({}), false);
	});
});

void describe("getSupportedThinkingLevels / highestThinkingLevel", () => {
	void it("exposes max for GLM 5.2 (high is the floor, max is the top)", () => {
		assert.deepStrictEqual(
			getSupportedThinkingLevels(glm52),
			["off", "low", "medium", "high", "max"],
		);
		assert.strictEqual(highestThinkingLevel(glm52), "max");
	});

	void it("caps at high when a reasoning model has no thinkingLevelMap", () => {
		assert.deepStrictEqual(
			getSupportedThinkingLevels(glm51),
			["off", "minimal", "low", "medium", "high"],
		);
		assert.strictEqual(highestThinkingLevel(glm51), "high");
	});

	void it("only supports off for non-reasoning models", () => {
		assert.deepStrictEqual(getSupportedThinkingLevels(glmEmbed), ["off"]);
		assert.strictEqual(highestThinkingLevel(glmEmbed), "off");
	});

	void it("picks xhigh over max when max is null and xhigh is mapped", () => {
		const model: ThinkingModel = {
			id: "some/glm-x",
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh", max: null },
		};
		assert.deepStrictEqual(
			getSupportedThinkingLevels(model),
			["off", "minimal", "low", "medium", "high", "xhigh"],
		);
		assert.strictEqual(highestThinkingLevel(model), "xhigh");
	});

	void it("drops off when a model cannot disable thinking (off: null)", () => {
		const model: ThinkingModel = {
			id: "some/glm-always",
			reasoning: true,
			thinkingLevelMap: { off: null, high: "high" },
		};
		assert.deepStrictEqual(
			getSupportedThinkingLevels(model),
			["minimal", "low", "medium", "high"],
		);
		assert.strictEqual(highestThinkingLevel(model), "high");
	});

	void it("matches pi-ai semantics for a synthetic high/max-only map", () => {
		const model: ThinkingModel = {
			id: "some/max-model",
			reasoning: true,
			thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" },
		};
		assert.deepStrictEqual(getSupportedThinkingLevels(model), ["off", "high", "max"]);
		assert.strictEqual(highestThinkingLevel(model), "max");
	});

	void it("tops at xhigh for the real openrouter deepseek v4 map", () => {
		// Same shape as the real openrouter deepseek v4 catalog entries — see the
		// deepseekV4Pro fixture.
		assert.deepStrictEqual(getSupportedThinkingLevels(deepseekV4Pro), ["off", "high", "xhigh"]);
		assert.strictEqual(highestThinkingLevel(deepseekV4Pro), "xhigh");
	});

	void it("caps at high for a Kimi model with no thinkingLevelMap", () => {
		// lilac's moonshotai/kimi-k2.6: reasoning true, no map registered.
		const kimi: ThinkingModel = { id: "moonshotai/kimi-k2.6", reasoning: true };
		assert.strictEqual(highestThinkingLevel(kimi), "high");
	});

	void it("tops at xhigh for the openrouter kimi-k3 xhigh-only map", () => {
		// moonshotai/kimi-k3 in pi-ai 0.80.10's openrouter catalog: { xhigh: "xhigh" }.
		const model: ThinkingModel = { id: "moonshotai/kimi-k3", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } };
		assert.deepStrictEqual(
			getSupportedThinkingLevels(model),
			["off", "minimal", "low", "medium", "high", "xhigh"],
		);
		assert.strictEqual(highestThinkingLevel(model), "xhigh");
	});
});
void describe("applyMaxReasoning", () => {
	function makeApi(start: ThinkingLevel) {
		const setCalls: ThinkingLevel[] = [];
		let current = start;
		const api = {
			getThinkingLevel: () => current,
			setThinkingLevel: (level: ThinkingLevel) => {
				setCalls.push(level);
				current = level;
			},
		};
		return { api, setCalls, current: () => current };
	}

	function makeUi() {
		const notes: string[] = [];
		const notifyUi = { notify: (m: string) => notes.push(m) };
		return { notifyUi, notes };
	}

	void it("raises high → max for GLM 5.2 and notifies", () => {
		const { api, setCalls } = makeApi("high");
		const { notifyUi, notes } = makeUi();
		assert.strictEqual(applyMaxReasoning(api, glm52, notifyUi), "max");
		assert.deepStrictEqual(setCalls, ["max"]);
		assert.deepStrictEqual(notes, ["zai-org/glm-5.2: reasoning set to max"]);
	});

	void it("is a no-op when already at the model's top", () => {
		const { api, setCalls } = makeApi("max");
		const { notifyUi, notes } = makeUi();
		assert.strictEqual(applyMaxReasoning(api, glm52, notifyUi), "max");
		assert.deepStrictEqual(setCalls, []);
		assert.deepStrictEqual(notes, []);
	});

	void it("caps at high for a GLM model with no thinkingLevelMap", () => {
		const { api, setCalls } = makeApi("medium");
		const { notifyUi, notes } = makeUi();
		assert.strictEqual(applyMaxReasoning(api, glm51, notifyUi), "high");
		assert.deepStrictEqual(setCalls, ["high"]);
		assert.deepStrictEqual(notes, ["zai-org/glm-5.1: reasoning set to high"]);
	});

	void it("ignores unmatched model families entirely", () => {
		const { api, setCalls } = makeApi("low");
		const { notifyUi, notes } = makeUi();
		assert.strictEqual(applyMaxReasoning(api, claude, notifyUi), undefined);
		assert.deepStrictEqual(setCalls, []);
		assert.deepStrictEqual(notes, []);
	});

	void it("ignores non-reasoning GLM models", () => {
		const { api, setCalls } = makeApi("off");
		const { notifyUi, notes } = makeUi();
		assert.strictEqual(applyMaxReasoning(api, glmEmbed, notifyUi), undefined);
		assert.deepStrictEqual(setCalls, []);
		assert.deepStrictEqual(notes, []);
	});

	void it("works without a ui (silent)", () => {
		const { api, setCalls } = makeApi("high");
		assert.strictEqual(applyMaxReasoning(api, glm52, undefined), "max");
		assert.deepStrictEqual(setCalls, ["max"]);
	});
});

void describe("maxReasoning extension wiring", () => {
	function createMockPi(start: ThinkingLevel) {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const setCalls: ThinkingLevel[] = [];
		let current = start;
		const pi = {
			getThinkingLevel: () => current,
			setThinkingLevel: (level: ThinkingLevel) => {
				setCalls.push(level);
				current = level;
			},
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers.set(event, handler);
			},
		};
		const fire = (event: string, ev: unknown, ctx: unknown) => handlers.get(event)?.(ev, ctx);
		return { pi, setCalls, fire };
	}

	void it("bumps to max on model_select for a GLM model", () => {
		const { pi, setCalls, fire } = createMockPi("high");
		plugin(pi as never);
		fire("model_select", { model: glm52 }, { ui: { notify: () => {} } });
		assert.deepStrictEqual(setCalls, ["max"]);
	});

	void it("falls back to ctx.model when event.model is missing", () => {
		const { pi, setCalls, fire } = createMockPi("medium");
		plugin(pi as never);
		fire("model_select", { model: undefined }, { model: glm51, ui: { notify: () => {} } });
		assert.deepStrictEqual(setCalls, ["high"]);
	});

	void it("bumps to max on session_start for the active GLM model", () => {
		const { pi, setCalls, fire } = createMockPi("high");
		plugin(pi as never);
		fire("session_start", {}, { model: glm52, ui: { notify: () => {} } });
		assert.deepStrictEqual(setCalls, ["max"]);
	});

	void it("bumps to xhigh on model_select for a deepseek model", () => {
		const { pi, setCalls, fire } = createMockPi("high");
		plugin(pi as never);
		fire("model_select", { model: deepseekV4Pro }, { ui: { notify: () => {} } });
		assert.deepStrictEqual(setCalls, ["xhigh"]);
	});

	void it("bumps to high on session_start for a kimi model without a map", () => {
		const kimi: ThinkingModel = { id: "moonshotai/kimi-k2.6", reasoning: true };
		const { pi, setCalls, fire } = createMockPi("low");
		plugin(pi as never);
		fire("session_start", {}, { model: kimi, ui: { notify: () => {} } });
		assert.deepStrictEqual(setCalls, ["high"]);
	});

	void it("does not touch an unmatched model on session_start", () => {
		const { pi, setCalls, fire } = createMockPi("low");
		plugin(pi as never);
		fire("session_start", {}, { model: claude, ui: { notify: () => {} } });
		assert.deepStrictEqual(setCalls, []);
	});
});
