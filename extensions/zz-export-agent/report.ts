export type Serializable = null | boolean | number | string | Serializable[] | { [key: string]: Serializable };

export type CaptureFidelity = "provider-request" | "logical-request" | "preflight";

export interface SourceSnapshot {
	path: string;
	source: string;
	scope: string;
	origin: string;
	baseDir?: string;
}

export interface SkillSnapshot {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	disableModelInvocation: boolean;
	sourceInfo?: SourceSnapshot;
}

export interface ContextFileSnapshot {
	path: string;
	content: string;
}

export interface PromptOptionsSnapshot {
	customPrompt?: string;
	selectedTools: string[];
	toolSnippets: Record<string, string>;
	promptGuidelines: string[];
	appendSystemPrompt?: string;
	cwd: string;
	contextFiles: ContextFileSnapshot[];
	skills: SkillSnapshot[];
}

export interface ToolSnapshot {
	name: string;
	description: string;
	active: boolean;
	parameters: Serializable;
	promptGuidelines: string[];
	promptSnippet?: string;
	sourceInfo: SourceSnapshot;
}

export interface CommandSnapshot {
	name: string;
	description?: string;
	source: string;
	sourceInfo: SourceSnapshot;
}

export interface ModelSnapshot {
	provider: string;
	id: string;
	name: string;
	api: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	input: string[];
	thinkingLevel: string;
}

export interface UsageSnapshot {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	totalTokens: number;
	cost?: {
		input: number;
		cacheRead: number;
		cacheWrite: number;
		output: number;
		total: number;
	};
}

export interface TurnSnapshot {
	index: number;
	stopReason?: string;
	toolCallCount: number;
	assistant: Serializable;
	toolResults: Serializable[];
	usage?: UsageSnapshot;
}

export interface AgentLoopSnapshot {
	schemaVersion: 2;
	generatedAt: string;
	capture: {
		fidelity: CaptureFidelity;
		sessionStartedAt: string;
		sessionStartReason: string;
		runStartedAt?: string;
		latestContextBuiltAt?: string;
		latestProviderRequestAt?: string;
		providerRequestCount: number;
		existingContextEntriesAtLoad: number;
		note: string;
	};
	session: {
		id: string;
		file?: string;
		cwd: string;
		name?: string;
		persisted: boolean;
	};
	model?: ModelSnapshot;
	prompt: {
		effective: string;
		options: PromptOptionsSnapshot;
	};
	tools: ToolSnapshot[];
	messages?: Serializable[];
	providerPayload?: Serializable;
	turns: TurnSnapshot[];
	commands: CommandSnapshot[];
}

const COLORS = {
	canvas: "#eef1f4",
	paper: "#ffffff",
	ink: "#202a33",
	muted: "#66737f",
	line: "#d5dce2",
	blue: "#2563eb",
	teal: "#0f766e",
	amber: "#a85116",
} as const;

