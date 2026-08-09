import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { createIdeExtension } from "../extensions/ide/index.js";

interface Position {
	line: number;
	character: number;
}

interface CaptureSuccess {
	version: 1;
	requestId: string;
	ok: true;
	filePath: string;
	dirty: boolean;
	start: Position;
	end: Position;
}

interface CaptureFailure {
	version: 1;
	requestId: string;
	ok: false;
	error: string;
}

type CaptureResult = CaptureSuccess | CaptureFailure;
type RequestSelection = () => Promise<CaptureResult>;
type InstallCompanion = () => Promise<void>;

const REQUEST_ID = "9b2e7f5a-1c4d-4e8f-9a6b-3d2c1e0f8a77";

/** The spec's worked example: zero-based end-exclusive selection. */
const sessionSelection: CaptureSuccess = {
	version: 1,
	requestId: REQUEST_ID,
	ok: true,
	filePath: "/workspace/src/auth/session.ts",
	dirty: false,
	start: { line: 9, character: 0 },
	end: { line: 15, character: 0 },
};

/** Fake Pi API capturing registered commands; handlers get a fake command ctx. */
function createHarness(options: {
	requestSelection?: RequestSelection;
	installCompanion?: InstallCompanion;
} = {}) {
	const commands = new Map<string, { description: string; handler: (args: unknown, ctx: unknown) => Promise<void> }>();
	const pastes: string[] = [];
	const setEditorTexts: string[] = [];
	const notifications: Array<{ message: string; type: string }> = [];
	let sendUserMessageCalls = 0;

	const pi = {
		registerCommand: (name: string, command: { description: string; handler: (args: unknown, ctx: unknown) => Promise<void> }) => {
			commands.set(name, command);
		},
		sendUserMessage: () => {
			sendUserMessageCalls += 1;
		},
	};
	const ctx = {
		cwd: "/workspace",
		ui: {
			pasteToEditor: (text: string) => {
				pastes.push(text);
			},
			setEditorText: (text: string) => {
				setEditorTexts.push(text);
			},
			notify: (message: string, type: string = "info") => {
				notifications.push({ message, type });
			},
		},
	};

	const plugin = createIdeExtension({
		requestSelection: options.requestSelection,
		installCompanion: options.installCompanion,
	});
	plugin(pi as never);

	return {
		commands,
		pastes,
		setEditorTexts,
		notifications,
		get sendUserMessageCalls() {
			return sendUserMessageCalls;
		},
		run: async (name: string) => {
			await commands.get(name)!.handler(undefined, ctx);
		},
	};
}

void describe("ide extension commands", () => {
	void it("registers exactly /ide and /ide-install and inserts the expected relative file/range reference", async () => {
		const harness = createHarness({ requestSelection: async () => sessionSelection });

		assert.deepEqual([...harness.commands.keys()], ["ide", "ide-install"]);
		await harness.run("ide");

		assert.deepEqual(harness.pastes, ["Read `src/auth/session.ts`, lines 10–15 (selection 10:1–16:1)."]);
		assert.deepEqual(harness.setEditorTexts, []);
		assert.equal(harness.sendUserMessageCalls, 0);
		assert.deepEqual(harness.notifications, []);
	});

	void it("excludes the unselected final line when a multi-line selection ends at column zero", async () => {
		const harness = createHarness({
			requestSelection: async () => ({
				...sessionSelection,
				start: { line: 4, character: 0 },
				end: { line: 8, character: 0 },
			}),
		});

		await harness.run("ide");

		assert.deepEqual(harness.pastes, ["Read `src/auth/session.ts`, lines 5–8 (selection 5:1–9:1)."]);
	});

	void it("keeps the final line in the readable range when the end is mid-line", async () => {
		const harness = createHarness({
			requestSelection: async () => ({
				...sessionSelection,
				start: { line: 4, character: 0 },
				end: { line: 8, character: 3 },
			}),
		});

		await harness.run("ide");

		assert.deepEqual(harness.pastes, ["Read `src/auth/session.ts`, lines 5–9 (selection 5:1–9:4)."]);
	});

	void it("warns when the document is dirty and still inserts the reference", async () => {
		const harness = createHarness({
			requestSelection: async () => ({ ...sessionSelection, dirty: true }),
		});

		await harness.run("ide");

		assert.deepEqual(harness.pastes, ["Read `src/auth/session.ts`, lines 10–15 (selection 10:1–16:1)."]);
		assert.deepEqual(harness.notifications, [
			{ message: "VS Code has unsaved changes; the model will read the saved file.", type: "warning" },
		]);
	});

	void it("reports a capture error and leaves the editor unchanged", async () => {
		const harness = createHarness({
			requestSelection: async () => ({ version: 1, requestId: REQUEST_ID, ok: false, error: "No text is selected in VS Code" }),
		});

		await harness.run("ide");

		assert.deepEqual(harness.pastes, []);
		assert.deepEqual(harness.setEditorTexts, []);
		assert.equal(harness.sendUserMessageCalls, 0);
		assert.deepEqual(harness.notifications, [{ message: "No text is selected in VS Code", type: "error" }]);
	});

	void it("turns adapter exceptions into error notifications without touching the editor", async () => {
		const harness = createHarness({
			requestSelection: async () => {
				throw new Error("Timed out waiting for VS Code. Run /ide-install and reload the VS Code window.");
			},
		});

		await harness.run("ide");

		assert.deepEqual(harness.pastes, []);
		assert.deepEqual(harness.setEditorTexts, []);
		assert.deepEqual(harness.notifications, [
			{ message: "Failed to capture VS Code selection: Timed out waiting for VS Code. Run /ide-install and reload the VS Code window.", type: "error" },
		]);
	});

	void it("invokes the injected installer once and emits success", async () => {
		let installCalls = 0;
		const harness = createHarness({
			installCompanion: async () => {
				installCalls += 1;
			},
		});

		await harness.run("ide-install");

		assert.equal(installCalls, 1);
		assert.deepEqual(harness.notifications, [
			{ message: "Installed the VS Code companion. Reload the VS Code window if /ide does not respond.", type: "info" },
		]);
	});

	void it("reports an install failure and never emits success", async () => {
		const harness = createHarness({
			installCompanion: async () => {
				throw new Error("npx @vscode/vsce package failed (exit 1)");
			},
		});

		await harness.run("ide-install");

		assert.deepEqual(harness.notifications, [
			{ message: "Failed to install VS Code companion: npx @vscode/vsce package failed (exit 1)", type: "error" },
		]);
		assert.equal(harness.notifications.some((note) => note.type === "info"), false);
	});
});
