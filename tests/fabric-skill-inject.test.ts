import { assert, describe, it } from "vitest";
import plugin, {
	DISTILLED_BLOCK,
	isTargetModel,
	type ModelIdentity,
} from "../extensions/fabric-skill-inject.ts";

void describe("isTargetModel", () => {
	void it("matches DeepSeek Flash models across provider, id, and name", () => {
		assert.strictEqual(
			isTargetModel({
				provider: "OpenRouter",
				id: "deepseek/deepseek-v4-FLASH",
			}),
			true,
		);
		assert.strictEqual(
			isTargetModel({
				provider: "openrouter",
				id: "deepseek/deepseek-v4-flash-0731",
			}),
			true,
		);
		assert.strictEqual(
			isTargetModel({ provider: "DEEPSEEK", id: "v4-FLASH", name: "V4" }),
			true,
		);
		assert.strictEqual(
			isTargetModel({ provider: "custom", id: "model-42", name: "DeepSeek Flash" }),
			true,
		);
	});

	void it("requires both DeepSeek and Flash", () => {
		assert.strictEqual(
			isTargetModel({ provider: "openrouter", id: "deepseek/deepseek-v4-pro" }),
			false,
		);
		assert.strictEqual(
			isTargetModel({ provider: "custom", id: "generic-flash" }),
			false,
		);
		assert.strictEqual(isTargetModel(undefined), false);
	});
});

void describe("fabric skill injection", () => {
	type HookResult = { systemPrompt: string } | undefined;
	type Hook = (
		event: { systemPrompt: string },
		ctx: { model?: ModelIdentity },
	) => Promise<HookResult>;

	function registeredHook(activeTools: string[] = ["fabric_exec"]): Hook {
		const handlers = new Map<string, Hook>();
		const pi = {
			getActiveTools: () => activeTools,
			on(event: string, handler: Hook) {
				handlers.set(event, handler);
			},
		};
		plugin(pi as never);
		const hook = handlers.get("before_agent_start");
		assert.ok(hook, "before_agent_start handler should be registered");
		return hook;
	}

	void it("appends identical static guidance for matching models", async () => {
		const hook = registeredHook();
		const event = { systemPrompt: "BASE" };
		const ctx = {
			model: { provider: "openrouter", id: "deepseek/deepseek-v4-flash" },
		};
		const first = await hook(event, ctx);
		const second = await hook(event, ctx);

		assert.deepStrictEqual(first, second);
		assert.strictEqual(first?.systemPrompt, `BASE${DISTILLED_BLOCK}`);
		assert.isBelow(DISTILLED_BLOCK.length, 1_800, "keep the supplement compact");
	});

	void it("does nothing when fabric_exec is inactive", async () => {
		const hook = registeredHook([]);
		assert.isUndefined(
			await hook(
				{ systemPrompt: "BASE" },
				{ model: { provider: "openrouter", id: "deepseek/deepseek-v4-flash" } },
			),
		);
	});

	void it("does nothing for other models or an already injected prompt", async () => {
		const hook = registeredHook();
		assert.isUndefined(
			await hook(
				{ systemPrompt: "BASE" },
				{ model: { provider: "openrouter", id: "deepseek/deepseek-v4-pro" } },
			),
		);
		assert.isUndefined(
			await hook(
				{ systemPrompt: `BASE${DISTILLED_BLOCK}` },
				{ model: { provider: "openrouter", id: "deepseek/deepseek-v4-flash" } },
			),
		);
	});
});
