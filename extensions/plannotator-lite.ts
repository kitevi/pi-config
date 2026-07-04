import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Pin Plannotator's local server to a fixed port.
 *
 * Plannotator stores its light/dark mode and color-theme choice in browser
 * storage keyed by origin (http://127.0.0.1:<port>). Locally it otherwise binds a
 * random port per session, so that preference never persists and the UI opens
 * dark every time. Pinning 19432 (Plannotator's own remote-default port) keeps
 * the origin stable, so a one-time toggle to light sticks across launches.
 * An explicit PLANNOTATOR_PORT in the environment still wins.
 */
process.env.PLANNOTATOR_PORT ??= "19432";

const PLANNOTATOR_PACKAGE_RELATIVE_PATH = join(
	".pi",
	"agent",
	"npm",
	"node_modules",
	"@plannotator",
	"pi-extension",
);

export interface PlannotatorDecision {
	exit?: boolean;
	approved?: boolean;
	feedback?: string;
	annotations?: unknown[];
	selectedMessageId?: string;
	feedbackScope?: string;
}

export interface PlannotatorBrowserSession {
	url: string;
	waitForDecision(): Promise<PlannotatorDecision>;
}

export interface LastAssistantMessageSnapshot {
	entryId: string;
	text: string;
}

export interface RecentAssistantMessage {
	messageId: string;
	text: string;
}

export interface PlannotatorLiteRuntime {
	hasReviewBrowserHtml(): boolean;
	hasPlanBrowserHtml(): boolean;
	getStartupErrorMessage(err: unknown): string;
	startCodeReviewBrowserSession(
		ctx: ExtensionContext,
		options: { prUrl?: string; vcsType?: unknown; useLocal?: boolean },
	): Promise<PlannotatorBrowserSession>;
	startLastMessageAnnotationSession(
		ctx: ExtensionContext,
		message: string,
		gate?: boolean,
		pickerMessages?: RecentAssistantMessage[],
	): Promise<PlannotatorBrowserSession>;
	parseReviewArgs(args: string): { prUrl?: string; vcsType?: unknown; useLocal?: boolean };
	parseAnnotateArgs(args: string): { gate?: boolean };
	loadConfig(): unknown;
	getReviewApprovedPrompt(agent: "pi", config: unknown): string;
	getReviewDeniedSuffix(agent: "pi", config: unknown): string;
	getAnnotateMessageFeedbackPrompt(agent: "pi", config: unknown, options: { feedback: string }): string;
	getLastAssistantMessageSnapshot(ctx: ExtensionContext): LastAssistantMessageSnapshot | null;
	findAssistantMessageByEntryId(ctx: ExtensionContext, entryId: string): LastAssistantMessageSnapshot | null;
	getRecentAssistantMessages(ctx: ExtensionContext, limit: number): RecentAssistantMessage[];
	hasSessionMovedPastEntry(ctx: ExtensionContext, entryId: string): boolean;
}

export type LoadPlannotatorLiteRuntime = () => Promise<PlannotatorLiteRuntime>;

export function getPlannotatorPackageRoot(home = homedir()): string {
	return join(home, PLANNOTATOR_PACKAGE_RELATIVE_PATH);
}

export function getPlannotatorModuleUrl(packageRoot: string, modulePath: string): string {
	return pathToFileURL(join(packageRoot, modulePath)).href;
}

async function importPlannotatorModule<T>(packageRoot: string, modulePath: string): Promise<T> {
	return import(getPlannotatorModuleUrl(packageRoot, modulePath)) as Promise<T>;
}

export async function loadPlannotatorLiteRuntime(
	packageRoot = getPlannotatorPackageRoot(),
): Promise<PlannotatorLiteRuntime> {
	type BrowserModule = Pick<
		PlannotatorLiteRuntime,
		| "hasReviewBrowserHtml"
		| "hasPlanBrowserHtml"
		| "getStartupErrorMessage"
		| "startCodeReviewBrowserSession"
		| "startLastMessageAnnotationSession"
	>;
	type AssistantMessageModule = Pick<
		PlannotatorLiteRuntime,
		| "getLastAssistantMessageSnapshot"
		| "findAssistantMessageByEntryId"
		| "getRecentAssistantMessages"
		| "hasSessionMovedPastEntry"
	>;
	type ReviewArgsModule = Pick<PlannotatorLiteRuntime, "parseReviewArgs">;
	type AnnotateArgsModule = Pick<PlannotatorLiteRuntime, "parseAnnotateArgs">;
	type ConfigModule = Pick<PlannotatorLiteRuntime, "loadConfig">;
	type PromptsModule = Pick<
		PlannotatorLiteRuntime,
		"getReviewApprovedPrompt" | "getReviewDeniedSuffix" | "getAnnotateMessageFeedbackPrompt"
	>;

	const [browser, assistantMessage, reviewArgs, annotateArgs, config, prompts] = await Promise.all([
		importPlannotatorModule<BrowserModule>(packageRoot, "plannotator-browser.ts"),
		importPlannotatorModule<AssistantMessageModule>(packageRoot, "assistant-message.ts"),
		importPlannotatorModule<ReviewArgsModule>(packageRoot, join("generated", "review-args.ts")),
		importPlannotatorModule<AnnotateArgsModule>(packageRoot, join("generated", "annotate-args.ts")),
		importPlannotatorModule<ConfigModule>(packageRoot, join("generated", "config.ts")),
		importPlannotatorModule<PromptsModule>(packageRoot, join("generated", "prompts.ts")),
	]);

	return {
		...browser,
		...assistantMessage,
		...reviewArgs,
		...annotateArgs,
		...config,
		...prompts,
	};
}

function formatError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function safeNotify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	try {
		ctx.ui.notify(message, type);
	} catch (err) {
		console.error(`Plannotator Lite notification failed: ${formatError(err)}`);
	}
}

function sessionOpenedMessage(label: string, url: string): string {
	return `${label}: ${url}. You can keep chatting while it runs.`;
}

function excerptText(text: string, maxChars = 1000): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) return trimmed;
	return `${trimmed.slice(0, maxChars).trimEnd()}...`;
}

