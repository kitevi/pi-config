import assert from "node:assert";
import { describe, it } from "node:test";
import {
	buildExportPath,
	registerAgentLoopExport,
	toSerializable,
} from "../extensions/zz-export-agent/index.ts";
import {
	createAgentLoopReport,
	escapeHtml,
	estimateTokens,
	type AgentLoopSnapshot,
} from "../extensions/zz-export-agent/report.ts";

const generatedAt = new Date("2026-04-09T12:34:56.000Z");

function fixtureSnapshot(): AgentLoopSnapshot {
	return {
		schemaVersion: 2,
		generatedAt: generatedAt.toISOString(),
		capture: {
			fidelity: "provider-request",
			sessionStartedAt: "2026-04-09T12:30:00.000Z",
			sessionStartReason: "startup",
			runStartedAt: "2026-04-09T12:31:00.000Z",
			latestContextBuiltAt: "2026-04-09T12:31:01.100Z",
			latestProviderRequestAt: "2026-04-09T12:31:01.200Z",
			providerRequestCount: 2,
			existingContextEntriesAtLoad: 0,
			note: "Latest request captured.",
		},
		session: {
			id: "session-12345678",
			file: "/tmp/session.jsonl",
			cwd: "/work/project",
			persisted: true,
		},
		model: {
			provider: "anthropic",
			id: "test-model",
			name: "Test Model",
			api: "anthropic-messages",
			contextWindow: 200_000,
			maxTokens: 16_000,
			reasoning: true,
			input: ["text"],
			thinkingLevel: "high",
		},
		prompt: {
			effective: "Core prompt\n\nAppend instructions",
			options: {
				selectedTools: ["read"],
				toolSnippets: { read: "Read a file" },
				promptGuidelines: ["Use read for file contents."],
				appendSystemPrompt: "Append instructions",
				cwd: "/work/project",
				contextFiles: [{ path: "/work/project/AGENTS.md", content: "Do the careful thing." }],
				skills: [{
					name: "review",
					description: "Review changes",
					filePath: "/skills/review/SKILL.md",
					baseDir: "/skills/review",
					disableModelInvocation: false,
				}],
			},
		},
		tools: [{
			name: "read",
			description: "Read text files",
			active: true,
			parameters: { type: "object", properties: { path: { type: "string" } } },
			promptGuidelines: ["Use read for file contents."],
			promptSnippet: "Read a file",
			sourceInfo: {
				path: "<builtin:read>",
				source: "builtin",
				scope: "temporary",
				origin: "top-level",
			},
		}],
		messages: [
			{ role: "user", content: "Explain this <script>alert('x')</script>" },
			{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "AGENTS.md" } }] },
			{ role: "toolResult", toolName: "read", content: "Do the careful thing." },
		],
		providerPayload: {
			model: "test-model",
			messages: [{ role: "user", content: "Explain this <script>alert('x')</script>" }],
		},
		turns: [{
			index: 0,
			stopReason: "toolUse",
			toolCallCount: 1,
			assistant: { role: "assistant", content: [{ type: "toolCall", name: "read" }] },
			toolResults: [{ role: "toolResult", toolName: "read", content: "Do the careful thing." }],
			usage: { input: 50, cacheRead: 900, cacheWrite: 100, output: 25, totalTokens: 1_075 },
		}, {
			index: 1,
			stopReason: "stop",
			toolCallCount: 0,
			assistant: { role: "assistant", content: [{ type: "text", text: "Done" }] },
			toolResults: [],
			usage: { input: 30, cacheRead: 1_020, cacheWrite: 0, output: 40, totalTokens: 1_090 },
		}],
		commands: [{
			name: "export-agent",
			description: "Export agent loop",
			source: "extension",
			sourceInfo: {
				path: "/extensions/zz-export-agent/index.ts",
				source: "top-level",
				scope: "user",
				origin: "top-level",
			},
		}],
	};
}

