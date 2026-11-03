import { strict as assert } from "node:assert";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const agentDir = join(homedir(), ".pi", "agent");

type Settings = {
	skills?: string[];
	packages?: Array<string | { source: string; skills?: string[] }>;
};

const gitCheckout = (source: string): string => {
	const url = new URL(source);
	const repositoryPath = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
	return join(agentDir, "git", url.hostname, ...repositoryPath);
};

const configuredSkillPaths = async (): Promise<string[]> => {
	const localSkills = await readdir(join(repoRoot, "skills"), { withFileTypes: true });
	const localPaths = localSkills
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(repoRoot, "skills", entry.name, "SKILL.md"));
	const settings = JSON.parse(await readFile(join(repoRoot, "settings.json"), "utf8")) as Settings;
	const topLevelPaths = (settings.skills ?? []).map((skill) => join(agentDir, skill, "SKILL.md"));
	const packagePaths = (settings.packages ?? []).flatMap((pkg) => {
		if (typeof pkg === "string") return [];
		return (pkg.skills ?? []).map((skill) => join(gitCheckout(pkg.source), skill, "SKILL.md"));
	});

	return [...localPaths, ...topLevelPaths, ...packagePaths];
};

const lineAt = (source: string, offset: number): number => source.slice(0, offset).split("\n").length;

void describe("skill independence", () => {
	void it("does not reference or invoke another skill", async () => {
		const skillPaths = await configuredSkillPaths();
		assert.ok(skillPaths.length > 0, "expected to find configured skills");
		const violations: string[] = [];

		for (const skillPath of skillPaths) {
			const source = await readFile(skillPath, "utf8");
			const displayPath = skillPath.startsWith(repoRoot)
				? relative(repoRoot, skillPath)
				: relative(agentDir, skillPath);

			for (const match of source.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) {
				const target = match[1]?.replace(/[?#].*$/, "");
				if (!target || !/(^|\/)SKILL\.md$/.test(target)) continue;
				if (resolve(dirname(skillPath), target) === skillPath) continue;
				violations.push(`${displayPath}:${lineAt(source, match.index)} links to ${target}`);
			}

			for (const match of source.matchAll(/(?:^|\s)\/skill:([a-z0-9][\w-]*)/gi)) {
				violations.push(`${displayPath}:${lineAt(source, match.index)} invokes ${match[0].trim()}`);
			}
		}

		assert.deepEqual(violations, [], "Skills must be self-contained and not depend on other skills");
	});
});
