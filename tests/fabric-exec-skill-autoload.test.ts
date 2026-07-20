import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createFabricExecSkillAutoload,
	FABRIC_CAPABILITY_CATALOG_MARKER,
	FABRIC_EXEC_SKILL_AUTOLOAD_MARKER,
} from "../extensions/fabric-exec-skill-autoload.ts";

function event(
	systemPrompt = "base system prompt",
	selectedTools = ["fabric_exec"],
) {
	return {
		systemPrompt,
		systemPromptOptions: {
			selectedTools,
			skills: [
				{
					name: "fabric-exec",
					filePath: "/opt/pi-fabric/skills/fabric-exec/SKILL.md",
				},
			],
		},
	};
}

void describe("fabric-exec skill autoload", () => {
	void it("loads the discovered canonical skill when fabric_exec is active", async () => {
		const reads: string[] = [];
		const handler = createFabricExecSkillAutoload(async (path) => {
			reads.push(path);
			return "---\nname: fabric-exec\n---\n\n# Fabric Exec";
		});

		const result = await handler(event());
		const systemPrompt = result?.systemPrompt ?? "";

		assert.deepStrictEqual(reads, [
			"/opt/pi-fabric/skills/fabric-exec/SKILL.md",
		]);
		assert.ok(systemPrompt.startsWith("base system prompt"));
		assert.ok(systemPrompt.includes(FABRIC_EXEC_SKILL_AUTOLOAD_MARKER));
		assert.ok(systemPrompt.includes("# Fabric Exec"));
		assert.ok(systemPrompt.includes("/opt/pi-fabric/skills/fabric-exec"));
		assert.ok(systemPrompt.includes("without spending a tool call"));
	});

	void it("adds captured extension names and compact schemas to the prompt", async () => {
		const handler = createFabricExecSkillAutoload(
			async () => "skill",
			() => [
				{
					name: "web_search",
					description: "Search the web.",
					parameters: {
						type: "object",
						properties: {
							query: { type: "string", description: "Search query" },
							numResults: { type: "number" },
						},
						required: ["query"],
					},
					sourceInfo: { path: "web-tools", source: "npm:pi-web-tools", scope: "user", origin: "package" },
				},
				{
					name: "read",
					description: "Built-in read.",
					parameters: { type: "object" },
					sourceInfo: { path: "<builtin:read>", source: "builtin", scope: "user", origin: "top-level" },
				},
				{
					name: "fabric_exec",
					description: "Fabric.",
					parameters: { type: "object" },
					sourceInfo: { path: "fabric", source: "npm:pi-fabric", scope: "user", origin: "package" },
				},
			],
		);

		const result = await handler(event());
		const systemPrompt = result?.systemPrompt ?? "";

		assert.ok(systemPrompt.includes(FABRIC_CAPABILITY_CATALOG_MARKER));
		assert.ok(systemPrompt.includes("extensions.web_search"));
		assert.ok(systemPrompt.includes("query!: string"));
		assert.ok(systemPrompt.includes("numResults?: number"));
		assert.ok(!systemPrompt.includes("Built-in read."));
		assert.ok(!systemPrompt.includes("Fabric."));
	});

	void it("does not load the skill when fabric_exec is inactive", async () => {
		let read = false;
		const handler = createFabricExecSkillAutoload(async () => {
			read = true;
			return "skill";
		});

		assert.strictEqual(await handler(event("base", ["read", "bash"])), undefined);
		assert.strictEqual(read, false);
	});

	void it("does not append the skill twice to an already enriched prompt", async () => {
		let readCount = 0;
		const handler = createFabricExecSkillAutoload(async () => {
			readCount += 1;
			return "skill";
		});
		const first = await handler(event());
		const second = await handler(event(first?.systemPrompt));

		assert.ok(first?.systemPrompt.includes(FABRIC_EXEC_SKILL_AUTOLOAD_MARKER));
		assert.strictEqual(second, undefined);
		assert.strictEqual(readCount, 1);
	});
});
