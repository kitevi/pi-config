import { normalizedEffectPath, type PathEffect } from "./shell-analysis.ts";

/** Mutable state for one installed permission-gate extension instance. */
const PERMISSION_GATE_DETAILS = "permissionGate";

type RecordValue = Record<string, unknown>;
const asRecord = (value: unknown): RecordValue | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RecordValue) : undefined;

export const detailsWithWrittenPaths = (details: unknown, writtenPaths: string[]) => ({
	...(asRecord(details) ?? {}),
	[PERMISSION_GATE_DETAILS]: { writtenPaths },
});

const writtenPathsFromDetails = (details: unknown) => {
	const metadata = asRecord(asRecord(details)?.[PERMISSION_GATE_DETAILS]);
	const paths = metadata?.writtenPaths;
	return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : [];
};

const detailsFromToolResultEntry = (entry: unknown) => {
	const message = asRecord(asRecord(entry)?.message);
	return message?.role === "toolResult" ? message.details : undefined;
};

export class PermissionGateState {
	readonly #writtenPaths = new Set<string>();
	readonly #pendingWrites = new Map<string, Set<string>>();
	readonly #ruleHits = new Map<string, number>();

	hasWrittenPath(effect: PathEffect) {
		const path = normalizedEffectPath(effect);
		if (this.#writtenPaths.has(path)) return true;
		return [...this.#pendingWrites.values()].some((paths) => paths.has(path));
	}

	stageWrites(toolCallId: string, effects: PathEffect[]) {
		const paths = new Set(effects.map(normalizedEffectPath));
		if (paths.size > 0) this.#pendingWrites.set(toolCallId, paths);
	}

	completeWrites(toolCallId: string, succeeded: boolean) {
		const paths = this.#pendingWrites.get(toolCallId);
		this.#pendingWrites.delete(toolCallId);
		if (!succeeded || !paths) return [];
		for (const path of paths) this.#writtenPaths.add(path);
		return [...paths];
	}

	clearPendingWrites() {
		this.#pendingWrites.clear();
	}

	resetRuleHits() {
		this.#ruleHits.clear();
	}

	noteRuleHits(ids: string[]) {
		let highest = 0;
		for (const id of ids) {
			const count = (this.#ruleHits.get(id) ?? 0) + 1;
			this.#ruleHits.set(id, count);
			highest = Math.max(highest, count);
		}
		return highest;
	}

	restoreFromBranch(entries: unknown[]) {
		this.reset();
		for (const entry of entries) {
			for (const path of writtenPathsFromDetails(detailsFromToolResultEntry(entry))) this.#writtenPaths.add(path);
		}
	}

	reset() {
		this.#writtenPaths.clear();
		this.#pendingWrites.clear();
		this.resetRuleHits();
	}
}