const CSS = String.raw`
:root {
	--canvas: ${COLORS.canvas};
	--paper: ${COLORS.paper};
	--ink: ${COLORS.ink};
	--muted: ${COLORS.muted};
	--line: ${COLORS.line};
	--blue: ${COLORS.blue};
	--teal: ${COLORS.teal};
	--amber: ${COLORS.amber};
	--blue-soft: #edf4ff;
	--teal-soft: #eaf7f4;
	--amber-soft: #fff5eb;
	--code: #f5f7f9;
	--body: "Aptos", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
	--display: "Aptos Display", "Segoe UI Variable Display", "Helvetica Neue", sans-serif;
	--mono: "Berkeley Mono", "Cascadia Code", "SFMono-Regular", Consolas, monospace;
	color-scheme: light;
}

* { box-sizing: border-box; }
html { scroll-behavior: smooth; background: var(--canvas); }
body { margin: 0; color: var(--ink); background: var(--canvas); font-family: var(--body); font-size: 15px; line-height: 1.62; -webkit-font-smoothing: antialiased; }
::selection { color: white; background: var(--blue); }
a { color: inherit; }
button, summary, a { -webkit-tap-highlight-color: transparent; }
button:focus-visible, summary:focus-visible, a:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
code, pre { font-family: var(--mono); }
code { font-size: 0.88em; }

.shell { display: grid; grid-template-columns: 248px minmax(0, 1fr); width: min(100%, 1440px); min-height: 100vh; margin: 0 auto; background: var(--paper); border-inline: 1px solid var(--line); }
.rail { border-right: 1px solid var(--line); background: #f7f9fb; }
.rail-inner { position: sticky; top: 0; display: flex; height: 100vh; flex-direction: column; padding: 28px 22px 22px; overflow-y: auto; }
.rail-mark { color: var(--blue); font-family: var(--mono); font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.rail-title { margin: 12px 0 4px; font-family: var(--display); font-size: 25px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.12; }
.rail-subtitle { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.nav { display: grid; gap: 1px; margin: 32px 0 24px; }
.nav a { padding: 7px 10px; color: var(--muted); border-left: 2px solid transparent; font-size: 12px; text-decoration: none; }
.nav a:hover { color: var(--ink); background: white; border-left-color: var(--blue); }
.nav-index { display: none; }
.rail-actions { display: grid; gap: 7px; margin-top: auto; }
.control { min-height: 35px; padding: 7px 10px; color: var(--ink); background: white; border: 1px solid var(--line); border-radius: 4px; font-family: var(--body); font-size: 12px; font-weight: 600; text-align: left; cursor: pointer; }
.control:hover { border-color: #9aa7b2; }
.control.primary { color: var(--blue); border-color: #a9c2fa; }
.rail-confidential { margin: 16px 0 0; color: #7a5a45; font-size: 10px; line-height: 1.5; }

.main { min-width: 0; }
.hero { padding: clamp(48px, 7vw, 88px) clamp(28px, 7vw, 88px) 54px; border-bottom: 1px solid var(--line); }
.hero-inner { max-width: 1040px; }
.kicker, .section-no, .micro-label { font-family: var(--mono); font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.kicker { color: var(--blue); }
.hero h1 { max-width: 800px; margin: 18px 0 18px; font-family: var(--display); font-size: clamp(38px, 5.3vw, 62px); font-weight: 600; letter-spacing: -0.045em; line-height: 1.05; }
.hero-deck { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(250px, 0.75fr); gap: 42px; align-items: start; max-width: 980px; }
.hero-deck > p { margin: 0; color: #3f4d58; font-size: clamp(17px, 2vw, 21px); line-height: 1.55; }
.capture-card { padding: 14px 16px; background: var(--blue-soft); border-left: 3px solid var(--blue); }
.capture-card strong { display: block; font-size: 13px; }
.capture-card p { margin: 5px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.layer-map { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); max-width: 1040px; margin-top: 48px; border-block: 1px solid var(--line); }
.layer { min-height: 140px; padding: 20px 22px 20px 0; }
.layer + .layer { padding-left: 22px; border-left: 1px solid var(--line); }
.layer b { display: block; margin-bottom: 9px; color: var(--muted); font-family: var(--mono); font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase; }
.layer h2 { margin: 0 0 8px; font-size: 18px; font-weight: 650; line-height: 1.25; }
.layer p { margin: 0; color: var(--muted); font-size: 12px; }
.layer.request { box-shadow: inset 0 3px 0 var(--blue); }

.meta-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-bottom: 1px solid var(--line); }
.meta-cell { min-height: 82px; padding: 16px 20px; border-right: 1px solid var(--line); }
.meta-cell:last-child { border-right: 0; }
.meta-cell span { display: block; color: var(--muted); font-size: 10px; }
.meta-cell strong { display: block; margin-top: 5px; overflow-wrap: anywhere; font-family: var(--mono); font-size: 11px; font-weight: 600; line-height: 1.45; }

.section { max-width: 1180px; margin: 0 auto; padding: clamp(52px, 7vw, 78px) clamp(28px, 7vw, 88px); border-bottom: 1px solid var(--line); scroll-margin-top: 12px; }
.section-head { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 28px; margin-bottom: 34px; }
.section-no { padding-top: 7px; color: var(--blue); }
.section h2 { margin: 0; font-family: var(--display); font-size: clamp(28px, 4vw, 40px); font-weight: 620; letter-spacing: -0.035em; line-height: 1.13; }
.section-intro { grid-column: 2; max-width: 760px; margin: -13px 0 0; color: var(--muted); font-size: 14px; }
.callout { margin: 24px 0; padding: 16px 18px; background: var(--blue-soft); border-left: 3px solid var(--blue); font-size: 13px; }
.callout.warning { color: #6d3d1f; background: var(--amber-soft); border-left-color: var(--amber); }
.callout p { margin: 0; }
.callout p + p { margin-top: 8px; }

.layer-note { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 28px; padding: 18px 0; border-top: 1px solid var(--line); }
.layer-note:last-child { border-bottom: 1px solid var(--line); }
.layer-note b { font-size: 13px; }
.layer-note p { margin: 0; color: var(--muted); font-size: 13px; }

.trace-frame { overflow: hidden; border: 1px solid var(--line); border-radius: 6px; }
.trace-head, .trace-row { display: grid; grid-template-columns: 76px minmax(0, 1.25fr) minmax(230px, 0.75fr); }
.trace-head { color: var(--muted); background: #f7f9fb; font-family: var(--mono); font-size: 9px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.trace-head > div, .trace-row > div { padding: 13px 16px; }
.trace-head .provider-col, .trace-provider { border-left: 2px solid #9bb9f7; background: #f7faff; }
.trace-row { min-height: 104px; border-top: 1px solid var(--line); }
.trace-step { color: var(--blue); font-family: var(--mono); font-size: 11px; font-weight: 700; }
.trace-local h3, .trace-provider h3 { margin: 0 0 6px; font-size: 15px; font-weight: 650; }
.trace-local p, .trace-provider p { margin: 0; color: var(--muted); font-size: 12px; }
.trace-provider.empty { color: #a6afb7; background: #fbfcfd; }
.evidence { display: inline-block; margin-top: 10px; padding: 2px 6px; color: var(--teal); background: var(--teal-soft); border-radius: 3px; font-family: var(--mono); font-size: 8px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }
.evidence.explained { color: #6b7280; background: #eef1f4; }
.boundary-label { color: var(--blue); }

.manifest { width: 100%; border-collapse: collapse; border-top: 1px solid var(--line); }
.manifest th, .manifest td { padding: 15px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
.manifest th { color: var(--muted); font-family: var(--mono); font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; }
.manifest td { font-size: 13px; }
.manifest td:first-child { width: 23%; font-weight: 650; }
.manifest td:nth-child(3) { width: 18%; }
.sent-yes, .sent-local { display: inline-block; padding: 2px 6px; border-radius: 3px; font-family: var(--mono); font-size: 9px; font-weight: 700; }
.sent-yes { color: var(--teal); background: var(--teal-soft); }
.sent-local { color: #5f6b75; background: #eef1f4; }

.payload-layout { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 24px; align-items: start; }
.payload-aside { padding: 18px; background: #f7f9fb; border: 1px solid var(--line); }
.payload-aside h3 { margin: 0 0 9px; font-size: 15px; }
.payload-aside p { margin: 0; color: var(--muted); font-size: 12px; }
.payload-aside p + p { margin-top: 10px; }

.call-ledger { border-top: 1px solid var(--line); }
.call-row { display: grid; grid-template-columns: 110px minmax(0, 1fr) minmax(210px, 0.55fr); gap: 20px; padding: 20px 0; border-bottom: 1px solid var(--line); }
.call-id { color: var(--blue); font-family: var(--mono); font-size: 10px; font-weight: 700; }
.call-context { display: flex; flex-wrap: wrap; gap: 5px; }
.segment { padding: 5px 8px; color: #41505c; background: #edf1f4; border-radius: 3px; font-family: var(--mono); font-size: 9px; }
.segment.cacheable { color: #174ea6; background: #e8f0ff; }
.segment.new { color: #7b451f; background: var(--amber-soft); }
.call-result { color: var(--muted); font-size: 12px; }
.call-result strong { display: block; margin-bottom: 4px; color: var(--ink); font-size: 13px; }
.local-action { margin: 14px 0 14px 130px; padding: 12px 15px; color: #285c53; background: var(--teal-soft); border-left: 3px solid var(--teal); font-size: 12px; }

.cache-layout { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(260px, 0.75fr); gap: 30px; }
.usage-panel { padding: 22px; border: 1px solid var(--line); border-radius: 6px; }
.usage-panel h3 { margin: 0; font-size: 17px; }
.usage-panel > p { margin: 6px 0 20px; color: var(--muted); font-size: 12px; }
.usage-bar { display: flex; width: 100%; height: 32px; overflow: hidden; background: #edf1f4; border-radius: 4px; }
.usage-part { min-width: 2px; height: 100%; }
.usage-part.zero { min-width: 0; }
.usage-part.input { background: var(--blue); }
.usage-part.cache-read { background: repeating-linear-gradient(135deg, #65a5ea 0 5px, #9fc9f4 5px 10px); }
.usage-part.cache-write { background: #8b78c9; }
.usage-part.output { background: var(--amber); }
.usage-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 16px; }
.usage-stat { padding-left: 10px; border-left: 3px solid var(--line); }
.usage-stat.input { border-color: var(--blue); }
.usage-stat.cache-read { border-color: #77abe3; }
.usage-stat.cache-write { border-color: #8b78c9; }
.usage-stat.output { border-color: var(--amber); }
.usage-stat span { display: block; color: var(--muted); font-size: 9px; }
.usage-stat strong { display: block; margin-top: 3px; font-family: var(--mono); font-size: 13px; }
.cache-definitions { margin: 0; }
.cache-definitions dt { margin-top: 16px; font-weight: 650; }
.cache-definitions dt:first-child { margin-top: 0; }
.cache-definitions dd { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
.equation { margin-top: 24px; padding: 15px 18px; background: var(--code); border: 1px solid var(--line); font-family: var(--mono); font-size: 11px; text-align: center; }
.equation + .cache-layout, .equation + .budget-frame { margin-top: 24px; }

.turn-table { width: 100%; margin-top: 26px; border-collapse: collapse; }
.turn-table th, .turn-table td { padding: 11px 10px; border-bottom: 1px solid var(--line); text-align: right; }
.turn-table th { color: var(--muted); font-family: var(--mono); font-size: 8px; letter-spacing: 0.05em; text-transform: uppercase; }
.turn-table th:first-child, .turn-table td:first-child { text-align: left; }
.turn-table td { font-family: var(--mono); font-size: 10px; }
.turn-note { display: block; margin-top: 2px; color: var(--muted); font-family: var(--body); font-size: 10px; }

.budget-frame { padding: 22px; border: 1px solid var(--line); border-radius: 6px; }
.budget-ruler { display: flex; justify-content: space-between; margin-bottom: 8px; color: var(--muted); font-family: var(--mono); font-size: 9px; }
.budget-bar { display: flex; width: 100%; height: 28px; overflow: hidden; background: #edf1f4; border-radius: 4px; }
.budget-segment { min-width: 2px; height: 100%; border-right: 1px solid white; }
.budget-segment.zero { min-width: 0; border-right: 0; }
.budget-segment.system { background: var(--blue); }
.budget-segment.tools { background: var(--teal); }
.budget-segment.messages { background: #7a8a99; }
.budget-empty { flex: 1; min-width: 0; background: repeating-linear-gradient(135deg, transparent 0 7px, rgba(32, 42, 51, 0.06) 7px 8px); }
.budget-legend { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 16px; }
.legend-item { padding-left: 9px; border-left: 3px solid var(--line); }
.legend-item.system { border-color: var(--blue); }
.legend-item.tools { border-color: var(--teal); }
.legend-item.messages { border-color: #7a8a99; }
.legend-item span { display: block; color: var(--muted); font-size: 9px; }
.legend-item strong { display: block; margin-top: 2px; font-family: var(--mono); font-size: 11px; }
.fact-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; margin-top: 24px; background: var(--line); border: 1px solid var(--line); }
.fact { padding: 17px; background: white; }
.fact strong { display: block; margin-bottom: 5px; font-size: 13px; }
.fact p { margin: 0; color: var(--muted); font-size: 12px; }

.assembly { border-top: 1px solid var(--line); }
.assembly-details { margin-top: 24px; }
.assembly-row { display: grid; grid-template-columns: 38px minmax(155px, 0.35fr) minmax(0, 1fr) 105px; gap: 16px; padding: 17px 0; border-bottom: 1px solid var(--line); }
.assembly-index { color: var(--blue); font-family: var(--mono); font-size: 10px; font-weight: 700; }
.assembly-row h3 { margin: 0; font-size: 14px; font-weight: 650; }
.assembly-row p { margin: 0; color: var(--muted); font-size: 12px; }
.lane { justify-self: end; color: var(--blue); font-family: var(--mono); font-size: 8px; text-transform: uppercase; }
.lane.separate { color: var(--teal); }
.detail-group + .detail-group { margin-top: 48px; padding-top: 38px; border-top: 1px solid var(--line); }
.detail-group > h3 { margin: 0 0 6px; font-size: 20px; }
.detail-group > p { max-width: 760px; margin: 0 0 18px; color: var(--muted); font-size: 13px; }

.prompt-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin-bottom: 18px; border: 1px solid var(--line); }
.prompt-stat { padding: 14px; border-right: 1px solid var(--line); }
.prompt-stat:last-child { border-right: 0; }
.prompt-stat span { display: block; color: var(--muted); font-size: 9px; }
.prompt-stat strong { display: block; margin-top: 4px; font-family: var(--mono); font-size: 12px; }

.raw-block { margin: 9px 0; background: white; border: 1px solid var(--line); border-radius: 5px; }
.raw-block > summary { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: center; min-height: 46px; padding: 10px 13px; list-style: none; cursor: pointer; }
.raw-block > summary::-webkit-details-marker { display: none; }
.raw-title { min-width: 0; font-family: var(--mono); font-size: 10px; font-weight: 650; overflow-wrap: anywhere; }
.raw-meta { color: var(--muted); font-size: 9px; }
.raw-meta::after { margin-left: 8px; color: var(--blue); content: "+"; }
.raw-block[open] .raw-meta::after { content: "−"; }
.raw-block[open] > summary { background: #f7f9fb; border-radius: 5px 5px 0 0; }
.raw-content { position: relative; border-top: 1px solid var(--line); }
.raw-content pre { max-height: 660px; margin: 0; padding: 19px; overflow: auto; color: #263744; background: var(--code); font-size: 10px; line-height: 1.65; tab-size: 2; white-space: pre-wrap; overflow-wrap: anywhere; }
.copy-button { position: sticky; top: 9px; z-index: 2; float: right; margin: 9px 9px -42px 0; padding: 5px 8px; color: var(--blue); background: white; border: 1px solid #a9c2fa; border-radius: 3px; font-size: 9px; font-weight: 650; cursor: pointer; }
.copy-button:hover { background: var(--blue-soft); }
.empty-state { padding: 24px; color: var(--muted); background: #f7f9fb; border: 1px dashed var(--line); text-align: center; }
.empty-state strong { display: block; color: var(--ink); font-size: 14px; }
.empty-state p { max-width: 620px; margin: 5px auto 0; font-size: 12px; }

.tool-list { border-top: 1px solid var(--line); }
.tool { display: grid; grid-template-columns: minmax(130px, 0.23fr) minmax(0, 1fr) 100px; gap: 18px; padding: 19px 0; border-bottom: 1px solid var(--line); }
.tool-name code { color: var(--blue); font-size: 11px; font-weight: 700; overflow-wrap: anywhere; }
.tool-state { display: block; width: fit-content; margin-top: 6px; padding: 2px 6px; color: var(--teal); background: var(--teal-soft); border-radius: 3px; font-size: 8px; font-weight: 700; }
.tool-state.inactive { color: var(--muted); background: #eef1f4; }
.tool-description { margin: 0 0 8px; font-size: 13px; }
.tool-origin { color: var(--muted); font-family: var(--mono); font-size: 8px; overflow-wrap: anywhere; }
.tool-token { justify-self: end; color: var(--muted); font-family: var(--mono); font-size: 8px; text-align: right; }
.tool details { grid-column: 2 / 4; margin: 0; }
.guidelines { margin: 9px 0 0; padding-left: 18px; color: var(--muted); font-size: 11px; }
.micro-label { color: var(--muted); font-size: 8px; }

.split { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.resource-card { min-width: 0; padding: 18px; border: 1px solid var(--line); border-radius: 5px; }
.local-commands { margin-top: 20px; }
.resource-card h3 { margin: 0 0 10px; font-size: 17px; }
.resource-count { color: var(--blue); font-family: var(--mono); }
.resource-card .section-intro { grid-column: auto; margin: 0 0 14px; font-size: 12px; }
.skill-list, .command-list { border-top: 1px solid var(--line); }
.skill-row, .command-row { display: grid; grid-template-columns: minmax(120px, 0.3fr) minmax(0, 1fr); gap: 14px; padding: 12px 0; border-bottom: 1px solid var(--line); }
.skill-row code, .command-row code { color: var(--blue); font-size: 9px; overflow-wrap: anywhere; }
.skill-row p, .command-row p { margin: 0; color: var(--muted); font-size: 11px; }
.path { display: block; margin-top: 4px; color: var(--muted); font-family: var(--mono); font-size: 8px; overflow-wrap: anywhere; }
.message { display: grid; grid-template-columns: 95px minmax(0, 1fr); gap: 18px; padding: 17px 0; border-top: 1px solid var(--line); }
.message-role { color: var(--blue); font-family: var(--mono); font-size: 9px; font-weight: 700; }
.message-index { display: block; margin-top: 4px; color: var(--muted); font-weight: 400; }
.message .raw-block { margin: 0; }

.not-sent-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border-top: 1px solid var(--line); }
.not-sent { min-height: 125px; padding: 18px 18px 18px 0; border-bottom: 1px solid var(--line); }
.not-sent:nth-child(2n) { padding-left: 18px; border-left: 1px solid var(--line); }
.not-sent b { display: block; color: var(--muted); font-family: var(--mono); font-size: 8px; text-transform: uppercase; }
.not-sent h3 { margin: 6px 0; font-size: 15px; }
.not-sent p { margin: 0; color: var(--muted); font-size: 11px; }

.footer { padding: 30px clamp(28px, 7vw, 88px); background: #f7f9fb; }
.footer-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, 0.45fr); gap: 36px; }
.footer h2 { margin: 0; font-size: 18px; }
.footer p { margin: 7px 0 0; color: var(--muted); font-size: 11px; }
.footer-meta { color: var(--muted); font-family: var(--mono); font-size: 8px; line-height: 1.7; }

@media (max-width: 980px) {
	.shell { grid-template-columns: 210px minmax(0, 1fr); }
	.rail-inner { padding-inline: 17px; }
	.hero-deck, .cache-layout, .payload-layout { grid-template-columns: 1fr; }
	.section-head { grid-template-columns: 115px minmax(0, 1fr); }
	.trace-head, .trace-row { grid-template-columns: 62px minmax(0, 1.15fr) minmax(190px, 0.85fr); }
	.fact-grid { grid-template-columns: 1fr; }
	.assembly-row { grid-template-columns: 32px minmax(135px, 0.35fr) minmax(0, 1fr); }
	.lane { grid-column: 2 / 4; justify-self: start; }
}

@media (max-width: 720px) {
	body { font-size: 14px; }
	.shell { display: block; border: 0; }
	.rail { border-right: 0; border-bottom: 1px solid var(--line); }
	.rail-inner { position: static; height: auto; padding: 15px; overflow: visible; }
	.rail-subtitle, .rail-confidential { display: none; }
	.rail-title { margin-top: 5px; font-size: 19px; }
	.nav { display: flex; margin: 14px -15px 8px; padding: 0 15px 6px; overflow-x: auto; }
	.nav a { flex: 0 0 auto; border: 1px solid var(--line); border-radius: 3px; }
	.rail-actions { grid-template-columns: repeat(3, 1fr); margin-top: 7px; }
	.control { text-align: center; }
	.hero { padding: 42px 21px 36px; }
	.hero h1 { font-size: clamp(34px, 11vw, 48px); }
	.layer-map, .meta-strip { grid-template-columns: 1fr; }
	.layer { min-height: 0; padding: 17px 0; }
	.layer + .layer { padding-left: 0; border-top: 1px solid var(--line); border-left: 0; }
	.meta-cell { min-height: 0; border-right: 0; border-bottom: 1px solid var(--line); }
	.meta-cell:last-child { border-bottom: 0; }
	.section { padding: 44px 21px; }
	.section-head { display: block; }
	.section-no { display: block; margin-bottom: 8px; }
	.section-intro { margin-top: 12px; }
	.layer-note { grid-template-columns: 1fr; gap: 5px; }
	.trace-head { display: none; }
	.trace-row { grid-template-columns: 42px minmax(0, 1fr); }
	.trace-provider { grid-column: 2; border-top: 1px dashed #9bb9f7; border-left: 2px solid #9bb9f7; }
	.trace-step { grid-row: 1 / 3; }
	.manifest { display: block; overflow-x: auto; }
	.call-row { grid-template-columns: 75px minmax(0, 1fr); }
	.call-result { grid-column: 2; }
	.local-action { margin-left: 95px; }
	.usage-grid, .budget-legend { grid-template-columns: repeat(2, minmax(0, 1fr)); }
	.turn-table { display: block; overflow-x: auto; }
	.prompt-summary, .split, .not-sent-grid { grid-template-columns: 1fr; }
	.prompt-stat { border-right: 0; border-bottom: 1px solid var(--line); }
	.prompt-stat:last-child { border-bottom: 0; }
	.assembly-row { grid-template-columns: 30px minmax(0, 1fr); gap: 10px; }
	.assembly-row p, .lane { grid-column: 2; }
	.tool { grid-template-columns: 1fr auto; gap: 10px; }
	.tool-description-wrap, .tool details { grid-column: 1 / 3; }
	.not-sent { padding-left: 0; }
	.not-sent:nth-child(2n) { padding-left: 0; border-left: 0; }
	.message { grid-template-columns: 1fr; gap: 7px; }
	.footer-grid { grid-template-columns: 1fr; }
}

@media (prefers-reduced-motion: reduce) {
	html { scroll-behavior: auto; }
}

@media print {
	@page { margin: 12mm; size: A4 portrait; }
	body { background: white; font-size: 9pt; }
	.shell { display: block; width: 100%; border: 0; }
	.rail { display: none; }
	.hero, .section { max-width: none; padding: 12mm 0; }
	.hero { break-after: page; }
	.section { break-before: page; }
	.raw-content pre { max-height: none; overflow: visible; font-size: 7pt; }
	details.raw-block:not([open]) > .raw-content { display: block; }
	.copy-button { display: none; }
	.tool, .resource-card, .raw-block, .message, .trace-row { break-inside: avoid; }
	* { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
}
`;

