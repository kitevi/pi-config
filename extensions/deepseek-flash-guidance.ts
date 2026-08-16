/**
 * Model-facing guidance for DeepSeek V4 Flash in Pi Fabric.
 *
 * Runtime contract
 * - Registers `deepseek-flash-guidance`; its configured instance lives in
 *   `../fabric.json`.
 * - Pi Fabric evaluates `models` on every turn against the canonical
 *   `${provider}/${modelId}` key. Current selectors cover Flash variants
 *   across providers and deliberately exclude V4 Pro.
 * - Both entries target `main` and `participant`. Guidance changes prompt
 *   text only; it cannot grant tools, providers, or capabilities.
 * - Keep content deterministic. Timestamps, run IDs, or turn-derived data
 *   change the system-prompt prefix and defeat provider prompt caching.
 *
 * Read before changing behavior
 * - `../../pi-fabric/docs/components.md`, "Model-facing guidance components":
 *   public guide API, targets, placements, propagation, limits, lifecycle, and
 *   cache behavior.
 * - `../../pi-fabric/src/components/model-guidance.ts`: exact normalization,
 *   case-sensitive glob matching, ordering, conflict handling, and limits.
 * - `../../pi-fabric/tests/model-guidance.test.ts`: focused behavior examples.
 * - `../../pi-fabric/src/core/system-guidance.ts`: Fabric's default execution
 *   profile, relevant before replacing a guidance slot.
 * - `../fabric.json`: configured component instance. `../bootstrap.mjs`:
 *   installation into `~/.pi/agent`. Installed protocol declarations live at
 *   `~/.pi/agent/npm/node_modules/pi-fabric/dist/protocol.d.ts`.
 *
 * Supported changes
 * - Add guide entries with stable unique labels, model selectors, targets, and
 *   deterministic content.
 * - Narrow or widen selectors; target `main`, `participant`, or both.
 * - Current entries use `placement: "append"`. A component can instead use
 *   `placement: "replace"` with a named `slot`; Fabric's execution-profile
 *   slot is `FABRIC_EXECUTION_GUIDANCE_SLOT`. Read the component docs before
 *   introducing a slot replacement.
 * - Keep both registration paths at the bottom: they make extension loading
 *   independent of whether Pi Fabric or this file loads first.
 *
 * Verification
 * - Run the repo tests and type-check this file.
 * - Run `npm run setup` when the filename or `fabric.json` changes.
 * - Restart Pi (or reload extensions), then confirm `/fabric status`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Compile-time only: use the installed protocol declarations without adding a
// second pi-fabric dependency to this repo. From the canonical checkout path,
// ../../../ reaches $HOME. Adjust this import if the checkout moves.
import type {
  FabricComponentDefinition,
  FabricComponentDiscovery,
} from "../../../.pi/agent/npm/node_modules/pi-fabric/dist/protocol.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Load the protocol from Pi's installed package rather than relying on bare
// package resolution. The first candidate supports the canonical checkout and
// installed symlink; the HOME fallback keeps runtime loading valid after a move.
const PROTOCOL_MODULE = (() => {
  const candidates = [
    new URL("../../../.pi/agent/npm/node_modules/pi-fabric/dist/protocol.js", import.meta.url),
    pathToFileURL(join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-fabric", "dist", "protocol.js")),
  ];
  for (const candidate of candidates) {
    if (existsSync(fileURLToPath(candidate))) return candidate.href;
  }
  throw new Error(
    "pi-fabric protocol module not found. Tried: " +
      candidates.map((candidate) => fileURLToPath(candidate)).join(", "),
  );
})();

// Full-string globs are case-sensitive. The lowercase form covers most
// providers; the capitalized form covers NeuralWatt. Requiring Flash excludes
// every current V4 Pro key.
const DEEPSEEK_V4_FLASH_MODELS = [
  "*/*deepseek*v4*flash*",
  "*/*DeepSeek*V4*Flash*",
] as const;

const component: FabricComponentDefinition = {
  name: "deepseek-flash-guidance",
  description: "Model-facing execution guidance for DeepSeek V4 Flash",
  // The current provider graph fails the stronger `revertible` independence
  // check against MCP's wildcard effect. `managed` still gives the supervisor
  // ownership of unloading and cleanup.
  guarantee: "managed",
  activate(context) {
    context.guide({
      label: "deepseek-flash-mcp-web-docs",
      models: DEEPSEEK_V4_FLASH_MODELS,
      targets: ["main", "participant"],
      placement: "append",
      content: `# Web and documentation tools (MCP, inside fabric_exec)
- Use these MCP tools for web/docs lookups — not curl/wget (shell HTTP is fallback only; say why):
- \`mcp.exa.web_search_exa({query, numResults?})\` — web search. Returns \`{text: string}\` (a pre-rendered "Title / URL / Published / Highlights" blob, not a results array). Read \`.text\`; never \`.results\`.
- \`mcp.exa.web_fetch_exa({urls: string[], maxCharacters?})\` — fetch pages; \`urls\` is an array, never \`{url}\`. Returns \`{text: string}\` (concatenated markdown of every page); read \`.text\`.
- MCP output shapes are tool-specific. Use a documented shape when one is given; otherwise return \`JSON.stringify(res).slice(0, 1500)\` once before extracting fields. SDK/REST client examples do not define an MCP tool's response.
- Probe once, then extract: after inspecting a response, use the observed fields on the next call and retain that shape for later calls to the same tool. A shape-related failure permits one inspection retry, not another guessed access.
- \`mcp.context7['resolve-library-id']({libraryName, query})\` then \`mcp.context7['query-docs']({libraryId: '/org/project[/version]', query})\` — library/API docs before web search; one topic per query; hyphenated names need bracket access (or \`tools.call({ref, args})\`).
- Any other \`mcp.*\` tool: \`await tools.describe({ref})\` first, match \`inputSchema\` exactly (extra/missing props get rejected). After "Invalid arguments": describe and fix — never re-guess.`,
    });

    context.guide({
      label: "deepseek-flash-fabric-exec-edges",
      models: DEEPSEEK_V4_FLASH_MODELS,
      targets: ["main", "participant"],
      placement: "append",
      content: `# fabric_exec edge semantics
- \`print()\` and \`console.log()\` write to the activity panel rather than the model-visible tool result.
- Prefer canonical argument fields (\`command\`, \`pattern\`, \`path\`, \`oldText\`, \`newText\`, \`content\`) even though aliases are accepted.`,
    });
  },
};

export default async function extension(pi: ExtensionAPI) {
  const {
    FABRIC_COMPONENT_DISCOVER_EVENT,
    FABRIC_COMPONENT_REGISTER_EVENT,
  } = await import(PROTOCOL_MODULE);

  // Emit for an already-loaded Fabric runtime; listen for discovery when Fabric
  // loads later. Both paths are required for order-independent registration.
  pi.events.emit(FABRIC_COMPONENT_REGISTER_EVENT, {
    version: 1,
    component,
    overwrite: true,
  });
  pi.events.on(FABRIC_COMPONENT_DISCOVER_EVENT, (discovery) => {
    (discovery as FabricComponentDiscovery).register(component, { overwrite: true });
  });
}
