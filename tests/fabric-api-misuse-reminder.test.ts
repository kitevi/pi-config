import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createFabricApiMisuseReminder,
	FABRIC_API_MISUSE_MESSAGE,
} from "../reminders/fabric-api-misuse.ts";

function result(text: string, toolName = "fabric_exec") {
	return { event: { toolName, result: { content: [{ type: "text", text }] } } };
}

void describe("Fabric API misuse reminder", () => {
	void it("fires on a return-shape TypeError (.match is not a function)", () => {
		const reminder = createFabricApiMisuseReminder();

		assert.strictEqual(reminder.on, "tool_execution_end");
		assert.strictEqual(reminder.once, true);
		assert.strictEqual(reminder.when(result("TypeError: html.match is not a function")), true);
		assert.match(FABRIC_API_MISUSE_MESSAGE, /ok, output, details/);
	});

	void it("fires on Cannot read properties of undefined (reading 'output')", () => {
		const reminder = createFabricApiMisuseReminder();

		assert.strictEqual(
			reminder.when(result("Cannot read properties of undefined (reading 'output')")),
			true,
		);
	});

	void it("does not fire on a normal result", () => {
		const reminder = createFabricApiMisuseReminder();

		assert.strictEqual(reminder.when(result("pi.read returned a file")), false);
	});

	void it("ignores non-fabric_exec tools", () => {
		const reminder = createFabricApiMisuseReminder();

		assert.strictEqual(reminder.when(result("TypeError: x is not a function", "read")), false);
	});
});
