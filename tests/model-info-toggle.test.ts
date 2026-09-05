import { assert } from "vitest";
import { describe, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	formatFooterTokenCount,
	injectDumbZoneIntoFooterLine,
	shouldShowDumbZone,
} from "../extensions/model-info-toggle.ts";

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