const JS = String.raw`
(function () {
	"use strict";

	function copyText(text, button) {
		function done(ok) {
			var original = button.textContent;
			button.textContent = ok ? "Copied" : "Copy failed";
			window.setTimeout(function () { button.textContent = original; }, 1400);
		}

		if (navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallback(); });
			return;
		}
		fallback();

		function fallback() {
			var area = document.createElement("textarea");
			area.value = text;
			area.setAttribute("readonly", "");
			area.style.position = "fixed";
			area.style.opacity = "0";
			document.body.appendChild(area);
			area.select();
			var ok = false;
			try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
			document.body.removeChild(area);
			done(ok);
		}
	}

	document.querySelectorAll("[data-copy-target]").forEach(function (button) {
		button.addEventListener("click", function () {
			var target = document.getElementById(button.getAttribute("data-copy-target"));
			if (target) copyText(target.textContent || "", button);
		});
	});

	var details = Array.prototype.slice.call(document.querySelectorAll("details.raw-block"));
	var expand = document.getElementById("expand-all");
	var collapse = document.getElementById("collapse-all");
	var print = document.getElementById("print-report");
	if (expand) expand.addEventListener("click", function () { details.forEach(function (item) { item.open = true; }); });
	if (collapse) collapse.addEventListener("click", function () { details.forEach(function (item) { item.open = false; }); });
	if (print) print.addEventListener("click", function () { window.print(); });

	var printState = [];
	window.addEventListener("beforeprint", function () {
		printState = details.map(function (item) { return item.open; });
		details.forEach(function (item) { item.open = true; });
	});
	window.addEventListener("afterprint", function () {
		details.forEach(function (item, index) { item.open = printState[index]; });
	});
})();
`;

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

