/**
 * Pi IDE Selection — VS Code companion.
 *
 * Registers a system-wide URI handler (`vscode://ppowo.pi-ide-selection/capture`)
 * that answers Pi's `/ide` command on demand with the active file path, dirty
 * flag, and primary selection range. The response is written atomically to
 * `~/.pi/ide-capture/<requestId>.json`; no selected text is ever sent.
 *
 * No selection listeners, timers, or persistent state live here: the
 * extension acts only when a capture URI arrives.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const PROTOCOL_VERSION = 1;
const RESPONSE_DIR = path.join(os.homedir(), ".pi", "ide-capture");
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorResponse(requestId, error) {
	return { version: PROTOCOL_VERSION, requestId, ok: false, error };
}

async function writeResponse(requestId, payload) {
	await fs.promises.mkdir(RESPONSE_DIR, { recursive: true, mode: 0o700 });
	const temporaryPath = path.join(RESPONSE_DIR, `${requestId}.${process.pid}.tmp`);
	const finalPath = path.join(RESPONSE_DIR, `${requestId}.json`);
	await fs.promises.writeFile(temporaryPath, JSON.stringify(payload), { mode: 0o600 });
	try {
		await fs.promises.rename(temporaryPath, finalPath);
	} catch {
		// Windows cannot rename over an existing file; clear a stale response first.
		await fs.promises.rm(finalPath, { force: true });
		await fs.promises.rename(temporaryPath, finalPath);
	}
}

function capturePayload(requestId) {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return errorResponse(requestId, "No active text editor in VS Code");
	}
	if (editor.document.isUntitled) {
		return errorResponse(requestId, "Untitled documents are not supported");
	}
	if (editor.document.uri.scheme !== "file") {
		return errorResponse(requestId, "Active document is not a file");
	}
	const selection = editor.selection;
	if (selection.isEmpty) {
		return errorResponse(requestId, "No text is selected in VS Code");
	}
	return {
		version: PROTOCOL_VERSION,
		requestId,
		ok: true,
		filePath: editor.document.uri.fsPath,
		dirty: editor.document.isDirty,
		start: { line: selection.start.line, character: selection.start.character },
		end: { line: selection.end.line, character: selection.end.character },
	};
}

function handleUri(uri) {
	// Ignore paths other than /capture and invalid request ids.
	if (uri.path !== "/capture") return;
	const requestId = new URLSearchParams(uri.query).get("id");
	if (!requestId || !UUID_PATTERN.test(requestId)) return;
	writeResponse(requestId, capturePayload(requestId)).catch((error) => {
		console.error("[pi-ide-selection] failed to write capture response:", error);
	});
}

function activate(context) {
	context.subscriptions.push(vscode.window.registerUriHandler({ handleUri }));
}

exports.activate = activate;
