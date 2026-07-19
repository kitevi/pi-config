import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FABRIC_CODE_MODE_CONTEXT_GUARD_MARKER } from "../extensions/fabric-code-mode-context-guard.ts";

type ToolExecutionEndEvent = {
	toolName?: string;
	result?: unknown;
};

type ReminderArgs = {
	event: ToolExecutionEndEvent;
};

export const FABRIC_CONTEXT_GUARD_LOOP_REMINDER_MESSAGE =
	"The last two Fabric results exceeded the context guard. Stop retrying broad reads. The guard applies to the combined final fabric_exec return regardless of whether the data came from pi.read, bash, or the saved output file. Process large data inside the sandbox and return only a bounded excerpt or summary. Do not read or return the saved artifact wholesale.";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isGuardedFabricExecution(event: ToolExecutionEndEvent): boolean {
	if (event.toolName !== "fabric_exec" || !isRecord(event.result)) return false;
	const content = event.result.content;
	if (!Array.isArray(content)) return false;

	return content.some(
		(block) =>
			isRecord(block) &&
			block.type === "text" &&
			typeof block.text === "string" &&
			block.text.includes(`[${FABRIC_CODE_MODE_CONTEXT_GUARD_MARKER}:`),
	);
}

export function createFabricContextGuardLoopReminder() {
	let consecutiveGuardedFabricResults = 0;

	return {
		on: "tool_execution_end" as const,
		when: ({ event }: ReminderArgs) => {
			if (event.toolName !== "fabric_exec") return false;
			if (!isGuardedFabricExecution(event)) {
				consecutiveGuardedFabricResults = 0;
				return false;
			}

			consecutiveGuardedFabricResults += 1;
			return consecutiveGuardedFabricResults === 2;
		},
		message: FABRIC_CONTEXT_GUARD_LOOP_REMINDER_MESSAGE,
		once: true,
	};
}

export default function (_pi: ExtensionAPI) {
	return createFabricContextGuardLoopReminder();
}