function isRecord(value: Serializable | undefined): value is { [key: string]: Serializable } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => {
		switch (character) {
			case "&": return "&amp;";
			case "<": return "&lt;";
			case ">": return "&gt;";
			case "\"": return "&quot;";
			case "'": return "&#39;";
			default: return character;
		}
	});
}

function prettyJson(value: Serializable | Serializable[]): string {
	return JSON.stringify(value, null, 2);
}

export function estimateTokens(value: string | Serializable | Serializable[]): number {
	const text = typeof value === "string" ? value : prettyJson(value);
	return Math.max(0, Math.ceil(text.length / 4));
}

function formatNumber(value: number): string {
	return NUMBER_FORMAT.format(value);
}

function formatDate(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat("en-GB", {
		year: "numeric",
		month: "short",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		timeZoneName: "short",
		hourCycle: "h23",
	}).format(date);
}

function fidelityContent(fidelity: CaptureFidelity): { label: string; short: string } {
	switch (fidelity) {
		case "provider-request":
			return { label: "Latest provider request captured", short: "Request captured" };
		case "logical-request":
			return { label: "Latest logical input captured", short: "Logical input" };
		case "preflight":
			return { label: "No model call captured yet", short: "Preflight" };
	}
}

class Ids {
	private nextValue = 0;

	next(prefix: string): string {
		this.nextValue += 1;
		return `${prefix}-${this.nextValue}`;
	}
}

function rawBlock(ids: Ids, title: string, text: string, meta: string, open = false): string {
	const id = ids.next("raw");
	return `<details class="raw-block"${open ? " open" : ""}>
	<summary><span class="raw-title">${escapeHtml(title)}</span><span class="raw-meta">${escapeHtml(meta)}</span></summary>
	<div class="raw-content">
		<button class="copy-button" type="button" data-copy-target="${id}">Copy</button>
		<pre id="${id}">${escapeHtml(text)}</pre>
	</div>
</details>`;
}

function sourceLabel(source: SourceSnapshot): string {
	const parts = [source.source, source.scope, source.origin].filter(Boolean);
	return `${parts.join(" / ")} · ${source.path}`;
}

function toolWireValue(tools: ToolSnapshot[]): Serializable[] {
	return tools
		.filter((tool) => tool.active)
		.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		}));
}

function modelLabel(snapshot: AgentLoopSnapshot): string {
	return snapshot.model ? `${snapshot.model.provider}/${snapshot.model.id}` : "No model selected";
}

function percentage(value: number, total: number): number {
	if (total <= 0 || value <= 0) return 0;
	return Math.min(100, (value / total) * 100);
}

function sectionHead(label: string, title: string, intro: string): string {
	return `<div class="section-head">
	<span class="section-no">${escapeHtml(label)}</span>
	<h2>${escapeHtml(title)}</h2>
	<p class="section-intro">${escapeHtml(intro)}</p>
</div>`;
}

function aggregateUsage(turns: TurnSnapshot[]): UsageSnapshot | undefined {
	const metered = turns.filter((turn): turn is TurnSnapshot & { usage: UsageSnapshot } => turn.usage !== undefined);
	if (metered.length === 0) return undefined;
	return metered.reduce<UsageSnapshot>((total, turn) => ({
		input: total.input + turn.usage.input,
		cacheRead: total.cacheRead + turn.usage.cacheRead,
		cacheWrite: total.cacheWrite + turn.usage.cacheWrite,
		output: total.output + turn.usage.output,
		totalTokens: total.totalTokens + turn.usage.totalTokens,
	}), { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0 });
}

function adapterStateNote(snapshot: AgentLoopSnapshot): string {
	const api = snapshot.model?.api.toLowerCase() ?? "";
	if (api.includes("anthropic")) {
		return "With Anthropic Messages, Pi normally supplies the conversation messages needed for each call. Anthropic prompt caching can reuse processing for an unchanged prefix, but that cache is not a Claude conversation Pi can query. Claude.ai history and memory are separate product features.";
	}
	if (api.includes("responses")) {
		return "The OpenAI Responses API can support server-side response or conversation references. Whether this Pi adapter used one is visible in the captured payload; do not infer full resend or remote state from the model name alone.";
	}
	return "Provider APIs differ: some accept a complete message list, while others can accept references to server-side state. The captured payload is the evidence for this run. Prompt caching and provider retention are separate from Pi’s local session state.";
}

