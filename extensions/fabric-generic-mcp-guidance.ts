/**
 * Concise MCP discovery guidance for Kimi, GPT, GLM, and MiniMax models.
 *
 * Runtime contract
 * - Registers `generic-mcp-guidance`; its configured instance lives in
 *   `../fabric.json`.
 * - Pi Fabric evaluates `models` on every turn against the canonical
 *   `${provider}/${modelId}` key. Selectors are case-sensitive and cover the
 *   four target families across providers.
 * - The guide targets `main` and `participant`. Guidance changes prompt text
 *   only; it cannot grant tools, providers, or capabilities.
 * - Keep content deterministic to preserve provider prompt caching.
 *
 * Verification
 * - Run the repo tests and type-check this file.
 * - Run `npm run setup` when the filename or `fabric.json` changes.
 * - Restart Pi (or reload extensions), then confirm `/fabric status`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  FabricComponentDefinition,
  FabricComponentDiscovery,
} from "../../../.pi/agent/npm/node_modules/pi-fabric/dist/protocol.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

// Full-string globs are case-sensitive. Include casing used by current direct,
// aggregator, and Synthetic model IDs. MiniMax IDs use the canonical `minimax`
// spelling.
export const GENERIC_MCP_MODELS = [
  "*/*kimi*",
  "*/*Kimi*",
  "*/*gpt*",
  "*/*GPT*",
  "*/*glm*",
  "*/*GLM*",
  "*/*minimax*",
  "*/*MiniMax*",
] as const;

export const GENERIC_MCP_GUIDANCE = `# MCP tool discovery
- Prefer an available \`mcp.*\` tool over recreating the same capability with shell commands or direct HTTP.
- When the right tool is unclear, search with \`await tools.list({ provider: "mcp", query: "<capability>", limit: 20 })\`; inspect uncertain contracts with \`await tools.describe({ ref })\` and follow \`inputSchema\`.
- Fall back only when no suitable MCP tool is available or it fails, and briefly state why.`;

const component: FabricComponentDefinition = {
  name: "generic-mcp-guidance",
  description: "Concise MCP discovery guidance for Kimi, GPT, GLM, and MiniMax models",
  guarantee: "managed",
  activate(context) {
    context.guide({
      label: "generic-mcp-discovery",
      models: GENERIC_MCP_MODELS,
      targets: ["main", "participant"],
      placement: "append",
      content: GENERIC_MCP_GUIDANCE,
    });
  },
};

export default async function extension(pi: ExtensionAPI) {
  const {
    FABRIC_COMPONENT_DISCOVER_EVENT,
    FABRIC_COMPONENT_REGISTER_EVENT,
  } = await import(PROTOCOL_MODULE);

  pi.events.emit(FABRIC_COMPONENT_REGISTER_EVENT, {
    version: 1,
    component,
    overwrite: true,
  });
  pi.events.on(FABRIC_COMPONENT_DISCOVER_EVENT, (discovery) => {
    (discovery as FabricComponentDiscovery).register(component, { overwrite: true });
  });
}
