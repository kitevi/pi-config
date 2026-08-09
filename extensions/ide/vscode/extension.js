"use strict";

/**
 * Pi ↔ VS Code selection bridge (VS Code side).
 *
 * A minimal on-demand companion: it stays dormant until VS Code routes a
 * vscode://ppowo.pi-ide-selection/capture?id=<uuid> URI to the topmost window
 * (activation event "onUri"). It then captures only the active file path, the
 * dirty flag, and the primary selection's normalized coordinates, and writes
 * the response JSON atomically under ~/.pi/ide-capture/ for Pi to collect.
 *
 * No selected source text ever leaves the editor, no listeners or state are
 * kept, and no server/socket exists. CommonJS so no build is required.
 */
const vscode = require("vscode");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const URI_AUTHORITY = "ppowo.pi-ide-selection";
const URI_PATH = "/capture";
const PROTOCOL_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const captureDir = () => path.join(os.homedir(), ".pi", "ide-capture");

/**
 * @param {import("vscode").ExtensionContext} context
 */
function activate(context) {
	context.subscriptions.push(
		vscode.window.registerUriHandler({
			handleUri(uri) {
				handleCaptureRequest(uri);
			},
		}),
	);
}

/**
 * Respond only to vscode://ppowo.pi-ide-selection/capture?id=<uuid>.
 * The URI carries nothing but the request id; an invalid id is ignored so it
 * can never be used as a filename.
 * @param {import("vscode").Uri} uri
 */
function handleCaptureRequest(uri) {
	if (uri.authority !== URI_AUTHORITY || uri.path !== URI_PATH) return;
	const requestId = new URLSearchParams(uri.query).get("id");
	if (!requestId || !UUID_PATTERN.test(requestId)) return;
	writeResponse(requestId, captureResponse(requestId));
}

/**
 * Read window.activeTextEditor only now, when the URI arrives. Returns the
 * response payload with the zero-based, end-exclusive primary selection.
 * @param {string} requestId
 */
function captureResponse(requestId) {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return failure(requestId, "No active text editor in VS Code");
	const document = editor.document;
	if (document.isUntitled) return failure(requestId, "The active document is untitled");
	if (document.uri.scheme !== "file") return failure(requestId, "The active document is not a file on disk");
	const selection = editor.selection;
	if (selection.isEmpty) return failure(requestId, "No text is selected in VS Code");
	return {
		version: PROTOCOL_VERSION,
		requestId,
		ok: true,
		filePath: document.uri.fsPath,
		dirty: document.isDirty,
		start: { line: selection.start.line, character: selection.start.character },
		end: { line: selection.end.line, character: selection.end.character },
	};
}

/** @param {string} requestId @param {string} error */
function failure(requestId, error) {
	return { version: PROTOCOL_VERSION, requestId, ok: false, error };
}

/**
 * Atomically write <uuid>.json: tmp file on the same filesystem, then rename.
 * Directory mode 0700 and file mode 0600 on POSIX; Windows relies on the
 * user's profile ACL.
 * @param {string} requestId
 * @param {object} payload
 */
function writeResponse(requestId, payload) {
	const dir = captureDir();
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const finalPath = path.join(dir, `${requestId}.json`);
	const tmpPath = path.join(dir, `${requestId}.${process.pid}.tmp`);
	fs.writeFileSync(tmpPath, JSON.stringify(payload), { mode: 0o600 });
	fs.renameSync(tmpPath, finalPath);
}

module.exports = { activate };