function renderTurnTable(snapshot: AgentLoopSnapshot, ids: Ids): string {
	if (snapshot.turns.length === 0) {
		return `<div class="empty-state"><strong>No completed model call was observed</strong><p>Run a prompt, let Pi finish, then export again to include measured input, cache, and output usage.</p></div>`;
	}
	const rows = snapshot.turns.map((turn) => {
		const usage = turn.usage;
		return `<tr>
	<td>Call ${turn.index + 1}<span class="turn-note">${escapeHtml(turn.stopReason ?? "stop reason unknown")} · ${turn.toolCallCount} tool call(s)</span></td>
	<td>${usage ? formatNumber(usage.input) : "—"}</td>
	<td>${usage ? formatNumber(usage.cacheRead) : "—"}</td>
	<td>${usage ? formatNumber(usage.cacheWrite) : "—"}</td>
	<td>${usage ? formatNumber(usage.output) : "—"}</td>
</tr>`;
	}).join("");
	const details = snapshot.turns.map((turn) => {
		const assistant = rawBlock(ids, `Call ${turn.index + 1} · model output`, prettyJson(turn.assistant), `${turn.toolCallCount} tool call(s) · ${turn.stopReason ?? "unknown stop"}`, false);
		const results = turn.toolResults.length > 0
			? rawBlock(ids, `Call ${turn.index + 1} · local tool results`, prettyJson(turn.toolResults), `${turn.toolResults.length} result message(s) · becomes next-call input`, false)
			: "";
		return `${assistant}${results}`;
	}).join("");
	return `<table class="turn-table">
	<thead><tr><th>Observed call</th><th>New input</th><th>Cache read</th><th>Cache write</th><th>Output</th></tr></thead>
	<tbody>${rows}</tbody>
</table>
<div class="assembly-details">${details}</div>`;
}

function renderTools(snapshot: AgentLoopSnapshot, ids: Ids): string {
	const ordered = [...snapshot.tools].sort((left, right) => {
		if (left.active !== right.active) return left.active ? -1 : 1;
		return left.name.localeCompare(right.name);
	});

	if (ordered.length === 0) {
		return `<div class="empty-state"><strong>No tool catalog exposed</strong><p>This runtime did not report any configured tools.</p></div>`;
	}

	return `<div class="tool-list">${ordered.map((tool) => {
		const wireTokens = estimateTokens({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		});
		const promptParts = [
			tool.promptSnippet ? `<p><span class="micro-label">System-prompt snippet</span><br>${escapeHtml(tool.promptSnippet)}</p>` : "",
			tool.promptGuidelines.length > 0
				? `<ul class="guidelines">${tool.promptGuidelines.map((guideline) => `<li>${escapeHtml(guideline)}</li>`).join("")}</ul>`
				: "",
		].join("");
		const schema = rawBlock(ids, `${tool.name} · parameter schema`, prettyJson(tool.parameters), `${wireTokens} est. tokens`, false);
		return `<article class="tool">
	<div class="tool-name">
		<code>${escapeHtml(tool.name)}</code>
		<span class="tool-state${tool.active ? "" : " inactive"}">${tool.active ? "included" : "inactive"}</span>
	</div>
	<div class="tool-description-wrap">
		<p class="tool-description">${escapeHtml(tool.description)}</p>
		<div class="tool-origin">${escapeHtml(sourceLabel(tool.sourceInfo))}</div>${promptParts ? `\n\t\t${promptParts}` : ""}
	</div>
	<div class="tool-token">${tool.active ? `~${formatNumber(wireTokens)} tokens` : "not sent"}<br>request input</div>
	${schema}
</article>`;
	}).join("")}</div>`;
}

function renderResources(snapshot: AgentLoopSnapshot, ids: Ids): string {
	const { options } = snapshot.prompt;
	const readActive = snapshot.tools.some((tool) => tool.active && tool.name === "read");
	const contextFiles = options.contextFiles.length > 0
		? options.contextFiles.map((file) => rawBlock(
			ids,
			file.path,
			file.content,
			`${formatNumber(file.content.length)} chars · ~${formatNumber(estimateTokens(file.content))} tokens`,
			false,
		)).join("")
		: `<div class="empty-state"><strong>No context files</strong><p>No AGENTS.md, CLAUDE.md, or equivalent context file appeared in the structured prompt inputs.</p></div>`;
	const skills = options.skills.length > 0
		? `<div class="skill-list">${options.skills.map((skill) => {
			const status = skill.disableModelInvocation
				? "local command only"
				: readActive ? "metadata included in system prompt" : "metadata not included; read inactive";
			return `<div class="skill-row">
	<code>${escapeHtml(skill.name)}</code>
	<div>
		<p>${escapeHtml(skill.description)}</p>
		<span class="path">${escapeHtml(status)} · ${escapeHtml(skill.filePath)}</span>
	</div>
</div>`;
		}).join("")}</div>`
		: `<div class="empty-state"><strong>No loaded skills</strong><p>The structured prompt inputs contained no skill records.</p></div>`;
	return `<div class="split">
	<div class="resource-card">
		<h3>Context files <span class="resource-count">${options.contextFiles.length}</span></h3>
		<p class="section-intro">Their contents are folded into the effective system prompt, so they travel as input rather than as separate file attachments.</p>
		${contextFiles}
	</div>
	<div class="resource-card">
		<h3>Skill index <span class="resource-count">${options.skills.length}</span></h3>
		<p class="section-intro">Model-visible skills contribute name, description, and path. A full SKILL.md body enters context only after Pi reads it.</p>
		${skills}
	</div>
</div>`;
}

function renderMessages(snapshot: AgentLoopSnapshot, ids: Ids): string {
	if (!snapshot.messages) {
		return `<div class="empty-state"><strong>No request message list captured</strong><p>${escapeHtml(snapshot.capture.note)}</p></div>`;
	}
	if (snapshot.messages.length === 0) {
		return `<div class="empty-state"><strong>The preflight message list is empty</strong><p>After a prompt, this area shows the active branch Pi prepared as model input.</p></div>`;
	}
	return snapshot.messages.map((message, index) => {
		const role = isRecord(message) && typeof message.role === "string" ? message.role : "message";
		return `<article class="message">
	<div class="message-role">${escapeHtml(role)}<span class="message-index">input slot ${String(index).padStart(2, "0")}</span></div>
	<div>${rawBlock(ids, `${role} message`, prettyJson(message), `latest request input · ~${formatNumber(estimateTokens(message))} tokens`, index === 0)}</div>
</article>`;
	}).join("");
}

function renderCommands(snapshot: AgentLoopSnapshot): string {
	if (snapshot.commands.length === 0) {
		return `<div class="empty-state"><strong>No extension, prompt, or skill commands exposed</strong><p>Built-in interactive commands are not part of pi.getCommands(), so they are not listed here.</p></div>`;
	}
	return `<div class="command-list">${snapshot.commands.map((command) => `<div class="command-row">
	<code>/${escapeHtml(command.name)}</code>
	<div>
		<p>${escapeHtml(command.description ?? "No description")}</p>
		<span class="path">${escapeHtml(command.source)} · ${escapeHtml(command.sourceInfo.path)}</span>
	</div>
</div>`).join("")}</div>`;
}

function renderProviderPayload(snapshot: AgentLoopSnapshot, ids: Ids): string {
	if (snapshot.providerPayload !== undefined) {
		return `${rawBlock(
			ids,
			"Provider-specific request payload",
			prettyJson(snapshot.providerPayload),
			`captured ${formatDate(snapshot.capture.latestProviderRequestAt ?? snapshot.generatedAt)}`,
			false,
		)}
<div class="callout warning"><p><strong>Capture boundary:</strong> this is the provider-specific request body observed immediately before transport submission. HTTP authorization headers are intentionally absent, and the provider library may still apply wire-level serialization.</p></div>`;
	}

	const schematic: Serializable = {
		system_or_instructions: snapshot.prompt.effective ? "<effective system prompt shown above>" : "<none>",
		messages_or_input: snapshot.messages ?? ["<active messages will appear here after a model call>"],
		tools: toolWireValue(snapshot.tools),
		model: modelLabel(snapshot),
		note: "Field names and serialization vary by provider API.",
	};
	return `${rawBlock(ids, "Logical request envelope (schematic)", prettyJson(schematic), "not a wire capture", true)}
<div class="callout"><p>No provider payload was observed for this session. The schematic shows the logical ingredients; the provider adapter chooses the final field names and wire format.</p></div>`;
}

function renderAppendAndCustom(snapshot: AgentLoopSnapshot, ids: Ids): string {
	const { options } = snapshot.prompt;
	const blocks: string[] = [];
	if (options.customPrompt !== undefined) {
		blocks.push(rawBlock(ids, "Custom system prompt · replaces Pi default", options.customPrompt, `~${formatNumber(estimateTokens(options.customPrompt))} tokens`, false));
	}
	if (options.appendSystemPrompt !== undefined) {
		blocks.push(rawBlock(ids, "Append channel · APPEND_SYSTEM.md / CLI append flags", options.appendSystemPrompt, `~${formatNumber(estimateTokens(options.appendSystemPrompt))} tokens`, true));
	}
	if (options.promptGuidelines.length > 0) {
		blocks.push(rawBlock(ids, "Tool-contributed prompt guidelines", options.promptGuidelines.map((item) => `- ${item}`).join("\n"), `${options.promptGuidelines.length} bullets`, false));
	}
	if (Object.keys(options.toolSnippets).length > 0) {
		blocks.push(rawBlock(ids, "Tool snippets inserted into Pi's default prompt", prettyJson(options.toolSnippets as Serializable), `${Object.keys(options.toolSnippets).length} snippets`, false));
	}
	return blocks.length > 0 ? blocks.join("") : `<div class="empty-state"><strong>No separate prompt channels exposed</strong><p>The effective system prompt still includes Pi’s generated core instructions and the working directory.</p></div>`;
}

