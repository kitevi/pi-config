import { assert } from "vitest";
import { describe, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import plugin, {
	formatFooterTokenCount,
	getModelVerbosity,
	injectDumbZoneIntoFooterLine,
	patchPayloadVerbosity,
	shouldShowDumbZone,
} from "../extensions/model-info-toggle.ts";

function createMockPi() {
	const handlers: Array<{
		event: string;
		handler: (...args: unknown[]) => unknown;
	}> = [];

	return {
		registerShortcut: () => undefined,
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			handlers.push({ event, handler });
		},
		fireBeforeProviderRequest: (event: unknown, ctx: unknown) => {
			for (const h of handlers) {
				if (h.event === "before_provider_request") {
					return h.handler(event, ctx);
				}
			}
		},
	};
}

void describe("model-info-toggle verbosity", () => {
	void it("uses low verbosity for current and future GPT Responses models", () => {
		assert.strictEqual(getModelVerbosity({ api: "openai-responses", id: "gpt-5.5" } as never), "low");
		assert.strictEqual(getModelVerbosity({ api: "openai-responses", id: "gpt-6" } as never), "low");
		assert.strictEqual(getModelVerbosity({ api: "openai-codex-responses", id: "gpt-6-codex" } as never), "low");
	});

	void it("does not set verbosity for unsupported APIs", () => {
		assert.strictEqual(getModelVerbosity({ api: "openai-completions", id: "gpt-6" } as never), undefined);
	});

	void it("sets Responses API text.verbosity without dropping existing text config", () => {
		const payload = patchPayloadVerbosity(
			{ model: "gpt-6", text: { format: { type: "text" } } },
			"low",
		);

		assert.deepStrictEqual(payload, {
			model: "gpt-6",
			text: {
				format: { type: "text" },
				verbosity: "low",
			},
		});
	});

	void it("injects text.verbosity via before_provider_request for future GPT models", () => {
		const pi = createMockPi();
		plugin(pi as never);

		const result = pi.fireBeforeProviderRequest(
			{ payload: { model: "gpt-6", text: { format: { type: "text" } } } },
			{ model: { api: "openai-responses", id: "gpt-6" } },
		);

		assert.deepStrictEqual(result, {
			model: "gpt-6",
			text: {
				format: { type: "text" },
				verbosity: "low",
			},
		});
	});
});

void describe("model-info-toggle dumb-zone footer marker", () => {
	void it("formats footer token counts like Pi's footer", () => {
		assert.strictEqual(formatFooterTokenCount(999), "999");
		assert.strictEqual(formatFooterTokenCount(1_001), "1.0k");
		assert.strictEqual(formatFooterTokenCount(9_999), "10.0k");
		assert.strictEqual(formatFooterTokenCount(128_000), "128k");
		assert.strictEqual(formatFooterTokenCount(1_250_000), "1.3M");
	});

	void it("only enters the dumb zone after 128k tokens", () => {
		assert.strictEqual(shouldShowDumbZone(undefined), false);
		assert.strictEqual(shouldShowDumbZone({ tokens: null }), false);
		assert.strictEqual(shouldShowDumbZone({ tokens: 128_000 }), false);
		assert.strictEqual(shouldShowDumbZone({ tokens: 128_001 }), true);
	});

	void it("inserts the marker inline after the context window without adding a row", () => {
		const line = "↑24k ↓3k 68.2%/200k                         model";
		const label = "\x1b[33mdumb\x1b[39m";
		const result = injectDumbZoneIntoFooterLine(line, 200_000, label, 80);

		assert.match(result, /\/200k \x1b\[33mdumb\x1b\[39m/);
		assert.match(result, /model$/);
		assert.strictEqual(result.split("\n").length, 1);
		assert.ok(visibleWidth(result) <= 80);
	});
});
