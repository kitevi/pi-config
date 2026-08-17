import { describe, it, expect } from "vitest";
import { shouldAttemptCompact, PROMPT_COOLDOWN, MIN_TOKENS_FOR_ATTEMPT } from "./extensions/compact-before-model-switch";

describe("compact gating", () => {
	it("blocks during cooldown even with a large context", () => {
		expect(shouldAttemptCompact({ promptsSinceCompact: PROMPT_COOLDOWN - 1 }, 200_000)).toBe(false);
	});
	it("allows once cooldown elapsed and context is large", () => {
		expect(shouldAttemptCompact({ promptsSinceCompact: PROMPT_COOLDOWN }, 200_000)).toBe(true);
	});
	it("blocks a small context even after cooldown", () => {
		expect(shouldAttemptCompact({ promptsSinceCompact: 999 }, MIN_TOKENS_FOR_ATTEMPT - 1)).toBe(false);
	});
	it("still attempts after cooldown when token count is unavailable", () => {
		expect(shouldAttemptCompact({ promptsSinceCompact: PROMPT_COOLDOWN }, null)).toBe(true);
	});
});
