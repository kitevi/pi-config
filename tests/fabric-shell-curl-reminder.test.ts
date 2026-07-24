import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createFabricShellCurlReminder,
	FABRIC_SHELL_CURL_MESSAGE,
} from "../reminders/fabric-shell-curl.ts";

function result(text: string, toolName = "fabric_exec") {
	return { event: { toolName, result: { content: [{ type: "text", text }] } } };
}

void describe("Fabric shell curl reminder", () => {
	void it("fires when a shell curl invocation appears in the result", () => {
		const reminder = createFabricShellCurlReminder();

		assert.strictEqual(reminder.on, "tool_execution_end");
		assert.strictEqual(reminder.once, true);
		assert.strictEqual(reminder.when(result("bash $ curl -sL https://example.com")), true);
		assert.match(FABRIC_SHELL_CURL_MESSAGE, /web_fetch_exa/);
	});

	void it("does not fire on a normal result", () => {
		const reminder = createFabricShellCurlReminder();

		assert.strictEqual(reminder.when(result("pi.read returned a file")), false);
	});

	void it("ignores non-fabric_exec tools", () => {
		const reminder = createFabricShellCurlReminder();

		assert.strictEqual(reminder.when(result("bash $ curl -sL https://example.com", "read")), false);
	});
});
