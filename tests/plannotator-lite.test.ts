import assert from "node:assert";
import { describe, it } from "node:test";
import {
	anchorMessageFeedback,
	createPlannotatorLiteExtension,
	getPlannotatorModuleUrl,
	getPlannotatorPackageRoot,
	type PlannotatorLiteRuntime,
} from "../extensions/plannotator-lite.ts";

function createMockPi() {
	const commands = new Map<string, { handler: (args: string | undefined, ctx: unknown) => Promise<void> | void }>();
	const sentMessages: Array<{ content: unknown; options: unknown }> = [];
	const shortcuts: unknown[] = [];
	const tools: unknown[] = [];

	return {
		commands,
		sentMessages,
		shortcuts,
		tools,
		registerCommand: (name: string, command: { handler: (args: string | undefined, ctx: unknown) => Promise<void> | void }) => {
			commands.set(name, command);
		},
		registerShortcut: (...args: unknown[]) => {
			shortcuts.push(args);
		},
		registerTool: (...args: unknown[]) => {
			tools.push(args);
		},
		sendUserMessage: (content: unknown, options: unknown) => {
			sentMessages.push({ content, options });
		},
	};
}

function createMockCtx(overrides: Partial<{ notifications: Array<{ message: string; type: string }>; idle: boolean }> = {}) {
	const notifications = overrides.notifications ?? [];
	return {
		ui: {
			notify: (message: string, type = "info") => {
				notifications.push({ message, type });
			},
		},
		isIdle: () => overrides.idle ?? true,
		notifications,
	};
}

function nextTick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function createRuntime(overrides: Partial<PlannotatorLiteRuntime> = {}): PlannotatorLiteRuntime {
	return {
		hasReviewBrowserHtml: () => true,
		hasPlanBrowserHtml: () => true,
		getStartupErrorMessage: (err) => err instanceof Error ? err.message : String(err),
		startCodeReviewBrowserSession: async () => ({
			url: "http://review.local",
			waitForDecision: async () => ({ exit: true }),
		}),
		startLastMessageAnnotationSession: async () => ({
			url: "http://last.local",
			waitForDecision: async () => ({ exit: true }),
		}),
		parseReviewArgs: () => ({}),
		parseAnnotateArgs: () => ({}),
		loadConfig: () => ({ lite: true }),
		getReviewApprovedPrompt: () => "APPROVED_REVIEW_PROMPT",
		getReviewDeniedSuffix: () => "\nDENIED_SUFFIX",
		getAnnotateMessageFeedbackPrompt: (_agent, _config, options) => `ANNOTATE:${options.feedback}`,
		getLastAssistantMessageSnapshot: () => ({ entryId: "latest", text: "latest assistant message" }),
		findAssistantMessageByEntryId: (_ctx, entryId) => ({ entryId, text: `message ${entryId}` }),
		getRecentAssistantMessages: () => [],
		hasSessionMovedPastEntry: () => false,
		...overrides,
	};
}

void describe("plannotator-lite", () => {
	void it("resolves Plannotator modules from Pi's npm package cache", () => {
		assert.strictEqual(
			getPlannotatorPackageRoot("/home/pun"),
			"/home/pun/.pi/agent/npm/node_modules/@plannotator/pi-extension",
		);
		assert.strictEqual(
			getPlannotatorModuleUrl("/home/pun/.pi/agent/npm/node_modules/@plannotator/pi-extension", "generated/prompts.ts"),
			"file:///home/pun/.pi/agent/npm/node_modules/@plannotator/pi-extension/generated/prompts.ts",
		);
	});

	void it("registers only the review and last-message commands", () => {
		const pi = createMockPi();
		createPlannotatorLiteExtension({ loadRuntime: async () => createRuntime() })(pi as never);

		assert.deepStrictEqual([...pi.commands.keys()].sort(), ["plannotator-last", "plannotator-review"]);
		assert.deepStrictEqual(pi.shortcuts, []);
		assert.deepStrictEqual(pi.tools, []);
	});

	void it("sends the approved-review follow-up when code review is approved", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		let parsedArgs = "";
		let startOptions: unknown;
		const runtime = createRuntime({
			parseReviewArgs: (args) => {
				parsedArgs = args;
				return { prUrl: "https://example.com/pr/1", vcsType: "git", useLocal: true };
			},
			startCodeReviewBrowserSession: async (_ctx, options) => {
				startOptions = options;
				return {
					url: "http://review.local",
					waitForDecision: async () => ({ approved: true }),
				};
			},
		});
		createPlannotatorLiteExtension({ loadRuntime: async () => runtime })(pi as never);

		await pi.commands.get("plannotator-review")?.handler("https://example.com/pr/1 --git", ctx);
		await nextTick();

		assert.strictEqual(parsedArgs, "https://example.com/pr/1 --git");
		assert.deepStrictEqual(startOptions, {
			prUrl: "https://example.com/pr/1",
			vcsType: "git",
			useLocal: true,
		});
		assert.deepStrictEqual(pi.sentMessages, [
			{ content: "APPROVED_REVIEW_PROMPT", options: { deliverAs: "followUp" } },
		]);
	});

	void it("appends the denied suffix only when code-review feedback has annotations", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		const runtime = createRuntime({
			startCodeReviewBrowserSession: async () => ({
				url: "http://review.local",
				waitForDecision: async () => ({
					approved: false,
					feedback: "Please fix this.",
					annotations: [{ id: 1 }],
				}),
			}),
		});
		createPlannotatorLiteExtension({ loadRuntime: async () => runtime })(pi as never);

		await pi.commands.get("plannotator-review")?.handler("", ctx);
		await nextTick();

		assert.deepStrictEqual(pi.sentMessages, [
			{ content: "Please fix this.\nDENIED_SUFFIX", options: { deliverAs: "followUp" } },
		]);
	});

	void it("anchors last-message feedback when the selected message is no longer current", async () => {
		const pi = createMockPi();
		const ctx = createMockCtx();
		const runtime = createRuntime({
			getLastAssistantMessageSnapshot: () => ({ entryId: "latest", text: "latest assistant message" }),
			findAssistantMessageByEntryId: (_ctx, entryId) => ({ entryId, text: "older assistant message" }),
			hasSessionMovedPastEntry: (_ctx, entryId) => entryId === "older",
			startLastMessageAnnotationSession: async (_ctx, message, gate, pickerMessages) => {
				assert.strictEqual(message, "latest assistant message");
				assert.strictEqual(gate, true);
				assert.strictEqual(pickerMessages, undefined);
				return {
					url: "http://last.local",
					waitForDecision: async () => ({
						approved: false,
						feedback: "Use fewer words.",
						selectedMessageId: "older",
					}),
				};
			},
			parseAnnotateArgs: (args) => {
				assert.strictEqual(args, "--gate");
				return { gate: true };
			},
		});
		createPlannotatorLiteExtension({ loadRuntime: async () => runtime })(pi as never);

		await pi.commands.get("plannotator-last")?.handler("--gate", ctx);
		await nextTick();

		assert.deepStrictEqual(pi.sentMessages, [
			{
				content: "ANNOTATE:" + anchorMessageFeedback("Use fewer words.", "older assistant message"),
				options: { deliverAs: "followUp" },
			},
		]);
	});
});
