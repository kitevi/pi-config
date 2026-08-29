/**
 * Claude Code-style spinner for pi.
 *
 * Behaviors modeled after Claude Code :
 * - Verb is picked once per turn and stays fixed (186 verbs from constants/spinnerVerbs.ts)
 * - Spinner glyphs vary by TERM and platform (components/Spinner/utils.ts):
 *     Ghostty: ['·','✢','✳','✶','✻','*']
 *     macOS:   ['·','✢','✳','✶','✻','✽']
 *     other:   ['·','✢','*','✶','✻','✽']
 * - Live message verb text always includes trailing ellipsis (effectiveVerb + '…')
 * - Status parts render left-to-right inside parens: [timer, tokens, thinking]
 * - Arrow prefix: ↑ for requesting, ↓ for everything else (in status parts, not glyph)
 * - Spinner glyph frame is continuous across mode changes (no setWorkingIndicator on mode flip)
 * - Shimmer sweep across verb text (50ms requesting / 200ms working tick)
 * - Stall detection: verb begins transitioning to red at 3s of no tokens, full red at 5s
 *   (50ms clock, intensity ramp + 0.1 smoothing per tick, mirror of useStalledAnimation.ts)
 * - Tool-use flash: entire verb oscillates between base and shimmer colors
 *
 * Derived from npm:@ladbabynpm/picc-working-spinner@0.1.3.
 * Local changes:
 * - Omit the agent_end completion notification so it cannot overwrite pi-tps.
 * - Drop the "· thinking" / "thought for Ns" status part (and its effort
 *   suffix), deleting the thinking-display state machine entirely.
 *
 * MIT License
 *
 * Copyright (c) 2026 Ladbaby
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─── Types ────────────────────────────────────────────────────────

type SpinnerMode = "requesting" | "thinking" | "responding" | "tool-input" | "tool-use";

// ─── Verbs (verbatim from claude-code constants/spinnerVerbs.ts) ──
const VERBS = [
  'Accomplishing', 'Actioning', 'Actualizing', 'Architecting', 'Baking',
  'Beaming', "Beboppin'", 'Befuddling', 'Billowing', 'Blanching',
  'Bloviating', 'Boogieing', 'Boondoggling', 'Booping', 'Bootstrapping',
  'Brewing', 'Bunning', 'Burrowing', 'Calculating', 'Canoodling',
  'Caramelizing', 'Cascading', 'Catapulting', 'Cerebrating', 'Channeling',
  'Channelling', 'Choreographing', 'Churning', 'Clauding', 'Coalescing',
  'Cogitating', 'Combobulating', 'Composing', 'Computing', 'Concocting',
  'Considering', 'Contemplating', 'Cooking', 'Crafting', 'Creating',
  'Crunching', 'Crystallizing', 'Cultivating', 'Deciphering', 'Deliberating',
  'Determining', 'Dilly-dallying', 'Discombobulating', 'Doing', 'Doodling',
  'Drizzling', 'Ebbing', 'Effecting', 'Elucidating', 'Embellishing',
  'Enchanting', 'Envisioning', 'Evaporating', 'Fermenting', 'Fiddle-faddling',
  'Finagling', 'Flambéing', 'Flibbertigibbeting', 'Flowing', 'Flummoxing',
  'Fluttering', 'Forging', 'Forming', 'Frolicking', 'Frosting',
  'Gallivanting', 'Galloping', 'Garnishing', 'Generating', 'Gesticulating',
  'Germinating', 'Gitifying', 'Grooving', 'Gusting', 'Harmonizing',
  'Hashing', 'Hatching', 'Herding', 'Honking', 'Hullaballooing',
  'Hyperspacing', 'Ideating', 'Imagining', 'Improvising', 'Incubating',
  'Inferring', 'Infusing', 'Ionizing', 'Jitterbugging', 'Julienning',
  'Kneading', 'Leavening', 'Levitating', 'Lollygagging', 'Manifesting',
  'Marinating', 'Meandering', 'Metamorphosing', 'Misting', 'Moonwalking',
  'Moseying', 'Mulling', 'Mustering', 'Musing', 'Nebulizing',
  'Nesting', 'Newspapering', 'Noodling', 'Nucleating', 'Orbiting',
  'Orchestrating', 'Osmosing', 'Perambulating', 'Percolating', 'Perusing',
  'Philosophising', 'Photosynthesizing', 'Pollinating', 'Pondering', 'Pontificating',
  'Pouncing', 'Precipitating', 'Prestidigitating', 'Processing', 'Proofing',
  'Propagating', 'Puttering', 'Puzzling', 'Quantumizing', 'Razzle-dazzling',
  'Razzmatazzing', 'Recombobulating', 'Reticulating', 'Roosting', 'Ruminating',
  'Sautéing', 'Scampering', 'Schlepping', 'Scurrying', 'Seasoning',
  'Shenaniganing', 'Shimmying', 'Simmering', 'Skedaddling', 'Sketching',
  'Slithering', 'Smooshing', 'Sock-hopping', 'Spelunking', 'Spinning',
  'Sprouting', 'Stewing', 'Sublimating', 'Swirling', 'Swooping',
  'Symbioting', 'Synthesizing', 'Tempering', 'Thinking', 'Thundering',
  'Tinkering', 'Tomfoolering', 'Topsy-turvying', 'Transfiguring', 'Transmuting',
  'Twisting', 'Undulating', 'Unfurling', 'Unravelling', 'Vibing',
  'Waddling', 'Wandering', 'Warping', 'Whatchamacalliting', 'Whirlpooling',
  'Whirring', 'Whisking', 'Wibbling', 'Working', 'Wrangling',
  'Zesting', 'Zigzagging',
];

// ─── Glyphs (verbatim from claude-code components/Spinner/utils.ts) ─

function getDefaultGlyphs(): string[] {
  // Ghostty: last glyph uses * instead of ✽ (renders offset in Ghostty)
  if (process.env.TERM === 'xterm-ghostty') {
    return ['·', '✢', '✳', '✶', '✻', '*'];
  }
  // macOS renders ✳ correctly; Linux/Windows use * for the 3rd glyph
  return process.platform === 'darwin'
    ? ['·', '✢', '✳', '✶', '✻', '✽']
    : ['·', '✢', '*', '✶', '✻', '✽'];
}

// Arrow prefix per mode: ↑ for requesting, ↓ for everything else
const ARROW_REQUESTING = '↑';
const ARROW_WORKING = '↓';

// Ping-pong spinner frames (forward then reverse, like Claude Code)
const DEFAULT_GLYPHS = getDefaultGlyphs();
const SPINNER_FRAMES = [...DEFAULT_GLYPHS, ...[...DEFAULT_GLYPHS].reverse()];

// ─── ANSI Colors ──────────────────────────────────────────────────

const RESET = "\x1b[0m";
const ORANGE = "\x1b[38;2;215;119;87m";
const DIM = "\x1b[38;2;153;153;153m";
// ─── Timing Constants ─────────────────────────────────────────────

const SHIMMER_MS_REQUESTING = 50;   // shimmer tick when sending request
const SHIMMER_MS_WORKING = 200;     // shimmer tick when receiving
const SHIMMER_BAND = 4;          // highlight band width in chars
const SHOW_TIMER_AFTER_MS = 30_000;
// Stall: verb begins transitioning to red after 3s of no tokens, reaches
// full red 2s later. Matches useStalledAnimation.ts STALL_DELAY_MS=3000,
// ramp = (timeSinceLastToken - 3000) / 2000.
const STALL_DELAY_MS = 3_000;
const STALL_RAMP_MS = 2_000;
const ERROR_RED: [number, number, number] = [171, 43, 63];
const STALL_RED_SHIMMER: [number, number, number] = [220, 100, 100];

// ─── Helpers ──────────────────────────────────────────────────────

function pickVerb(): string {
  return VERBS[Math.floor(Math.random() * VERBS.length)]!;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function formatCount(n: number): string {
  // Compact notation for large counts, mirroring claude-code
  // utils/format.ts formatNumber(): numbers below 1000 stay plain, and
  // 1000+ render as "1.3k" / "1.2m" etc. (lowercase suffix).
  if (n < 1000) return n.toString();
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  })
    .format(n)
    .toLowerCase();
}

// ─── Shimmer Engine ───────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function blend(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/**
 * Color-sweep: a moving highlight band across the verb text.
 * Returns ANSI-escaped string with per-character colors.
 */
