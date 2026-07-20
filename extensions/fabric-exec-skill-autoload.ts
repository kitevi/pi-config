/**
 * Put the canonical fabric-exec skill in the system prompt whenever the
 * fabric_exec tool is active. This removes the model-dependent on-demand
 * discovery step for smaller models.
 */
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FABRIC_EXEC_SKILL_NAME = "fabric-exec";
export const FABRIC_EXEC_SKILL_AUTOLOAD_MARKER =
	"<!-- pi-config:fabric-exec-skill-autoload -->";

type SkillMetadata = {
	name: string;
	filePath: string;
};

type AutoloadEvent = {
	systemPrompt: string;
	systemPromptOptions: {
		selectedTools?: string[];
		skills?: SkillMetadata[];
	};
};

type SkillReader = (path: string) => Promise<string>;

export function appendFabricExecSkill(
	systemPrompt: string,
	skillPath: string,
	skillContent: string,
): string {
	if (systemPrompt.includes(FABRIC_EXEC_SKILL_AUTOLOAD_MARKER)) return systemPrompt;

	return `${systemPrompt}\n\n${FABRIC_EXEC_SKILL_AUTOLOAD_MARKER}\n## Always-loaded skill: fabric-exec\n\nThe canonical fabric-exec skill is already loaded below. Follow it without spending a tool call to read SKILL.md again. Resolve its relative references against \`${dirname(skillPath)}\`.\n\n<fabric-exec-skill>\n${skillContent.trim()}\n</fabric-exec-skill>`;
}

export function createFabricExecSkillAutoload(
	readSkill: SkillReader = (path) => readFile(path, "utf8"),
) {
	return async (event: AutoloadEvent) => {
		if (!event.systemPromptOptions.selectedTools?.includes("fabric_exec")) {
			return undefined;
		}
		if (event.systemPrompt.includes(FABRIC_EXEC_SKILL_AUTOLOAD_MARKER)) {
			return undefined;
		}

		const skill = event.systemPromptOptions.skills?.find(
			(candidate) => candidate.name === FABRIC_EXEC_SKILL_NAME,
		);
		if (!skill) return undefined;

		try {
			const skillContent = await readSkill(skill.filePath);
			return {
				systemPrompt: appendFabricExecSkill(
					event.systemPrompt,
					skill.filePath,
					skillContent,
				),
			};
		} catch (error) {
			console.error(
				`Could not auto-load the fabric-exec skill from ${skill.filePath}:`,
				error instanceof Error ? error.message : String(error),
			);
			return undefined;
		}
	};
}

export default function fabricExecSkillAutoloadExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", createFabricExecSkillAutoload());
}