function buildObservableSourceCount(snapshot: AgentLoopSnapshot): number {
	const paths = new Set<string>();
	for (const tool of snapshot.tools) paths.add(tool.sourceInfo.path);
	for (const command of snapshot.commands) paths.add(command.sourceInfo.path);
	for (const skill of snapshot.prompt.options.skills) if (skill.sourceInfo?.path) paths.add(skill.sourceInfo.path);
	return paths.size;
}

export function createAgentLoopReport(snapshot: AgentLoopSnapshot): string {
	const ids = new Ids();
	const activeTools = snapshot.tools.filter((tool) => tool.active);
	const inactiveTools = snapshot.tools.length - activeTools.length;
	const messageValue = snapshot.messages ?? [];
	const activeToolWire = toolWireValue(snapshot.tools);
	const systemTokens = estimateTokens(snapshot.prompt.effective);
	const toolTokens = activeToolWire.length > 0 ? estimateTokens(activeToolWire) : 0;
	const messageTokens = messageValue.length > 0 ? estimateTokens(messageValue) : 0;
	const baselineTokens = systemTokens + toolTokens + messageTokens;
	const injectedSkills = activeTools.some((tool) => tool.name === "read")
		? snapshot.prompt.options.skills.filter((skill) => !skill.disableModelInvocation)
		: [];
	const contextWindow = snapshot.model?.contextWindow ?? 0;
	const baselinePercent = percentage(baselineTokens, contextWindow);
	const fidelity = fidelityContent(snapshot.capture.fidelity);
	const promptMode = snapshot.prompt.options.customPrompt === undefined ? "Pi generated default" : "Custom replacement";
	const observableSources = buildObservableSourceCount(snapshot);
	const title = `How Pi’s agent loop works · ${modelLabel(snapshot)}`;
	const systemSegment = percentage(systemTokens, contextWindow);
	const toolSegment = percentage(toolTokens, contextWindow);
	const messageSegment = percentage(messageTokens, contextWindow);
	const measuredUsage = aggregateUsage(snapshot.turns);
	const usage = measuredUsage ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0 };
	const usageTotal = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
	const toolCallCount = snapshot.turns.reduce((total, turn) => total + turn.toolCallCount, 0);
	const dynamicCss = [
		`.budget-segment.system{width:${systemSegment.toFixed(4)}%}`,
		`.budget-segment.tools{width:${toolSegment.toFixed(4)}%}`,
		`.budget-segment.messages{width:${messageSegment.toFixed(4)}%}`,
		`.usage-part.input{flex:0 0 ${percentage(usage.input, usageTotal).toFixed(4)}%}`,
		`.usage-part.cache-read{flex:0 0 ${percentage(usage.cacheRead, usageTotal).toFixed(4)}%}`,
		`.usage-part.cache-write{flex:0 0 ${percentage(usage.cacheWrite, usageTotal).toFixed(4)}%}`,
		`.usage-part.output{flex:0 0 ${percentage(usage.output, usageTotal).toFixed(4)}%}`,
	].join("");

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta name="color-scheme" content="light">
	<meta name="referrer" content="no-referrer">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
	<title>${escapeHtml(title)}</title>
	<style>${CSS}\n${dynamicCss}</style>
