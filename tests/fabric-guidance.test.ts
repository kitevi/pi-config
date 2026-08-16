import { readFileSync } from "node:fs";
import { assert, describe, it } from "vitest";
import nonFrontierPlugin from "../extensions/fabric-non-frontier-guidance.ts";
import frontierPlugin, {
	FRONTIER_GUIDANCE,
	FRONTIER_MODELS,
} from "../extensions/fabric-frontier-guidance.ts";

const REGISTER_EVENT = "pi-fabric:component:register:v1";
const DISCOVER_EVENT = "pi-fabric:component:discover:v1";
const fabricConfig = JSON.parse(readFileSync(new URL("../fabric.json", import.meta.url), "utf8")) as {
	components: Array<{ id: string; component: string }>;
};

type Guide = {
	label: string;
	models: readonly string[];
	targets: readonly string[];
	placement: string;
	content: string;
};
type Component = {
	name: string;
	activate(context: { guide(guide: Guide): void }): void | Promise<void>;
};
type Registration = { version: number; component: Component; overwrite?: boolean };
type Plugin = (pi: never) => void | Promise<void>;

async function inspect(plugin: Plugin): Promise<{ component: Component; guides: Guide[] }> {
	let eager: Registration | undefined;
	let discover: ((value: unknown) => void) | undefined;
	const pi = {
		events: {
			emit(event: string, value: Registration): void {
				assert.equal(event, REGISTER_EVENT);
				eager = value;
			},
			on(event: string, handler: (value: unknown) => void): () => void {
				assert.equal(event, DISCOVER_EVENT);
				discover = handler;
				return () => undefined;
			},
		},
	};

	await plugin(pi as never);
	assert.ok(eager);
	assert.equal(eager.version, 1);
	assert.equal(eager.overwrite, true);
	assert.ok(discover);

	let discovered: Component | undefined;
	discover({
		register(component: Component, options?: { overwrite?: boolean }): void {
			discovered = component;
			assert.equal(options?.overwrite, true);
		},
	});
	assert.strictEqual(discovered, eager.component);

	const guides: Guide[] = [];
	await eager.component.activate({ guide: (guide) => guides.push(guide) });
	return { component: eager.component, guides };
}

function matches(patterns: readonly string[], model: string): boolean {
	return patterns.some((pattern) => {
		let expression = "^";
		for (const character of pattern) {
			if (character === "*") expression += ".*";
			else if (character === "?") expression += ".";
			else expression += /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
		}
		return new RegExp(`${expression}$`, "u").test(model);
	});
}

describe("Fabric model guidance", () => {
	it("registers both configured components through eager and discovery paths", async () => {
		const [nonFrontier, frontier] = await Promise.all([
			inspect(nonFrontierPlugin),
			inspect(frontierPlugin),
		]);
		assert.deepEqual(fabricConfig.components, [
			{ id: "non-frontier-guidance", component: nonFrontier.component.name },
			{ id: "frontier-guidance", component: frontier.component.name },
		]);
	});

	it("routes only non-frontier models (DeepSeek V4, Qwen 27B) to the detailed guidance", async () => {
		const { guides } = await inspect(nonFrontierPlugin);
		assert.equal(guides.length, 2);
		for (const guide of guides) {
			assert.deepEqual(guide.targets, ["main", "participant"]);
			assert.equal(guide.placement, "append");
			assert.equal(matches(guide.models, "openrouter/deepseek/deepseek-v4-pro"), true);
			assert.equal(matches(guide.models, "neuralwatt/deepseek-ai/DeepSeek-V4-Flash"), true);
			assert.equal(matches(guide.models, "openrouter/qwen/qwen3.6-27b"), true);
			assert.equal(matches(guide.models, "neuralwatt/Qwen/Qwen3.8-27B-FP8"), true);
			assert.equal(matches(guide.models, "synthetic/hf:Qwen/Qwen3.6-27B"), true);
			assert.equal(matches(guide.models, "openrouter/deepseek/deepseek-r1"), false);
			assert.equal(matches(guide.models, "openrouter/google/gemma-3-27b-it"), false);
			assert.equal(matches(guide.models, "openrouter/qwen/qwen-2.5-72b-instruct"), false);
		}
	});

	it("routes concise MCP guidance to Kimi, GPT, GLM, and MiniMax only", async () => {
		const { guides } = await inspect(frontierPlugin);
		assert.equal(guides.length, 1);
		assert.deepEqual(guides[0]?.models, FRONTIER_MODELS);
		assert.deepEqual(guides[0]?.targets, ["main", "participant"]);
		assert.equal(guides[0]?.content, FRONTIER_GUIDANCE);
		for (const model of [
			"openrouter/moonshotai/kimi-k2.5",
			"openai-codex/gpt-5.4",
			"synthetic/hf:zai-org/GLM-5.2",
			"openrouter/minimax/minimax-m2.7",
		]) assert.equal(matches(FRONTIER_MODELS, model), true, model);
		for (const model of [
			"openrouter/deepseek/deepseek-v4-pro",
			"anthropic/claude-sonnet-4-6",
		]) assert.equal(matches(FRONTIER_MODELS, model), false, model);
		assert.notMatch(FRONTIER_GUIDANCE, /exa|context7|web_search_exa/i);
	});
});
