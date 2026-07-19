import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FABRIC_CODE_MODE_CONTEXT_GUARD_MARKER } from "../extensions/fabric-code-mode-context-guard.ts";
import {
	createFabricContextGuardLoopReminder,
	FABRIC_CONTEXT_GUARD_LOOP_REMINDER_MESSAGE,
} from "../reminders/fabric-context-guard.ts";

const guardedText = `[${FABRIC_CODE_MODE_CONTEXT_GUARD_MARKER}: oversized]`;

function result(text: string, toolName = "fabric_exec") {
	return {
		event: {
			toolName,
			result: { content: [{ type: "text", text }] },
		},
	};
}

void describe("Fabric context guard reminder", () => {
	void it("fires once on the second consecutive guarded Fabric result", () => {
		const reminder = createFabricContextGuardLoopReminder();

		assert.strictEqual(reminder.on, "tool_execution_end");
		assert.strictEqual(reminder.once, true);
		assert.strictEqual(reminder.when(result(guardedText)), false);
		assert.strictEqual(reminder.when(result("nested output", "read")), false);
		assert.strictEqual(reminder.when(result(guardedText)), true);
		assert.match(FABRIC_CONTEXT_GUARD_LOOP_REMINDER_MESSAGE, /saved artifact wholesale/);
	});

	void it("resets the streak after an unguarded Fabric result", () => {
		const reminder = createFabricContextGuardLoopReminder();

		assert.strictEqual(reminder.when(result(guardedText)), false);
		assert.strictEqual(reminder.when(result("small result")), false);
		assert.strictEqual(reminder.when(result(guardedText)), false);
		assert.strictEqual(reminder.when(result(guardedText)), true);
	});
});