function colorSweep(
  text: string,
  frame: number,
  baseHex: string,
  shimmerHex: string,
  reverse: boolean,
): string {
  const base = hexToRgb(baseHex);
  const shimmer = hexToRgb(shimmerHex);
  const total = text.length + SHIMMER_BAND * 2;
  const rawPos = frame % total;
  // Reverse: sweep right-to-left instead of left-to-right
  const pos = reverse ? total - 1 - rawPos : rawPos;

  let out = "";
  for (let i = 0; i < text.length; i++) {
    const dist = Math.abs(i - pos);
    const t = Math.max(0, 1 - dist / SHIMMER_BAND);
    const c = blend(base, shimmer, t);
    out += `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${text[i]}`;
  }
  out += RESET;
  return out;
}

// ─── Extension ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── State ───────────────────────────────────────────────────

  let mode: SpinnerMode = "requesting";
  let verb = "";
  let agentStart = 0;
  let turnStart = 0;
  let responseLen = 0;
  // Per-message length accumulated from streamed deltas. Used on `done` to
  // reconcile non-streamed content without double-counting (mirrors Claude
  // Code, which only ever adds streamed deltas and accumulates per run).
  let _streamedLen = 0;
  let lastTokenTime = 0;
  let turnActive = false;
  let activeToolCount = 0;

  // Stall smooth interpolation (0→1) — matches useStalledAnimation.ts:
  // _stallTarget = raw time-based target (clamped 0..1)
  // _stallIntensity = smoothed value, updated += diff * 0.1 per 50ms tick
  let _stallIntensity = 0;
  let _stallTarget = 0;
  // Token smooth animation
  let _displayedTokens = 0;

  // Timers
  let shimmerTimer: ReturnType<typeof setInterval> | null = null;
  let stallTimer: ReturnType<typeof setInterval> | null = null;
  let shimmerFrame = 0;

  // State
  let ctx_: ExtensionContext | null = null;

  // ── Helpers ─────────────────────────────────────────────────

  function buildStatusParts(): string[] {
    const elapsed = Date.now() - (agentStart || turnStart);
    const tokens = Math.max(0, _displayedTokens);
    const parts: string[] = [];

    // Claude-code order inside the parens (SpinnerAnimationRow.tsx builds
    // parts in render order): [timer, tokens, thinking] left-to-right.
    // The timer is gated on the 30s threshold; tokens and thinking are
    // gated on their own state.
    if (elapsed > SHOW_TIMER_AFTER_MS) {
      parts.push(formatDuration(elapsed));
    }

    if (mode === "requesting") {
      // Show ↑ during the requesting phase even before any tokens arrive.
      // This makes the ↑→↓ transition visible (the ↑ branch was previously
      // dead because the arrow was gated behind `tokens > 0`, which is always
      // false while requesting).
      parts.push(
        `${ARROW_REQUESTING}${tokens > 0 ? ` ${formatCount(tokens)} tokens` : ""}`,
      );
    } else if (tokens > 0) {
      parts.push(`${ARROW_WORKING} ${formatCount(tokens)} tokens`);
    }

    return parts;
  }

  function buildShimmerMessage(): string {
    const parts = buildStatusParts();
    const reverse = mode !== "requesting";
    const baseHex = "#D77757";
    const shimmerHex = "#F59575";
    const stalled = _stallIntensity > 0;

    let verbText: string;

    if (mode === "tool-use") {
      // Flash effect: entire verb oscillates between base and shimmer
      // (matches SpinnerAnimationRow.tsx flashOpacity formula).
      const flashOpacity =
        (Math.sin((shimmerFrame * SHIMMER_MS_WORKING / 1000) * Math.PI) + 1) / 2;
      if (stalled) {
        // Mirror SpinnerGlyph.tsx + GlimmerMessage.tsx: when intensity > 0.5,
        // jump to ERROR_RED directly; otherwise interpolate.
        if (_stallIntensity > 0.5) {
          verbText = `\x1b[38;2;${ERROR_RED[0]};${ERROR_RED[1]};${ERROR_RED[2]}m${verb}…\x1b[0m`;
        } else {
          const baseC = hexToRgb(baseHex);
          const stallC = blend(baseC, ERROR_RED, _stallIntensity);
          const flashC = blend(stallC, ERROR_RED, flashOpacity);
          verbText = `\x1b[38;2;${flashC[0]};${flashC[1]};${flashC[2]}m${verb}…\x1b[0m`;
        }
      } else {
        const base = hexToRgb(baseHex);
        const shimmer = hexToRgb(shimmerHex);
        const c = blend(base, shimmer, flashOpacity);
        verbText = `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${verb}…\x1b[0m`;
      }
    } else if (stalled) {
      // Smooth stall: blend base and shimmer toward red over STALL_RAMP_MS.
      if (_stallIntensity > 0.5) {
        // High intensity: render the verb text directly in red with sweep
        // highlights. At this point base/shimmer are visually indistinguishable
        // from red so we just sweep the red word for movement.
        verbText = colorSweep(verb + "…", shimmerFrame, "#AB2B3F", "#DC6464", reverse);
      } else {
        const baseC = hexToRgb(baseHex);
        const shimC = hexToRgb(shimmerHex);
        const stallBase = blend(baseC, ERROR_RED, _stallIntensity);
        const stallShimmer = blend(shimC, STALL_RED_SHIMMER, _stallIntensity);
        const baseHexStr = `#${stallBase[0].toString(16).padStart(2, "0")}${stallBase[1].toString(16).padStart(2, "0")}${stallBase[2].toString(16).padStart(2, "0")}`;
        const shimmerHexStr = `#${stallShimmer[0].toString(16).padStart(2, "0")}${stallShimmer[1].toString(16).padStart(2, "0")}${stallShimmer[2].toString(16).padStart(2, "0")}`;
        verbText = colorSweep(verb + "…", shimmerFrame, baseHexStr, shimmerHexStr, reverse);
      }
    } else {
      verbText = colorSweep(verb + "…", shimmerFrame, baseHex, shimmerHex, reverse);
    }

    let msg = verbText;
    if (parts.length > 0) {
      msg += ` ${DIM}(${parts.join(" · ")})${RESET}`;
    }
    return msg;
  }

  function updateDisplay() {
    const ctx = ctx_;
    if (!ctx) return;
    try {
      ctx.ui.setWorkingMessage(buildShimmerMessage());
    } catch {
      // Session replacement/reload invalidates the captured context before an
      // already-queued timer callback necessarily gets a chance to run.
      // Drop it here; session_start will provide the replacement context.
      if (ctx_ === ctx) ctx_ = null;
    }
  }

  // 50ms tick used for stall-ramp smoothing and (during requesting) token
  // animation. Mirrors the 50ms animation clock in SpinnerAnimationRow.tsx.
  function updateStallState() {
    // Raw time-based target from useStalledAnimation.ts:
    //   intensity = (timeSinceLastToken - 3000) / 2000, clamped 0..1
    //   = 0 when hasActiveTools OR responseLength === 0 OR not yet stalled
    if (lastTokenTime === 0 || activeToolCount > 0) {
      _stallTarget = 0;
    } else {
      const since = Date.now() - lastTokenTime;
      _stallTarget = Math.min(
        1,
        Math.max(0, (since - STALL_DELAY_MS) / STALL_RAMP_MS),
      );
    }
    // Smooth toward target (10% per tick), matching
    // useStalledAnimation.ts `current += diff * 0.1`.
    const diff = _stallTarget - _stallIntensity;
    if (Math.abs(diff) >= 0.01) {
      _stallIntensity += diff * 0.1;
    } else {
      _stallIntensity = _stallTarget;
    }
  }

  function startShimmer() {
    stopShimmer();
    shimmerFrame = 0;
    updateDisplay();
    const intervalMs =
      mode === "requesting" ? SHIMMER_MS_REQUESTING : SHIMMER_MS_WORKING;
    shimmerTimer = setInterval(() => {
      shimmerFrame++;
      // Token smooth animation (matches SpinnerAnimationRow.tsx increments)
      const target = Math.round(responseLen / 4);
      if (_displayedTokens < target) {
        const gap = target - _displayedTokens;
        const increment =
          gap < 70
            ? 3
            : gap < 200
              ? Math.max(8, Math.ceil(gap * 0.15))
              : 50;
        _displayedTokens = Math.min(_displayedTokens + increment, target);
      }
      updateDisplay();
    }, intervalMs);
    // 50ms tick for stall smoothing. The shimmer timer doesn't drive stall
    // state because requesting-mode ticks are 50ms but working-mode ticks
    // are 200ms — we want 50ms granularity always to match claude-code.
    stallTimer = setInterval(updateStallState, 50);
  }

  function stopShimmer() {
    if (shimmerTimer) {
      clearInterval(shimmerTimer);
      shimmerTimer = null;
    }
    if (stallTimer) {
      clearInterval(stallTimer);
      stallTimer = null;
    }
  }

  function setGlyphs() {
    const ctx = ctx_;
    if (!ctx) return;
    const intervalMs = 120;
    try {
      ctx.ui.setWorkingIndicator({
        frames: SPINNER_FRAMES.map((g) => ORANGE + g + RESET),
        intervalMs,
      });
    } catch {
      // See updateDisplay(): replacement can race an already-running callback.
      if (ctx_ === ctx) ctx_ = null;
    }
  }

  function setMode(newMode: SpinnerMode) {
    if (mode === newMode) return;
    mode = newMode;
    // Do NOT call setGlyphs() here — the spinner frames don't change between
    // modes. setWorkingIndicator() resets the Loader's currentFrame to 0,
    // which would cause the glyph to jump every mode flip. The arrow prefix
    // (↑/↓) lives in the status parts, not in the spinner.
    if (shimmerTimer) {
      stopShimmer();
      startShimmer();
    }
  }

  // Zero the run-scoped token counters. Called only at run boundaries
  // (agent_start / non-retry agent_end) so the displayed token count is a
  // running total that persists across every assistant message in a run,
  // matching Claude Code. NOT called per turn.
  function resetRunCounters() {
    responseLen = 0;
    _streamedLen = 0;
    _displayedTokens = 0;
    lastTokenTime = 0;
    activeToolCount = 0;
  }

  // Per-turn UI reset only (mode, thinking timers, stall, spinner). Does NOT
  // touch the token counters — those persist across turns and are reset in
  // resetRunCounters() at run boundaries.
  function resetTurn() {
    stopShimmer();
    const ctx = ctx_;
    if (ctx) {
      try {
        ctx.ui.setWorkingMessage();
      } catch {
        if (ctx_ === ctx) ctx_ = null;
      }
    }
    mode = "requesting";
    _stallIntensity = 0;
    _stallTarget = 0;
    // setGlyphs() stays here so a new turn's spinner is initialized, but is
    // NOT called from setMode() — see comment in setMode above.
    setGlyphs();
  }

  // ── Events ──────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    ctx_ = ctx;
  });

  // Initialize shimmer state. Factored out so both agent_start and turn_start
  // can call it; turn_start skips when already initialized by agent_start.
  function initTurn() {
    turnActive = true;
    turnStart = Date.now();
    if (!agentStart) agentStart = turnStart;
    verb = pickVerb();
    resetTurn();
    setMode("requesting");
    startShimmer();
  }

  // agent_start fires before turn_start and is the moment pi rebuilds the
  // working loader. Initialize shimmer here so the loader picks up our
  // message + indicator immediately instead of flashing "Working...".
  // Also resets the run-scoped token counters: each agent run corresponds to
  // one user prompt, and Claude Code zeroes responseLengthRef per prompt.
  pi.on("agent_start", async (_event, ctx) => {
    ctx_ = ctx;
    resetRunCounters();
    if (!agentStart) agentStart = Date.now();
    if (!turnActive) initTurn();
  });

  pi.on("turn_start", async (_event, ctx) => {
    ctx_ = ctx;
    if (turnActive) return;   // already initialized by agent_start
    initTurn();
  });

  pi.on("message_update", async (event, ctx) => {
    ctx_ = ctx;
    const evt = event.assistantMessageEvent;

    switch (evt.type) {
      case "thinking_start":
        setMode("thinking");
        break;

      case "thinking_delta":
        // Count reasoning content toward the token estimate, matching Claude
        // Code (onUpdateLength on thinking deltas). Mode is already "thinking"
        // from thinking_start; no mode change needed here.
        if (typeof evt.delta === "string") {
          lastTokenTime = Date.now();
          responseLen += evt.delta.length;
          _streamedLen += evt.delta.length;
        }
        break;

      case "text_start":
        if (mode !== "responding") {
          setMode("responding");
        }
        lastTokenTime = Date.now();
        break;

      case "text_delta":
        if (mode !== "responding") {
          setMode("responding");
        }
        lastTokenTime = Date.now();
        if (typeof evt.delta === "string") {
          responseLen += evt.delta.length;
          _streamedLen += evt.delta.length;
        }
        break;

      // text_end carries the full block but its deltas were already counted
      // above; no snapping needed (would risk dropping prior turns' total).

      case "toolcall_start":
        setMode("tool-input");
        lastTokenTime = Date.now();
        break;

      case "toolcall_delta":
        lastTokenTime = Date.now();
        if (typeof evt.delta === "string") {
          responseLen += evt.delta.length;
          _streamedLen += evt.delta.length;
        }
        break;

      // toolcall_end carries the final args but its deltas were already
      // counted; no snapping needed (see text_end note).

      case "done":
        // Claude Code: message_stop switches to tool-use;
        // if no tools, just stay at responding
        if (activeToolCount > 0) {
          setMode("tool-use");
        }
        if (evt.message?.content) {
          // Accumulate (never overwrite) so the total persists across turns.
          // Add only the length that deltas did NOT already count, so a
          // fully-streamed message adds ~0 while a non-streamed one adds its
          // full content.
          const msgLen = (evt.message.content as any[]).reduce(
            (s: number, b: any) => {
              if (b.type === "text" && typeof b.text === "string")
                return s + b.text.length;
              if (b.type === "thinking" && typeof b.thinking === "string")
                return s + b.thinking.length;
              if (b.type === "toolCall")
                return s + JSON.stringify(b.arguments ?? "").length;
              return s;
            },
            0,
          );
          responseLen += Math.max(0, msgLen - _streamedLen);
          _streamedLen = 0;
        }
        break;
    }
  });

  pi.on("tool_execution_start", async (_event, ctx) => {
    ctx_ = ctx;
    activeToolCount++;
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    ctx_ = ctx;
    activeToolCount = Math.max(0, activeToolCount - 1);
    // After all tools finish, switch back to responding if the turn is still active
    if (activeToolCount === 0 && (mode === "tool-use" || mode === "tool-input") && turnActive) {
      setMode("responding");
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    ctx_ = ctx;
    turnActive = false;
    stopShimmer();

    // Do NOT reset responseLen/_displayedTokens here: the token count must
    // persist across assistant messages within a run (Claude Code resets it
    // only per prompt and at run end, never between turns).
    activeToolCount = 0;
  });

  pi.on("agent_end", async (event) => {
    turnActive = false;
    stopShimmer();

    // agent_end fires on every agent-loop iteration, including iterations
    // that pi will retry (e.g. transient "terminated" stream drops handled
    // via summarization_retry_scheduled). The next agent_start → initTurn()
    // reinitializes the spinner with a fresh verb, so we must NOT fire the
    // completion notification here and must keep agentStart/turnStart so the
    // total-run elapsed time stays correct across the retry.
    //
    // Note: AgentEndEvent's published type omits `willRetry`, but pi core
    // attaches it at runtime via `_emit(event.type === "agent_end" ? { ...event, willRetry: ... } : event)`
    // (see dist/core/agent-session.js:353). Cast to read the runtime field.
    const willRetry = (event as { willRetry?: boolean }).willRetry === true;
    if (willRetry) {
      return;
    }

    agentStart = 0;
    turnStart = 0;
    // The run truly stopped: reset the accumulated token counters (mirrors
    // Claude Code resetLoadingState zeroing responseLengthRef on run end).
    resetRunCounters();

    const ctx = ctx_;
    if (ctx) {
      // VENDORED: upstream notified "✻ {verb} for {duration}" here; removed
      // because it overwrote pi-tps's telemetry banner.
      try {
        ctx.ui.setWorkingMessage();
      } catch {
        // The run may settle while its session is being replaced.
        if (ctx_ === ctx) ctx_ = null;
      }
    }
  });

  pi.on("session_shutdown", async () => {
    // Invalidate first so timer callbacks cannot retain the outgoing context.
    ctx_ = null;
    turnActive = false;
    stopShimmer();
  });
}
