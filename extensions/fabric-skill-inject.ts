/**
 * Preload a compact fabric_exec reliability supplement for DeepSeek Flash models.
 *
 * Cache behavior: the injected text is static and model matching is
 * deterministic. For a fixed model and extension version, this extension adds
 * the same bytes on every matching agent start; it introduces no request-specific
 * prompt data.
 *
 * Duplication boundary (verified 2026-08-08): pi-fabric 0.40.3 automatically
 * injects tool availability, representative forms and returns, bash settlement,
 * provider namespaces, and named-string access. This supplement keeps canonical
 * field variants plus executor, read, edit, and batching semantics that are
 * absent from or only implicit in that ambient block.
 *
 * Reference provenance:
 * - pi-fabric 0.40.3, skills/fabric-exec/SKILL.md.
 * - Pi 0.84.1 read behavior: unbounded reads stop at 2,000 lines or 50KB.
 * - Canonical field names are an editorial recommendation, not a runtime
 *   requirement; pi-fabric accepts the documented aliases.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ModelIdentity {
	provider: string;
	id: string;
	name?: string;
}

// Match any DeepSeek Flash model when the words appear across its provider, id,
// or display name. Matching is case-insensitive.
const TARGET_MODEL_WORD_GROUPS: readonly (readonly string[])[] = [["deepseek", "flash"]];

export const DISTILLED_BLOCK = `

# fabric_exec reliability supplement (preloaded)

Pi Fabric already supplies routine full-code guidance automatically. This
supplement preloads canonical forms and edge semantics because these models may
not reliably load the fabric-exec skill. Load the full skill only for advanced
APIs or a contract error not covered here.

Put one type-checked TypeScript program in \`fabric_exec.code\`. Top-level
\`await\` and \`return\` work. Only the returned value enters model context;
\`print()\` and \`console.log()\` go to the activity panel. For awkward payloads,
pass top-level \`strings\` and read them in code as \`π.<key>\`.

## Prefer canonical pi.* forms
- String results: \`pi.read({ path, offset, limit })\`,
  \`pi.grep({ pattern, path, limit })\`, \`pi.find({ pattern, path, limit })\`, and
  \`pi.ls({ path, limit })\`.
- Envelope results: \`pi.bash({ command, timeout, settle })\`,
  \`pi.edit({ path, oldText, newText })\` or
  \`pi.edit({ path, edits: [{ oldText, newText }] })\`, and
  \`pi.write({ path, content })\`. Read their \`.output\` when only output text is
  needed.

## Additional semantics
- Unbounded \`pi.read\` stops at 2,000 lines or 50KB. Use \`offset\` and \`limit\`.
- Aliases such as \`cmd\`, \`query\`, and \`file_path\` are accepted, but prefer
  canonical fields for consistency.
- For \`pi.edit\`, omit \`all\` for a unique anchor. Entry-level \`all: true\`
  intentionally replaces every non-overlapping occurrence.
- Batch independent calls with \`Promise.all\`; keep dependent calls sequential.

## Canonical batch
\`\`\`ts
const [pkg, hits] = await Promise.all([
  pi.read("package.json"),
  pi.grep({ pattern: "TODO", path: "src", limit: 20 }),
]);
return { pkg, hits };
\`\`\`
`;

const BLOCK_MARKER = "# fabric_exec reliability supplement (preloaded)";

export function isTargetModel(model: ModelIdentity | undefined): boolean {
	if (!model) return false;
	const searchable = `${model.provider}/${model.id}/${model.name ?? ""}`.toLowerCase();
	return TARGET_MODEL_WORD_GROUPS.some(
		(group) =>
			group.length > 0 &&
			group.every((word) => {
				const normalizedWord = word.trim().toLowerCase();
				return normalizedWord.length > 0 && searchable.includes(normalizedWord);
			}),
	);
}

export default function fabricSkillInject(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
		if (!pi.getActiveTools().includes("fabric_exec")) return;
		if (!isTargetModel(ctx.model)) return;
		if (event.systemPrompt.includes(BLOCK_MARKER)) return;
		return { systemPrompt: `${event.systemPrompt}${DISTILLED_BLOCK}` };
	});
}
