import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import plugin from "../extensions/disable-opencode-zen.ts";

interface Registration {
	name: string;
	config: { models?: unknown[] };
}

function createMockPi() {
	const registrations: Registration[] = [];

	return {
		registrations,
		registerProvider: (name: string, config: { models?: unknown[] }) => {
			registrations.push({ name, config });
		},
	};
}

void describe("disable-opencode-zen", () => {
	void it("replaces the built-in opencode provider's models with an empty list", () => {
		const pi = createMockPi();
		plugin(pi as never);

		assert.deepEqual(
			pi.registrations.map((registration) => registration.name),
			["opencode"],
		);
		assert.deepEqual(pi.registrations[0]?.config, { models: [] });
	});
});