void describe("agent loop HTML report", () => {
	void it("explains request ownership, caching, and automatic tool continuation", () => {
		const html = createAgentLoopReport(fixtureSnapshot());

		assert.match(html, /Pi is a loop around repeated model calls/);
		assert.match(html, /A tool call in output causes the next request/);
		assert.match(html, /Why output has no prompt cache/);
		assert.match(html, /Cached input still uses the context window/);
		assert.match(html, /Claude\.ai history and memory are separate product features/);
		assert.match(html, /Provider-specific request payload/);
		assert.match(html, /anthropic\/test-model/);
		assert.match(html, /&lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt;/);
		assert.doesNotMatch(html, /Explain this <script>/);
		assert.doesNotMatch(html, /SEND →/);
		assert.doesNotMatch(html, /https?:\/\//);
		assert.match(html, /Content-Security-Policy/);
		assert.match(html, /prefers-reduced-motion/);
		assert.match(html, /@media print/);
	});

	void it("provides deterministic escaping and clearly approximate token counts", () => {
		assert.strictEqual(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
		assert.strictEqual(estimateTokens("12345678"), 2);
	});
});

void describe("agent loop export utilities", () => {
	void it("always places a sanitized HTML filename inside the requested temp directory", () => {
		assert.strictEqual(
			buildExportPath("../../Quarterly agent demo", "abcdef123456", generatedAt, "/tmp"),
			"/tmp/Quarterly-agent-demo.html",
		);
		assert.strictEqual(
			buildExportPath("", "abcdef123456", generatedAt, "/tmp"),
			"/tmp/pi-agent-loop-abcdef12-20260409-123456Z.html",
		);
	});

	void it("serializes cycles, bigint values, and undefined without executable objects", () => {
		const cyclic: Record<string, unknown> = { count: 4n, missing: undefined };
		cyclic.self = cyclic;
		assert.deepStrictEqual(toSerializable(cyclic), {
			count: "4",
			missing: "[undefined]",
			self: "[Circular]",
		});
	});
});

void describe("agent loop extension", () => {
	void it("captures the latest request plus per-call cache and output usage", async () => {
		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
		let commandName = "";
		let written: { path: string; html: string } | undefined;
		const notifications: string[] = [];
		const promptOptions = {
			cwd: "/work/project",
			selectedTools: ["read"],
			toolSnippets: { read: "Read files" },
			promptGuidelines: [],
			contextFiles: [],
			skills: [],
		};
		const pi = {
			on(event: string, handler: (event: any, ctx: any) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
				commandName = name;
				commandHandler = command.handler;
			},
			getActiveTools: () => ["read"],
			getAllTools: () => [{
				name: "read",
				description: "Read files",
				parameters: { type: "object" },
				promptGuidelines: [],
				sourceInfo: { path: "<builtin:read>", source: "builtin", scope: "temporary", origin: "top-level" },
			}],
			getCommands: () => [{
				name: "export-agent",
				description: "Export",
				source: "extension",
				sourceInfo: { path: "/extension.ts", source: "top-level", scope: "user", origin: "top-level" },
			}],
			getThinkingLevel: () => "high",
		};
		const sessionManager = {
			buildContextEntries: () => [],
			getSessionId: () => "demo-session-id",
			getSessionFile: () => "/sessions/demo.jsonl",
			getSessionName: () => "Demo",
		};
		const ctx = {
			sessionManager,
			cwd: "/work/project",
			model: {
				provider: "anthropic",
				id: "test-model",
				name: "Test Model",
				api: "anthropic-messages",
				contextWindow: 100_000,
				maxTokens: 8_000,
				reasoning: true,
				input: ["text"],
			},
			getSystemPrompt: () => "Final effective prompt",
			getSystemPromptOptions: () => promptOptions,
			waitForIdle: async () => undefined,
			hasUI: true,
			ui: { notify: (message: string) => notifications.push(message) },
		};

		registerAgentLoopExport(pi as never, {
			now: () => generatedAt,
			tempDirectory: () => "/tmp",
			writeHtml: async (path, html) => { written = { path, html }; },
		});

		await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
		await handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "Prompt", systemPromptOptions: promptOptions }, ctx);
		await handlers.get("context")?.[0]?.({ messages: [{ role: "user", content: "Question" }] }, ctx);
		await handlers.get("before_provider_request")?.[0]?.({ payload: { request: "first" } }, ctx);
		await handlers.get("turn_end")?.[0]?.({
			turnIndex: 0,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", name: "read", arguments: { path: "README.md" } }],
				stopReason: "toolUse",
				usage: { input: 100, cacheRead: 0, cacheWrite: 500, output: 20, totalTokens: 620 },
			},
			toolResults: [{ role: "toolResult", toolName: "read", content: "file body" }],
		}, ctx);
		await handlers.get("context")?.[0]?.({ messages: [{ role: "user", content: "Question" }, { role: "toolResult", content: "file body" }] }, ctx);
		await handlers.get("before_provider_request")?.[0]?.({ payload: { request: "second" } }, ctx);
		await handlers.get("turn_end")?.[0]?.({
			turnIndex: 1,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Answer" }],
				stopReason: "stop",
				usage: { input: 30, cacheRead: 590, cacheWrite: 0, output: 40, totalTokens: 660 },
			},
			toolResults: [],
		}, ctx);
		await commandHandler?.("pi-demo", ctx);

		assert.strictEqual(commandName, "export-agent");
		assert.strictEqual(written?.path, "/tmp/pi-demo.html");
		assert.match(written?.html ?? "", /&quot;request&quot;: &quot;second&quot;/);
		assert.doesNotMatch(written?.html ?? "", /&quot;request&quot;: &quot;first&quot;/);
		assert.match(written?.html ?? "", /Cached input read<\/span><strong>590<\/strong>/);
		assert.match(written?.html ?? "", /1 tool call\(s\)/);
		assert.match(written?.html ?? "", /Final effective prompt/);
		assert.match(notifications[0] ?? "", /provider-request/);
	});
});
