import { createIdeExtension } from "../extensions/ide/index.js";
import { describe, it } from "vitest";
import { assert } from "vitest";

type Position = { line: number; character: number };
type Capture = { filePath: string; dirty: boolean; start: Position; end: Position };
type CommandHandler = (args: unknown, ctx: Record<string, unknown>) => Promise<void>;

function createMockPi() {
	const commands = new Map<string, { handler: CommandHandler }>();
	return {
		registerCommand: (
			name: string,
			options: { handler: CommandHandler },
		) => {
			commands.set(name, options);
		},
		commands,
	};
}

type MockContext = {
	cwd: string;
	ui: {
		pasteToEditor: (text: string) => void;
		notify: (text: string, level: string) => void;
	};
	pasted: string[];
	notifications: Array<{ text: string; level: string }>;
};

function createMockContext(cwd = "/workspace"): MockContext {
	const pasted: string[] = [];
	const notifications: Array<{ text: string; level: string }> = [];
	return {
		cwd,
		pasted,
		notifications,
		ui: {
			pasteToEditor: (text: string) => {
				pasted.push(text);
			},
			notify: (text: string, level: string) => {
				notifications.push({ text, level });
			},
		},
	};
}

function register(
	adapters: {
		requestSelection?: () => Promise<Capture>;
		installCompanion?: () => Promise<void>;
	} = {},
) {
	const pi = createMockPi();
	createIdeExtension(adapters)(pi as never);
	return pi;
}

const SESSION_TS: Capture = {
	filePath: "/workspace/src/auth/session.ts",
	dirty: false,
	start: { line: 9, character: 0 },
	end: { line: 15, character: 0 },
};

void describe("ide", () => {
	void it("registers exactly the ide and ide-install commands", () => {
		const pi = register();
		assert.deepEqual([...pi.commands.keys()].sort(), ["ide", "ide-install"]);
	});

	void it("inserts the expected relative file/range reference", async () => {
		const pi = register({ requestSelection: async () => SESSION_TS });
		const ctx = createMockContext();
		await pi.commands.get("ide")!.handler(null, ctx);

		assert.deepEqual(ctx.pasted, [
			"Read `src/auth/session.ts`, lines 10–15 (selection 10:1–16:1). ",
		]);
		assert.deepEqual(ctx.notifications, []);
	});

	void it("includes the end line when the exclusive end position is mid-line", async () => {
		const pi = register({
			requestSelection: async () => ({ ...SESSION_TS, end: { line: 15, character: 8 } }),
		});
		const ctx = createMockContext();
		await pi.commands.get("ide")!.handler(null, ctx);

		assert.deepEqual(ctx.pasted, [
			"Read `src/auth/session.ts`, lines 10–16 (selection 10:1–16:9). ",
		]);
	});

	void it("uses a single line for a selection contained in one line", async () => {
		const pi = register({
			requestSelection: async () => ({
				filePath: "/workspace/src/auth/session.ts",
				dirty: false,
				start: { line: 4, character: 2 },
				end: { line: 4, character: 10 },
			}),
		});
		const ctx = createMockContext();
		await pi.commands.get("ide")!.handler(null, ctx);

		assert.deepEqual(ctx.pasted, [
			"Read `src/auth/session.ts`, line 5 (selection 5:3–5:11). ",
		]);
	});

	void it("keeps a usable absolute path when the file is outside the cwd", async () => {
		const pi = register({
			requestSelection: async () => ({
				...SESSION_TS,
				filePath: "/elsewhere/lib/util.ts",
			}),
		});
		const ctx = createMockContext();
		await pi.commands.get("ide")!.handler(null, ctx);

		assert.deepEqual(ctx.pasted, [
			"Read `/elsewhere/lib/util.ts`, lines 10–15 (selection 10:1–16:1). ",
		]);
	});

	void it("warns when the document is dirty", async () => {
		const pi = register({
			requestSelection: async () => ({ ...SESSION_TS, dirty: true }),
		});
		const ctx = createMockContext();
		await pi.commands.get("ide")!.handler(null, ctx);

		assert.equal(ctx.pasted.length, 1);
		assert.deepEqual(ctx.notifications, [
			{
				text: "VS Code has unsaved changes; the model will read the saved file.",
				level: "warning",
			},
		]);
	});

	void it("emits an error and leaves the editor unchanged on capture failure", async () => {
		const pi = register({
			requestSelection: async () => {
				throw new Error("No text is selected in VS Code");
			},
		});
		const ctx = createMockContext();
		await pi.commands.get("ide")!.handler(null, ctx);

		assert.deepEqual(ctx.pasted, []);
		assert.deepEqual(ctx.notifications, [
			{ text: "No text is selected in VS Code", level: "error" },
		]);
	});
});

void describe("ide-install", () => {
	void it("invokes the injected installer once and emits success", async () => {
		let calls = 0;
		const installCompanion = async () => {
			calls += 1;
		};
		const pi = register({ installCompanion });
		const ctx = createMockContext();
		await pi.commands.get("ide-install")!.handler(null, ctx);

		assert.equal(calls, 1);
		assert.deepEqual(ctx.notifications, [
			{
				text: "Installed pi-ide-selection. Reload the VS Code window if /ide does not respond.",
				level: "info",
			},
		]);
	});

	void it("emits an error and never success when installation fails", async () => {
		const installCompanion = async () => {
			throw new Error("Failed to install the VS Code companion (code exited 1)");
		};
		const pi = register({ installCompanion });
		const ctx = createMockContext();
		await pi.commands.get("ide-install")!.handler(null, ctx);

		assert.deepEqual(ctx.notifications, [
			{
				text: "Failed to install the VS Code companion (code exited 1)",
				level: "error",
			},
		]);
	});
});