function blockquote(text: string): string {
	return text
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
}

export function anchorMessageFeedback(feedback: string, originalMessage: string): string {
	return `This feedback applies to the earlier assistant response excerpted below:

${blockquote(excerptText(originalMessage))}

User feedback:
${feedback}`;
}

function shouldAnchorMessageFeedback(
	runtime: PlannotatorLiteRuntime,
	ctx: ExtensionContext,
	entryId: string,
): boolean {
	try {
		return runtime.hasSessionMovedPastEntry(ctx, entryId);
	} catch {
		return true;
	}
}

function reportBackgroundError(
	ctx: ExtensionContext,
	runtime: PlannotatorLiteRuntime,
	message: string,
	err: unknown,
): void {
	const detail = runtime.getStartupErrorMessage(err);
	console.error(`${message}: ${detail}`);
	safeNotify(ctx, `${message}: ${detail}`, "error");
}

export function createPlannotatorLiteExtension(
	options: { loadRuntime?: LoadPlannotatorLiteRuntime } = {},
): (pi: ExtensionAPI) => void {
	const loadRuntime = options.loadRuntime ?? (() => loadPlannotatorLiteRuntime());
	let runtimePromise: Promise<PlannotatorLiteRuntime> | null = null;

	async function getRuntime(ctx: ExtensionContext): Promise<PlannotatorLiteRuntime | null> {
		try {
			runtimePromise ??= loadRuntime();
			return await runtimePromise;
		} catch (err) {
			runtimePromise = null;
			const detail = formatError(err);
			safeNotify(
				ctx,
				`Plannotator Lite could not load @plannotator/pi-extension. Start Pi once so packages install, or run \`pi update --extensions\`. ${detail}`,
				"error",
			);
			return null;
		}
	}

	return function plannotatorLite(pi: ExtensionAPI): void {
		pi.registerCommand("plannotator-review", {
			description: "Open Plannotator code review for current changes or a PR URL; pass --git to force Git in JJ workspaces",
			handler: async (args, ctx) => {
				const runtime = await getRuntime(ctx);
				if (!runtime) return;

				if (!runtime.hasReviewBrowserHtml()) {
					safeNotify(ctx, "Code review UI not available. Reinstall or update @plannotator/pi-extension.", "error");
					return;
				}

				try {
					const reviewArgs = runtime.parseReviewArgs(args ?? "");
					const session = await runtime.startCodeReviewBrowserSession(ctx, {
						prUrl: reviewArgs.prUrl,
						vcsType: reviewArgs.vcsType,
						useLocal: reviewArgs.useLocal,
					});
					safeNotify(ctx, sessionOpenedMessage("Code review opened", session.url), "info");
					void session
						.waitForDecision()
						.then((result) => {
							try {
								if (result.exit) {
									safeNotify(ctx, "Code review session closed.", "info");
									return;
								}
								if (result.approved) {
									pi.sendUserMessage(runtime.getReviewApprovedPrompt("pi", runtime.loadConfig()), {
										deliverAs: "followUp",
									});
									return;
								}
								if (!result.feedback) {
									safeNotify(ctx, "Code review closed (no feedback).", "info");
									return;
								}

								const reviewFeedback = (result.annotations?.length ?? 0) > 0
									? `${result.feedback}${runtime.getReviewDeniedSuffix("pi", runtime.loadConfig())}`
									: result.feedback;

								pi.sendUserMessage(reviewFeedback, { deliverAs: "followUp" });
							} catch (err) {
								reportBackgroundError(ctx, runtime, "Plannotator Lite code review feedback could not be sent", err);
							}
						})
						.catch((err) => {
							reportBackgroundError(ctx, runtime, "Plannotator Lite code review session failed", err);
						});
				} catch (err) {
					safeNotify(ctx, `Failed to start code review UI: ${runtime.getStartupErrorMessage(err)}`, "error");
				}
			},
		});

		pi.registerCommand("plannotator-last", {
			description: "Annotate the last assistant message in Plannotator",
			handler: async (args, ctx) => {
				const runtime = await getRuntime(ctx);
				if (!runtime) return;

				const { gate } = runtime.parseAnnotateArgs(args ?? "");

				if (!runtime.hasPlanBrowserHtml()) {
					safeNotify(ctx, "Annotation UI not available. Reinstall or update @plannotator/pi-extension.", "error");
					return;
				}

				const snapshot = runtime.getLastAssistantMessageSnapshot(ctx);
				if (!snapshot) {
					safeNotify(ctx, "No assistant message found in session.", "error");
					return;
				}

				const recent = runtime.getRecentAssistantMessages(ctx, 25);
				const pickerMessages = recent.length > 1 ? recent : undefined;
				safeNotify(ctx, "Opening annotation UI for last message...", "info");

				try {
					const session = await runtime.startLastMessageAnnotationSession(ctx, snapshot.text, gate, pickerMessages);
					safeNotify(ctx, sessionOpenedMessage("Last-message annotation opened", session.url), "info");
					void session
						.waitForDecision()
						.then((result) => {
							try {
								if (result.exit) {
									safeNotify(ctx, "Annotation session closed.", "info");
									return;
								}
								if (result.approved) {
									safeNotify(ctx, "Message approved.", "info");
									return;
								}
								if (!result.feedback) {
									safeNotify(ctx, "Annotation closed (no feedback).", "info");
									return;
								}

								const target = result.selectedMessageId && result.selectedMessageId !== snapshot.entryId
									? runtime.findAssistantMessageByEntryId(ctx, result.selectedMessageId) ?? snapshot
									: snapshot;
								const feedback = result.feedbackScope !== "messages" && shouldAnchorMessageFeedback(runtime, ctx, target.entryId)
									? anchorMessageFeedback(result.feedback, target.text)
									: result.feedback;

								pi.sendUserMessage(
									runtime.getAnnotateMessageFeedbackPrompt("pi", runtime.loadConfig(), { feedback }),
									{ deliverAs: "followUp" },
								);
							} catch (err) {
								reportBackgroundError(ctx, runtime, "Plannotator Lite message annotation feedback could not be sent", err);
							}
						})
						.catch((err) => {
							reportBackgroundError(ctx, runtime, "Plannotator Lite message annotation session failed", err);
						});
				} catch (err) {
					safeNotify(ctx, `Failed to start annotation UI: ${runtime.getStartupErrorMessage(err)}`, "error");
				}
			},
		});
	};
}

export default createPlannotatorLiteExtension();