</head>
<body>
<div class="shell">
	<aside class="rail" aria-label="Report navigation">
		<div class="rail-inner">
			<div class="rail-mark">Pi / agent loop</div>
			<div class="rail-title">How a request becomes an agent run</div>
			<p class="rail-subtitle">Big picture first; captured request details second.</p>
			<nav class="nav">
				<a href="#big-picture"><span>Who owns what</span></a>
				<a href="#one-call"><span>One model call</span></a>
				<a href="#sent"><span>Sent each time</span></a>
				<a href="#payload"><span>Captured payload</span></a>
				<a href="#tool-loop"><span>Automatic tool loop</span></a>
				<a href="#cache"><span>Input, cache, output</span></a>
				<a href="#budget"><span>Context window</span></a>
				<a href="#details"><span>Request details</span></a>
				<a href="#local"><span>Stays local</span></a>
			</nav>
			<div class="rail-actions">
				<button id="expand-all" class="control primary" type="button">Expand captured data</button>
				<button id="collapse-all" class="control" type="button">Collapse captured data</button>
				<button id="print-report" class="control" type="button">Print or save PDF</button>
			</div>
			<p class="rail-confidential">Contains prompts, project context, messages, schemas, model output, and tool results. Review before sharing.</p>
		</div>
	</aside>

	<main class="main">
		<header class="hero" id="top">
			<div class="hero-inner">
				<div class="kicker">${escapeHtml(modelLabel(snapshot))} · ${escapeHtml(fidelity.short)}</div>
				<h1>Pi is a loop around repeated model calls.</h1>
				<div class="hero-deck">
					<p>Pi keeps the working session, builds an API request, receives model output, and decides what happens next. If that output contains a tool call, Pi runs the tool locally, adds the result to context, and starts the next model call automatically.</p>
					<div class="capture-card">
						<strong>${escapeHtml(fidelity.label)}</strong>
						<p>${escapeHtml(snapshot.capture.note)}</p>
					</div>
				</div>
				<div class="layer-map" role="group" aria-label="The three layers in a Pi agent run">
					<div class="layer"><b>Local process</b><h2>Pi process</h2><p>Owns the session tree, UI, tool implementations, and decision to make another call.</p></div>
					<div class="layer request"><b>Per model call</b><h2>API request</h2><p>Carries instructions, active messages, tool definitions, model settings, and any images.</p></div>
					<div class="layer"><b>Remote service</b><h2>Provider and model</h2><p>Process this request and stream output. Caching and retention are provider concerns, not Pi’s session store.</p></div>
				</div>
			</div>
		</header>

		<section class="meta-strip" aria-label="Capture metadata">
			<div class="meta-cell"><span>Capture</span><strong>${escapeHtml(fidelity.label)}</strong></div>
			<div class="meta-cell"><span>Model API</span><strong>${escapeHtml(snapshot.model?.api ?? "not selected")}<br>${escapeHtml(snapshot.model?.thinkingLevel ?? "thinking unknown")}</strong></div>
			<div class="meta-cell"><span>Latest run</span><strong>${snapshot.capture.providerRequestCount} provider request(s)<br>${snapshot.turns.length} completed call(s)</strong></div>
			<div class="meta-cell"><span>Generated</span><strong>${escapeHtml(formatDate(snapshot.generatedAt))}</strong></div>
		</section>

		<section class="section" id="big-picture">
			${sectionHead("Mental model", "A chat product, an API, and a model are different layers", "Pi is the agent. The provider hosts the model. A consumer chat app such as Claude.ai is another client with its own history and memory features.")}
			<div class="layer-note"><b>Pi remembers locally</b><p>The session JSONL, active branch, compaction summaries, queued messages, and tool results live in the Pi process or its files. Pi uses that state to prepare the next call.</p></div>
			<div class="layer-note"><b>The API handles one request</b><p>Pi opens a streaming request with a provider-specific body. During that call the provider processes input and streams output. Pi does not rely on one continuously connected model process between calls.</p></div>
			<div class="layer-note"><b>The model sees context</b><p>The model can respond only from the input available to that invocation. It does not directly inspect Pi’s session file, terminal, tool source code, or other branches.</p></div>
			<div class="callout"><p><strong>Adapter-specific reality:</strong> ${escapeHtml(adapterStateNote(snapshot))}</p></div>
		</section>

		<section class="section" id="one-call">
			${sectionHead("Ordered flow", "What happens during one Pi model call", "The provider column begins only when Pi has finished assembling a request. The same sequence repeats after a tool result.")}
			<div class="trace-frame">
				<div class="trace-head"><div>Step</div><div>Pi process · local</div><div class="provider-col">Provider service · remote</div></div>
				<div class="trace-row"><div class="trace-step">1</div><div class="trace-local"><h3>A prompt starts or continues the run</h3><p>Pi accepts user input, a queued message, or extension-injected input. Slash commands handled locally stop here and never become model input.</p><span class="evidence explained">Pi behavior</span></div><div class="trace-provider empty">Not involved yet</div></div>
				<div class="trace-row"><div class="trace-step">2</div><div class="trace-local"><h3>Pi builds the active message list</h3><p>It projects the current session branch, respects compaction, and includes eligible user, assistant, and tool-result messages.</p><span class="evidence">${messageValue.length} message(s) captured</span></div><div class="trace-provider empty">No request yet</div></div>
				<div class="trace-row"><div class="trace-step">3</div><div class="trace-local"><h3>Pi adds instructions and tool contracts</h3><p>The effective system prompt is instruction text. Each active tool contributes a name, description, and JSON parameter schema in a separate API field.</p><span class="evidence">${activeTools.length} active tool(s)</span></div><div class="trace-provider empty">No request yet</div></div>
				<div class="trace-row"><div class="trace-step">4</div><div class="trace-local"><h3>The adapter creates one provider-specific request</h3><p>The ${escapeHtml(snapshot.model?.api ?? "selected")} adapter maps Pi’s logical input to its API shape and opens a streaming call.</p><span class="evidence">${snapshot.capture.providerRequestCount} request(s) in latest run</span></div><div class="trace-provider"><h3 class="boundary-label">The provider receives the request</h3><p>Authentication is handled at the transport layer. The model-facing input comes from the instructions, messages, tool schemas, images, and controls in the request.</p></div></div>
				<div class="trace-row"><div class="trace-step">5</div><div class="trace-local"><h3>Pi consumes streamed output</h3><p>Text, reasoning, and structured tool calls arrive as output events. Pi assembles them into an assistant message.</p><span class="evidence">${snapshot.turns.length} completed call(s)</span></div><div class="trace-provider"><h3>The model generates new output</h3><p>The provider may reuse cached input processing, then the model generates output token by token. Output is not a prompt-cache hit.</p></div></div>
				<div class="trace-row"><div class="trace-step">6</div><div class="trace-local"><h3>Pi checks the output for tool calls</h3><p>A tool call is structured model output containing a tool name and arguments. Pi—not the provider—validates and runs the registered tool, then records its result.</p><span class="evidence">${toolCallCount} tool call(s) observed</span></div><div class="trace-provider"><h3>The current model call has ended</h3><p>The provider does not execute Pi’s local tool and does not automatically receive the result.</p></div></div>
				<div class="trace-row"><div class="trace-step">7</div><div class="trace-local"><h3>Tool result: call again. No tool call: finish.</h3><p>After a tool result, Pi automatically builds another request. The earlier assistant tool call and the new tool result are now input messages for that next call.</p><span class="evidence explained">Agent-loop decision</span></div><div class="trace-provider"><h3>A later call is a new request</h3><p>Its repeated prefix may qualify for cache reuse, but the old output is present as input context rather than remembered by a running model instance.</p></div></div>
			</div>
		</section>

		<section class="section" id="sent">
			${sectionHead("Request contents", "What Pi supplies on every model call", "“Every time” means every logical model invocation. Provider adapters may encode these ingredients differently, and some APIs can reference server-side state.")}
			<table class="manifest">
				<thead><tr><th>Part</th><th>Why it is there</th><th>Where it goes</th></tr></thead>
				<tbody>
					<tr><td>Effective system prompt</td><td>Defines the agent role, operating rules, append instructions, project context, visible skill index, and working directory.</td><td><span class="sent-yes">model input</span></td></tr>
					<tr><td>Active message history</td><td>Gives this invocation the current conversation branch: user text, prior assistant output, tool calls, and tool results after compaction.</td><td><span class="sent-yes">model input</span></td></tr>
					<tr><td>Active tool definitions</td><td>Tells the model which structured calls it may emit and which argument shape each tool accepts. Tool implementation code is not included.</td><td><span class="sent-yes">model input</span></td></tr>
					<tr><td>Model and generation controls</td><td>Selects the model and controls output or reasoning behavior. These influence generation but are not conversation text.</td><td><span class="sent-yes">API control</span></td></tr>
					<tr><td>Images and provider fields</td><td>Images in eligible messages and adapter-specific fields are serialized according to the selected API.</td><td><span class="sent-yes">request body</span></td></tr>
					<tr><td>API credentials and headers</td><td>Authenticate Pi to the provider service. They are transport metadata and are not inserted into the model’s context window.</td><td><span class="sent-local">provider transport</span></td></tr>
				</tbody>
			</table>
		</section>

		<section class="section" id="payload">
			${sectionHead("Captured evidence", "The latest request body", "This is the closest answer to “show me everything Pi sent.” It is provider-specific; compare it with the stable logical ingredients above.")}
			<div class="payload-layout">
				<div>${renderProviderPayload(snapshot, ids)}</div>
				<aside class="payload-aside" aria-label="How to read the captured payload">
					<h3>How to read this</h3>
					<p><strong>${escapeHtml(fidelity.label)}.</strong> ${escapeHtml(snapshot.capture.note)}</p>
					<p>Authorization headers are omitted. Fields such as session file, slash commands, and tool source code should not appear unless some instruction or extension explicitly copied them into model input.</p>
					<p>Model: <code>${escapeHtml(modelLabel(snapshot))}</code></p>
				</aside>
			</div>
		</section>

		<section class="section" id="tool-loop">
			${sectionHead("Automatic continuation", "A tool call in output causes the next request", "The model asks; Pi executes. After the result is available, Pi continues without waiting for another Enter key.")}
			<div class="call-ledger">
				<div class="call-row"><div class="call-id">Model call 1</div><div class="call-context"><span class="segment cacheable">system instructions</span><span class="segment cacheable">active tool schemas</span><span class="segment new">user message</span></div><div class="call-result"><strong>Output</strong>Assistant text and/or <code>toolCall{name, arguments}</code></div></div>
				<div class="local-action"><strong>Pi local action:</strong> find the named tool → validate arguments → execute it → append the tool result to the session.</div>
				<div class="call-row"><div class="call-id">Model call 2</div><div class="call-context"><span class="segment cacheable">same earlier prefix</span><span class="segment new">assistant tool call</span><span class="segment new">tool result</span></div><div class="call-result"><strong>Output</strong>Final answer or another tool call</div></div>
			</div>
			<div class="callout"><p><strong>The key transition:</strong> model output from call 1 becomes model input on call 2. The tool result is not pushed into an open model conversation; Pi starts a new provider request containing it.</p></div>
		</section>

		<section class="section" id="cache">
			${sectionHead("Token accounting", "New input, cached input, and output are different work", "Pi normalizes provider usage into uncached input, cache reads, cache writes, and generated output when the API reports them.")}
			<div class="equation">model input = new input + cache-read input + cache-write input · output is generated separately</div>
			<div class="cache-layout">
				<div class="usage-panel">
					<h3>${measuredUsage ? "Measured across the latest agent run" : "No measured usage captured yet"}</h3>
					<p>${measuredUsage ? `${snapshot.turns.length} completed model call(s); categories below are summed across them.` : "Run a prompt and export after Pi settles to populate these values."}</p>
					<div class="usage-bar" role="img" aria-label="${formatNumber(usage.input)} new input tokens, ${formatNumber(usage.cacheRead)} cache read tokens, ${formatNumber(usage.cacheWrite)} cache write tokens, and ${formatNumber(usage.output)} output tokens">
						<div class="usage-part input${usage.input === 0 ? " zero" : ""}" title="New input"></div>
						<div class="usage-part cache-read${usage.cacheRead === 0 ? " zero" : ""}" title="Cache read"></div>
						<div class="usage-part cache-write${usage.cacheWrite === 0 ? " zero" : ""}" title="Cache write"></div>
						<div class="usage-part output${usage.output === 0 ? " zero" : ""}" title="Output"></div>
					</div>
					<div class="usage-grid">
						<div class="usage-stat input"><span>New input</span><strong>${formatNumber(usage.input)}</strong></div>
						<div class="usage-stat cache-read"><span>Cached input read</span><strong>${formatNumber(usage.cacheRead)}</strong></div>
						<div class="usage-stat cache-write"><span>Input written to cache</span><strong>${formatNumber(usage.cacheWrite)}</strong></div>
						<div class="usage-stat output"><span>Generated output</span><strong>${formatNumber(usage.output)}</strong></div>
					</div>
				</div>
				<dl class="cache-definitions">
					<dt>New input</dt><dd>Input tokens the provider processed without a reusable cache hit.</dd>
					<dt>Cached input</dt><dd>The same request prefix is still logically supplied and still occupies context. The provider reuses earlier prefix computation, usually reducing latency or price.</dd>
					<dt>Cache write</dt><dd>Some providers report input tokens used to create or refresh a reusable prefix. This is not yet a cache hit.</dd>
					<dt>Output</dt><dd>Tokens the model must generate for this call. They cannot be prompt-cache reads because they do not exist before generation.</dd>
					<dt>A hit is not guaranteed</dt><dd>Repeated text can still be billed as new input when the prefix is too short, changed, expired, unsupported, or outside a provider’s cache rules. <code>cacheRead: 0</code> does not mean Pi omitted the history.</dd>
				</dl>
			</div>
			<div class="callout warning"><p><strong>Why output has no prompt cache:</strong> prompt caching accelerates reading repeated input. Output is newly sampled or decoded token by token. On the next call, that previous output moves into the input history and may then fall inside a cacheable prefix. A whole-response cache would be a different application feature, not prompt caching.</p></div>
			${renderTurnTable(snapshot, ids)}
		</section>

		<section class="section" id="budget">
			${sectionHead("Finite working set", "Cached input still uses the context window", "Caching can reduce repeated computation or cost. It does not give the model a larger working window and does not remove cached tokens from context.")}
			<div class="equation">system instructions + active tool definitions + active messages + generated output ≤ context window</div>
			<div class="budget-frame">
				<div class="budget-ruler"><span>0 tokens</span><span>${contextWindow > 0 ? `${formatNumber(contextWindow)} token model window` : "window unknown"}</span></div>
				<div class="budget-bar" role="img" aria-label="Estimated request input uses ${baselinePercent.toFixed(2)} percent of the context window">
					<div class="budget-segment system${systemTokens === 0 ? " zero" : ""}" title="System prompt"></div>
					<div class="budget-segment tools${toolTokens === 0 ? " zero" : ""}" title="Tool definitions"></div>
					<div class="budget-segment messages${messageTokens === 0 ? " zero" : ""}" title="Messages"></div>
					<div class="budget-empty" title="Remaining context capacity"></div>
				</div>
				<div class="budget-legend">
					<div class="legend-item system"><span>System prompt</span><strong>~${formatNumber(systemTokens)}</strong></div>
					<div class="legend-item tools"><span>Active tool definitions</span><strong>~${formatNumber(toolTokens)}</strong></div>
					<div class="legend-item messages"><span>Latest messages</span><strong>~${formatNumber(messageTokens)}</strong></div>
					<div class="legend-item"><span>Estimated input total</span><strong>~${formatNumber(baselineTokens)} · ${contextWindow > 0 ? `${baselinePercent.toFixed(2)}%` : "n/a"}</strong></div>
				</div>
			</div>
			<div class="fact-grid">
				<div class="fact"><strong>Output needs room too</strong><p>The configured maximum output is ${snapshot.model ? `${formatNumber(snapshot.model.maxTokens)} tokens` : "unknown"}. Providers enforce the exact input/output limit for the selected model.</p></div>
				<div class="fact"><strong>Tool runs grow history</strong><p>Assistant tool calls and tool results become input on later calls. That is why an agent run can consume more context without another user message.</p></div>
				<div class="fact"><strong>These are estimates</strong><p>The bar uses characters ÷ 4. Images, provider wrappers, tokenizers, and protocol details make billable usage different; measured usage above is stronger evidence.</p></div>
			</div>
		</section>

		<section class="section" id="details">
			${sectionHead("Captured request", "Inspect the actual ingredients", "These sections expose the latest effective instructions, active message list, tool contracts, and prompt resources used to explain the request.")}
			<div class="detail-group">
				<h3>Effective system prompt</h3>
				<p>The provider receives this complete instruction string, not the source files as independently addressable memory.</p>
				<div class="prompt-summary">
					<div class="prompt-stat"><span>Prompt mode</span><strong>${escapeHtml(promptMode)}</strong></div>
					<div class="prompt-stat"><span>Characters</span><strong>${formatNumber(snapshot.prompt.effective.length)}</strong></div>
					<div class="prompt-stat"><span>Approx. tokens</span><strong>~${formatNumber(systemTokens)}</strong></div>
				</div>
				${rawBlock(ids, "Effective system prompt", snapshot.prompt.effective, "request instructions · full text", true)}
				<div class="assembly">
					<div class="assembly-row"><span class="assembly-index">1</span><h3>Core instructions</h3><p>${escapeHtml(promptMode)}; Pi’s default can include selected tool snippets and operating guidelines.</p><span class="lane">system text</span></div>
					<div class="assembly-row"><span class="assembly-index">2</span><h3>Append instructions</h3><p>APPEND_SYSTEM.md and CLI append text are placed after the core or replacement prompt when configured.</p><span class="lane">system text</span></div>
					<div class="assembly-row"><span class="assembly-index">3</span><h3>Project context</h3><p>${snapshot.prompt.options.contextFiles.length} context file(s) contribute their full body and source path.</p><span class="lane">system text</span></div>
					<div class="assembly-row"><span class="assembly-index">4</span><h3>Skill index</h3><p>${injectedSkills.length} model-visible descriptor(s) contribute name, description, and path; full skill bodies are read on demand.</p><span class="lane">system text</span></div>
					<div class="assembly-row"><span class="assembly-index">5</span><h3>Working directory</h3><p><code>${escapeHtml(snapshot.session.cwd)}</code> gives local path operations an explicit anchor.</p><span class="lane">system text</span></div>
				</div>
				<div class="assembly-details">${renderAppendAndCustom(snapshot, ids)}</div>
			</div>
			<div class="detail-group">
				<h3>Latest active message input</h3>
				<p>This is the branch Pi prepared for the latest captured model call. Previous assistant output and tool results appear here because they become later-call input.</p>
				${renderMessages(snapshot, ids)}
			</div>
			<div class="detail-group">
				<h3>Tool definitions</h3>
				<p>${activeTools.length} active definition(s) were available to the model; ${inactiveTools} configured definition(s) stayed local. The schema is sent, not the implementation.</p>
				${renderTools(snapshot, ids)}
			</div>
			<div class="detail-group">
				<h3>Files and skill metadata</h3>
				<p>These explain where parts of the effective system prompt came from.</p>
				${renderResources(snapshot, ids)}
			</div>
		</section>

		<section class="section" id="local">
			${sectionHead("Boundary check", "What stays in Pi unless explicitly copied into context", "Local state can influence how Pi constructs a request without being model input itself.")}
			<div class="not-sent-grid">
				<div class="not-sent"><b>Pi control</b><h3>Slash commands</h3><p>Commands are handled by the harness. They are not tool definitions and do not go to the model merely because they exist.</p></div>
				<div class="not-sent"><b>Executable code</b><h3>Tool implementations</h3><p>The model gets a tool’s contract. The TypeScript implementation and local process are not sent with that contract.</p></div>
				<div class="not-sent"><b>Session storage</b><h3>Other branches</h3><p>Pi keeps a session tree. Only the active, compaction-aware branch is projected into the current message list.</p></div>
				<div class="not-sent"><b>Tool catalog</b><h3>Inactive tools</h3><p>${inactiveTools} inactive tool(s) are shown in this report but are not normally included in the captured request.</p></div>
				<div class="not-sent"><b>On disk</b><h3>Unread skill bodies</h3><p>A skill’s full instructions enter context only after a read operation loads them; metadata alone does not include the body.</p></div>
				<div class="not-sent"><b>Interface state</b><h3>TUI and extension internals</h3><p>Widgets, command registries, and private extension state stay local unless an extension deliberately injects their contents.</p></div>
			</div>
			<div class="resource-card local-commands">
				<h3>Observable local commands <span class="resource-count">${snapshot.commands.length}</span></h3>
				<p class="section-intro">This list is included to make the boundary concrete: these are Pi controls, not entries in the model request.</p>
				${renderCommands(snapshot)}
			</div>
		</section>

		<footer class="footer">
			<div class="footer-grid">
				<div><h2>Use the captured payload as evidence; use the diagrams as explanation.</h2><p>This report does not audit provider retention or prove that a provider discarded data. It explains what Pi assembled, what the adapter exposed, and how the local tool loop continued.</p></div>
				<div class="footer-meta">Generated ${escapeHtml(formatDate(snapshot.generatedAt))}<br>Schema ${snapshot.schemaVersion}<br>${escapeHtml(fidelity.short)}<br>${observableSources} observable source path(s)<br>Standalone · no network requests</div>
			</div>
		</footer>
	</main>
</div>
<script>${JS}</script>
</body>
</html>`;
}
