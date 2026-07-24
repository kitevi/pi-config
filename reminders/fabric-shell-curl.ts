import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ToolExecutionEndEvent = {
	toolName?: string;
	result?: unknown;
};

type ReminderArgs = {
	event: ToolExecutionEndEvent;
};

/**
 * Fires when a `fabric_exec` result contains a shell `curl` invocation.
 * Web pages should be fetched with `mcp.exa.web_fetch_exa`, which returns clean
 * text and avoids shell-quoting/truncation issues; `curl` is the fallback.
 */
export const FABRIC_SHELL_CURL_MESSAGE =
	"Prefer `mcp.exa.web_fetch_exa({ urls: [...] })` for fetching web pages — it returns clean text without shell-quoting or truncation issues. Reserve shell `curl` for cases where you need raw headers, status codes, or timing, or where the MCP tool is unavailable.";

const CURL_PATTERN = /\bcurl\s/;

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

export function createFabricShellCurlReminder() {
	return {
		on: "tool_execution_end" as const,
		when: ({ event }: ReminderArgs) => {
			if (event.toolName !== "fabric_exec") return false;
			return CURL_PATTERN.test(resultText(event));
		},
		message: FABRIC_SHELL_CURL_MESSAGE,
		once: true,
	};
}

export default function (_pi: ExtensionAPI) {
	return createFabricShellCurlReminder();
}
