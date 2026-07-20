/**
 * Put the canonical fabric-exec skill and a compact captured-tool catalog in the
 * system prompt whenever the fabric_exec tool is active. This removes the
 * model-dependent on-demand discovery step for smaller models.
 */
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FABRIC_EXEC_SKILL_NAME = "fabric-exec";
export const FABRIC_EXEC_SKILL_AUTOLOAD_MARKER =
	"<!-- pi-config:fabric-exec-skill-autoload -->";
export const FABRIC_CAPABILITY_CATALOG_MARKER =
	"<!-- pi-config:fabric-capability-catalog -->";

const CATALOG_LIMIT = 64;
const WEB_TOOL_NAMES = new Set([
	"web_search",
	"fetch_content",
	"code_search",
	"get_search_content",
]);

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
type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];
type ToolReader = () => ToolInfo[];

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as JsonObject;
}

function compactText(value: unknown, maxLength: number): string {
	if (typeof value !== "string") return "";
	const text = value.replace(/\s+/g, " ").trim();
	return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function schemaType(value: unknown): string {
	const schema = asObject(value);
	if (!schema) return "unknown";
	if (schema.type === "array") {
		return `${schemaType(schema.items)}[]`;
	}
	if (typeof schema.type === "string") return schema.type;
	if (Array.isArray(schema.enum)) return schema.enum.map(String).join("|");
	if (Array.isArray(schema.anyOf)) {
		return schema.anyOf.map(schemaType).join("|");
	}
	return "unknown";
}

function parameterSummary(parameters: unknown): string {
	const schema = asObject(parameters);
	const properties = asObject(schema?.properties);
	if (!properties) return "";

	const required = new Set(
		Array.isArray(schema?.required)
			? schema.required.filter((value): value is string => typeof value === "string")
			: [],
	);
	const entries = Object.entries(properties).slice(0, 24).map(([name, value]) => {
		const property = asObject(value);
		const description = compactText(property?.description, 72);
		const suffix = description ? ` — ${description}` : "";
		return `${name}${required.has(name) ? "!" : "?"}: ${schemaType(value)}${suffix}`;
	});
	return entries.join("; ");
}

function toolReference(name: string): string {
	if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
		return `\`extensions.${name}\``;
	}
	return `\`tools.call({ ref: "extensions.${name}", args })\``;
}

export function appendFabricCapabilityCatalog(
	systemPrompt: string,
	tools: ToolInfo[],
): string {
	if (systemPrompt.includes(FABRIC_CAPABILITY_CATALOG_MARKER)) return systemPrompt;

	const capturedTools = tools
		.filter((tool) => tool.name !== "fabric_exec" && tool.sourceInfo.source !== "builtin")
		.sort((left, right) => {
			const webPriority = Number(WEB_TOOL_NAMES.has(right.name)) - Number(WEB_TOOL_NAMES.has(left.name));
			return webPriority || left.name.localeCompare(right.name);
		})
		.slice(0, CATALOG_LIMIT);
	if (capturedTools.length === 0) return systemPrompt;

	const lines = capturedTools.map((tool) => {
		const description = compactText(tool.description, 180) || "No description provided.";
		const parameters = parameterSummary(tool.parameters);
		return `- ${toolReference(tool.name)} — ${description}${parameters ? `\n  Args: ${parameters}` : ""}`;
	});
	const omitted = tools.filter(
		(tool) => tool.name !== "fabric_exec" && tool.sourceInfo.source !== "builtin",
	).length - capturedTools.length;

	return `${systemPrompt}

${FABRIC_CAPABILITY_CATALOG_MARKER}
## Captured extension tools available inside fabric_exec

Full code mode exposes only fabric_exec to the model. The following registered extension tools are callable from its TypeScript runtime. Use a known proxy directly with await; do not call a bare top-level tool name. Use tools.describe({ ref: "extensions.<name>" }) only when a tool is not listed here.

${lines.join("\n")}${omitted > 0 ? `\n- … ${omitted} additional captured tools omitted from this compact catalog` : ""}`;
}

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
	getAllTools: ToolReader = () => [],
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
			const systemPrompt = appendFabricExecSkill(
				event.systemPrompt,
				skill.filePath,
				skillContent,
			);
			return {
				systemPrompt: appendFabricCapabilityCatalog(systemPrompt, getAllTools()),
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
	pi.on(
		"before_agent_start",
		createFabricExecSkillAutoload(undefined, () => pi.getAllTools()),
	);
}
