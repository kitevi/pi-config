/**
 * Model-facing guidance for DeepSeek V4 Pro in Pi Fabric.
 *
 * Mirror of `deepseek-flash-guidance.ts` with one deliberate difference:
 * Pro gets choice discipline, not argument-shape coaching. A stronger model
 * reads tool schemas fine; what it has actually gotten wrong is reaching for
 * curl/search-engine scraping while the allowlisted MCP tools were available.
 * Keeping this a separate component lets Pro coverage be enabled or disabled
 * independently of the Flash guidance.
 *
 * Runtime contract
 * - Registers `deepseek-pro-guidance`; its configured instance lives in
 *   `../fabric.json`.
 * - Pi Fabric evaluates `models` on every turn against the canonical
 *   `${provider}/${modelId}` key. The selectors below cover V4 Pro variants
 *   across providers and deliberately exclude Flash.
 * - Both entries target `main` and `participant`. Guidance changes prompt
 *   text only; it cannot grant tools, providers, or capabilities.
 * - Keep content deterministic. Timestamps, run IDs, or turn-derived data
 *   change the system-prompt prefix and defeat provider prompt caching.
 *
 * Supported changes
 * - Add guide entries with stable unique labels, model selectors, targets, and
 *   deterministic content.
 * - Narrow or widen selectors; target `main`, `participant`, or both.
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
// providers; the capitalized form covers NeuralWatt. Requiring Pro excludes
// every current V4 Flash key.
const DEEPSEEK_V4_PRO_MODELS = [
  "*/*deepseek*v4*pro*",
  "*/*DeepSeek*V4*Pro*",
] as const;

const component: FabricComponentDefinition = {
  name: "deepseek-pro-guidance",
  description: "Model-facing execution guidance for DeepSeek V4 Pro",
  // The current provider graph fails the stronger `revertible` independence
  // check against MCP's wildcard effect. `managed` still gives the supervisor
  // ownership of unloading and cleanup.
  guarantee: "managed",
  activate(context) {
    context.guide({
      label: "deepseek-pro-tool-discovery",
      models: DEEPSEEK_V4_PRO_MODELS,
      targets: ["main", "participant"],
      placement: "append",
      content: `# Tool discovery and web/docs lookups (inside fabric_exec)
- Web search, page fetching, and docs lookups go through the allowlisted MCP tools, not curl/wget. Shell HTTP is fallback only, and only when you state why.
- \`mcp.exa.web_search_exa({query, numResults?})\` — web search. Returns a \`{text: string}\` blob; read \`.text\`, never \`.results\`.
- \`mcp.exa.web_fetch_exa({urls: string[], maxCharacters?})\` — fetch pages as markdown. \`urls\` is an array, never \`{url}\`.
- \`mcp.context7['resolve-library-id']({libraryName, query})\` then \`mcp.context7['query-docs']({libraryId, query})\` — library/API docs before general web search.
- Before concluding a tool is unavailable, check the registry: \`await tools.list()\` to see what exists, \`await tools.describe({ref})\` for a contract. Match \`inputSchema\` exactly; after an "Invalid arguments" error, describe again instead of re-guessing.`,
    });

    context.guide({
      label: "deepseek-pro-fabric-exec-edges",
      models: DEEPSEEK_V4_PRO_MODELS,
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
