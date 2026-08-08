/**
 * Preload a compact fabric_exec call reference for selected models.
 *
 * Cache behavior: the injected text is static and model matching is
 * deterministic. For a fixed model and extension version, this extension adds
 * the same bytes on every turn; it introduces no turn-specific prompt data.
 *
 * Reference provenance (verified 2026-08-08):
 * - pi-fabric 0.40.3, skills/fabric-exec/SKILL.md: pi.* forms, return shapes,
 *   bash settlement, aliases, edit behavior, and executor semantics.
 * - Pi 0.84.1 read behavior: unbounded reads stop at 2,000 lines or 50KB.
 * - Using canonical field names is an editorial recommendation, not a runtime
 *   requirement; pi-fabric accepts the documented aliases.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ModelIdentity {
	provider: string;
	id: string;
	name?: string;
}

// A model matches when its provider, id, and display name collectively contain
// every word from at least one group. Matching is case-insensitive.
const TARGET_MODEL_WORD_GROUPS: readonly (readonly string[])[] = [["deepseek", "flash"]];

export const DISTILLED_BLOCK = `

# fabric_exec routine-call reference (preloaded)

Use this reference for routine calls. Load the full fabric-exec skill only for
advanced APIs or a contract error not covered here.

Put one type-checked TypeScript program in \`fabric_exec.code\`. Top-level
\`await\` and \`return\` work. Only the returned value enters model context;
\`print()\` and \`console.log()\` go to the activity panel. For awkward payloads,
pass top-level \`strings\` and read them in code as \`π.<key>\`.

## Canonical pi.* calls and returns
- Read: \`pi.read("file")\` or \`pi.read({ path: "file", offset: 1, limit: 120 })\`
  returns a string.
- Shell: \`pi.bash({ command: "git status", settle: true })\` returns
  \`{ ok, output, details }\`; with \`settle: true\`, failure also includes
  \`exitCode\` and \`error\` instead of rejecting.
- Search: \`pi.grep({ pattern: "TODO", path: "src", limit: 20 })\` returns a string.
- Find: \`pi.find({ pattern: "*.ts", path: "src", limit: 20 })\` returns a string.
- List: \`pi.ls("src")\` returns a string.
- Edit: \`pi.edit({ path, oldText, newText })\` or
  \`pi.edit({ path, edits: [{ oldText, newText }] })\` returns
  \`{ ok, output, details }\`.
- Write: \`pi.write({ path, content })\` returns \`{ ok, output, details }\`.

## Important semantics
- Without \`settle: true\`, \`pi.bash\` rejects on a nonzero exit. Do not use
  \`settle\` for timeout, cancellation, approval, security, or spawn failures;
  those still reject.
- Read \`.output\` from successful bash/edit/write results when that is all the
  final answer needs.
- Unbounded \`pi.read\` stops at 2,000 lines or 50KB. Use \`offset\` and \`limit\`.
- Aliases such as \`cmd\`, \`query\`, and \`file_path\` are accepted. Prefer the
  canonical fields above for consistency.
- For \`pi.edit\`, omit \`all\` for a unique anchor. Entry-level \`all: true\`
  intentionally replaces every non-overlapping occurrence.
- Batch independent calls with \`Promise.all\`; keep dependent calls sequential.
- Describe unknown provider actions before calling them; do not guess schemas.

## Canonical batch
\`\`\`ts
const [pkg, hits] = await Promise.all([
  pi.read("package.json"),
  pi.grep({ pattern: "TODO", path: "src", limit: 20 }),
]);
const status = await pi.bash({ command: "git status --short", settle: true });
return { pkg, hits, status: status.output };
\`\`\`
`;

const BLOCK_MARKER = "# fabric_exec routine-call reference (preloaded)";

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
		if (!isTargetModel(ctx.model)) return;
		if (event.systemPrompt.includes(BLOCK_MARKER)) return;
		return { systemPrompt: `${event.systemPrompt}${DISTILLED_BLOCK}` };
	});
}
