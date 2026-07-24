import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ToolExecutionEndEvent = {
	toolName?: string;
	result?: unknown;
};

type ReminderArgs = {
	event: ToolExecutionEndEvent;
};

/**
 * Fires when a `fabric_exec` result contains an error that looks like a `pi.*`
 * return-shape mismatch — e.g. `html.match is not a function` (treated an
 * `{ ok, output, details }` object as a string) or `Cannot read properties of
 * undefined (reading 'output')`. These errors almost always mean the agent
 * guessed a `pi.*` signature instead of reading the `fabric-exec` skill.
 */
export const FABRIC_API_MISUSE_MESSAGE =
	"This error looks like a `pi.*` return-shape mismatch. `pi.bash`, `pi.edit`, `pi.write`, and `pi.bashSettled` return `{ ok, output, details }` — read `.output`. Only `pi.read`, `pi.grep`, `pi.find`, and `pi.ls` return strings. Before retrying, load the `fabric-exec` skill (read its SKILL.md) and confirm the `pi.*` signatures; do not guess the API or \"fix\" a tool whose docs you have not read. If this error is a bug in your own logic rather than a `pi.*` call, disregard.";

const API_MISUSE_PATTERN = /is not a function|Cannot read properties of (?:undefined|null)/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultText(event: ToolExecutionEndEvent): string {
	if (!isRecord(event.result)) return "";
	const content = event.result.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: string; text: string } =>
				isRecord(block) && block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

export function createFabricApiMisuseReminder() {
	return {
		on: "tool_execution_end" as const,
		when: ({ event }: ReminderArgs) => {
			if (event.toolName !== "fabric_exec") return false;
			return API_MISUSE_PATTERN.test(resultText(event));
		},
		message: FABRIC_API_MISUSE_MESSAGE,
		once: true,
	};
}

export default function (_pi: ExtensionAPI) {
	return createFabricApiMisuseReminder();
}
