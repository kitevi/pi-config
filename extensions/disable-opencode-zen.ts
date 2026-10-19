/**
 * Disable OpenCode Zen
 *
 * `OPENCODE_API_KEY` authenticates both the built-in `opencode` (OpenCode Zen)
 * and `opencode-go` providers, and pi has no setting that disables a provider.
 * Re-registering `opencode` with an empty model list replaces its built-in
 * models, so `/model` and `pi --list-models` stop offering it while
 * `opencode-go` keeps the key.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerProvider("opencode", { models: [] });
}
