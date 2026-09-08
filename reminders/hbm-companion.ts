/**
 * Find HBM companions in Maven resources, checking the matching package first
 * and then its parents. Sinfomar's nested logging entities keep their mappings
 * in the parent entities directory rather than mirroring the Java package.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

type ReminderArgs = {
	event: {
		toolName?: string;
		isError?: boolean;
		input?: { path?: string };
	};
	ctx?: { cwd?: string };
};

const companionHbmPath = ({ event, ctx }: ReminderArgs): string | null => {
	if (event.toolName !== "read" || event.isError) return null;
	const rawPath = event.input?.path;
	if (!rawPath?.endsWith(".java")) return null;

	const javaPath = path.resolve(ctx?.cwd ?? process.cwd(), rawPath);
	const sourceMarker = `${path.sep}src${path.sep}main${path.sep}java${path.sep}`;
	const sourceIndex = javaPath.lastIndexOf(sourceMarker);
	if (sourceIndex === -1) return null;

	const resourceRoot = path.join(javaPath.slice(0, sourceIndex), "src", "main", "resources");
	const packagePath = path.dirname(javaPath.slice(sourceIndex + sourceMarker.length));
	const mappingName = `${path.basename(javaPath, ".java")}.hbm.xml`;
	let directory = path.join(resourceRoot, packagePath);

	while (true) {
		const candidate = path.join(directory, mappingName);
		try {
			if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
		} catch {
			// An inaccessible mapping should not interrupt a successful Java read.
		}
		if (directory === resourceRoot) return null;
		directory = path.dirname(directory);
	}
};

export default function (_pi: ExtensionAPI) {
	const reminded = new Set<string>();

	return {
		on: "tool_result",
		when: (args: ReminderArgs) => {
			const mapping = companionHbmPath(args);
			if (!mapping || reminded.has(mapping)) return false;
			reminded.add(mapping);
			return true;
		},
		message: (args: ReminderArgs) => {
			const mapping = companionHbmPath(args);
			const relative = mapping ? path.relative(args.ctx?.cwd ?? process.cwd(), mapping) : "";
			const outside = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
			const display = mapping ? `\`${outside ? mapping : relative}\`` : "the companion HBM file";
			return `Read the companion Hibernate mapping ${display} before reasoning about this entity's persistence behavior; it defines table/column mappings, relationships, fetching, cascades, filters, and ordering.`;
		},
	};
}
