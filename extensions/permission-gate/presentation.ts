import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { escalationNote, type Assessment } from "./policy.ts";

export const ASK_ALLOW = "Yes, allow once";
export const ASK_DENY = "No, block it";

const unique = <T>(values: T[]) => [...new Set(values)];
const formatList = (values: string[]) => values.map((value) => `- ${value}`).join("\n");

const assessmentSections = (assessment: Assessment) => ({
	descriptions: unique(assessment.matches.map((match) => `${match.id}: ${match.description}`)),
	guidance: unique(assessment.matches.map((match) => match.guidance)),
});

export const formatReason = (assessment: Assessment, hits = 0) => {
	const { descriptions, guidance } = assessmentSections(assessment);
	return [
		`Permission gate ${assessment.decision}:`,
		formatList(descriptions),
		"",
		"Guidance:",
		formatList(guidance),
		"",
		"Target:",
		assessment.target,
		escalationNote(hits),
	]
		.join("\n")
		.trimEnd();
};

export const formatAskPrompt = (assessment: Assessment, hits: number, language?: string) => {
	const theme = getMarkdownTheme();
	const { descriptions, guidance } = assessmentSections(assessment);
	const target = theme.highlightCode?.(assessment.target, language) ?? assessment.target.split("\n").map(theme.codeBlock);
	const escalation = escalationNote(hits).trim();

	return [
		theme.heading("REVIEW THIS"),
		...descriptions.map((description) => `${theme.listBullet("•")} ${theme.bold(description)}`),
		"",
		theme.heading("GUIDANCE"),
		...guidance.map((instruction) => `${theme.listBullet("•")} ${theme.quote(instruction)}`),
		"",
		theme.heading("FULL COMMAND"),
		...target,
		...(escalation ? ["", theme.quote(escalation)] : []),
	]
		.join("\n")
		.trimEnd();
};

// Pure classification of a finished yes/no ask, kept separate from the handler so
// the decline/timeout logic is testable. `choice` is what ctx.ui.select resolved to
// (ASK_ALLOW, ASK_DENY, or undefined for a dismissal / timeout / caught throw).
// `timedOut` is whether the dialog ran out its countdown rather than being answered.
//
// Both non-allow outcomes abort the turn — a decline is a decision the model must
// not route around, and a timeout means the user stepped away, so unattended work
// stops too. They differ only in wording: the model (and user) should be able to
// tell "you said no" from "nobody was there".
export function describeAskOutcome(choice: string | undefined, timedOut: boolean, askSecs: number) {
	if (choice !== ASK_DENY && timedOut) {
		return {
			kind: "timedOut" as const,
			notify: `Permission gate ask timed out after ${askSecs}s with no response; blocked the call and aborted the turn.`,
			reason:
				"Blocked by permission gate: the ask timed out after " +
				askSecs +
				"s with no response — the user is away, so the turn was aborted. Do not retry this call in another form; wait for the user to return and ask before attempting it again.",
		};
	}
	return {
		kind: "declined" as const,
		notify: "Permission gate ask declined by user; aborting turn.",
		reason: "Blocked by permission gate: the user declined (explicitly or by dismissing). Do not retry this in another form.",
	};
}
