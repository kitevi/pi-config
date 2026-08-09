/**
 * Pi ↔ VS Code selection bridge (Pi side).
 *
 * Registers two commands:
 *   /ide          — asks the native desktop VS Code window for the active file
 *                   and primary selection range, then pastes a file/range
 *                   reference into the editor. Only the path and coordinates
 *                   cross the bridge; the model reads the saved file itself.
 *   /ide-install  — packages the vendored VS Code companion (vscode/) into a
 *                   temporary VSIX on demand, installs it with the `code` CLI,
 *                   and deletes the VSIX afterwards.
 *
 * The capture flow is fire-and-forget: Pi opens vscode://ppowo.pi-ide-selection
 * /capture?id=<uuid>, VS Code's onUri handler writes a response JSON under
 * ~/.pi/ide-capture/, and Pi polls that file with a bounded timeout. No
 * background server, socket, or listener exists on either side.
 *
 * Plain JavaScript (ESM — the repo root package.json declares type: module).
 * The factory exists so tests can inject the two external boundaries
 * (requestSelection, installCompanion); the default export wires the real
 * adapters, which use pi.exec for launching and packaging.
 */
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPTURE_DIR = join(homedir(), ".pi", "ide-capture");
const URI_AUTHORITY = "ppowo.pi-ide-selection";
const URI_PATH = "/capture";
const PROTOCOL_VERSION = 1;

const POLL_INTERVAL_MS = 150;
const CAPTURE_TIMEOUT_MS = 5_000;
const LAUNCH_TIMEOUT_MS = 10_000;
const PACKAGE_TIMEOUT_MS = 180_000;
const INSTALL_TIMEOUT_MS = 120_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 1-based display position: VS Code positions are zero-based. */
function displayPosition(position) {
	return { line: position.line + 1, character: position.character + 1 };
}

/**
 * Build the readable reference pasted into the editor, e.g.
 *   Read `src/auth/session.ts`, lines 10–15 (selection 10:1–16:1).
 * Prefers a path relative to ctx.cwd and normalizes separators to "/" so the
 * display is consistent on Windows. The end position is exclusive: a
 * multi-line selection ending at column zero leaves its final line unselected,
 * so the readable inclusive line range stops on the previous line while the
 * exact selection endpoint stays visible.
 */
export function formatSelectionReference(capture, cwd) {
	const rel = relative(cwd, capture.filePath);
	const displayPath =
		rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.replaceAll("\\", "/") : capture.filePath;
	const start = displayPosition(capture.start);
	const end = displayPosition(capture.end);
	const lastSelectedLine = capture.end.character === 0 ? capture.end.line : capture.end.line + 1;
	const linePhrase = start.line === lastSelectedLine ? `line ${start.line}` : `lines ${start.line}–${lastSelectedLine}`;
	return `Read \`${displayPath}\`, ${linePhrase} (selection ${start.line}:${start.character}–${end.line}:${end.character}).`;
}

function validatePosition(position, label) {
	if (!position || typeof position !== "object" || Array.isArray(position)) {
		throw new Error(`VS Code returned an invalid response: ${label} is missing`);
	}
	const { line, character } = position;
	if (!Number.isInteger(line) || line < 0 || !Number.isInteger(character) || character < 0) {
		throw new Error(`VS Code returned an invalid response: ${label} must be non-negative integers`);
	}
	return { line, character };
}

/** Validate the response protocol before using it. */
function validateResponse(payload, requestId) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("VS Code returned an invalid response: not an object");
	}
	if (payload.version !== PROTOCOL_VERSION) {
		throw new Error(`VS Code returned an invalid response: unsupported version ${payload.version}`);
	}
	if (payload.requestId !== requestId) {
		throw new Error("VS Code returned an invalid response: request id mismatch");
	}
	if (typeof payload.ok !== "boolean") {
		throw new Error("VS Code returned an invalid response: ok must be a boolean");
	}
	if (!payload.ok) {
		if (typeof payload.error !== "string" || payload.error.length === 0) {
			throw new Error("VS Code returned an invalid response: missing error");
		}
		return { version: PROTOCOL_VERSION, requestId, ok: false, error: payload.error };
	}
	if (typeof payload.filePath !== "string" || payload.filePath.length === 0) {
		throw new Error("VS Code returned an invalid response: filePath must be non-empty");
	}
	if (typeof payload.dirty !== "boolean") {
		throw new Error("VS Code returned an invalid response: dirty must be a boolean");
	}
	const start = validatePosition(payload.start, "start");
	const end = validatePosition(payload.end, "end");
	if (start.line > end.line || (start.line === end.line && start.character > end.character)) {
		throw new Error("VS Code returned an invalid response: selection range is not monotonic");
	}
	return { version: PROTOCOL_VERSION, requestId, ok: true, filePath: payload.filePath, dirty: payload.dirty, start, end };
}

/** Poll the response file with a bounded timeout; the caller removes it in finally. */
async function pollForResponse(responsePath, requestId) {
	const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			return validateResponse(JSON.parse(await readFile(responsePath, "utf-8")), requestId);
		} catch (err) {
			if (err?.code === "ENOENT") {
				await sleep(POLL_INTERVAL_MS);
				continue;
			}
			throw err;
		}
	}
	throw new Error("Timed out waiting for VS Code. Run /ide-install and reload the VS Code window.");
}

async function runCommand(pi, command, args, timeoutMs) {
	try {
		return await pi.exec(command, args, { timeout: timeoutMs });
	} catch (err) {
		return { code: 1, stdout: "", stderr: err?.message ?? String(err) };
	}
}

/** Open the capture URI with the native desktop launcher for this platform. */
async function openCaptureUri(pi, uri) {
	const platform = process.platform;
	if (platform === "darwin") {
		return runCommand(pi, "/usr/bin/open", [uri], LAUNCH_TIMEOUT_MS);
	}
	if (platform === "linux") {
		const xdg = await runCommand(pi, "xdg-open", [uri], LAUNCH_TIMEOUT_MS);
		if (xdg.code === 0) return xdg;
		return runCommand(pi, "gio", ["open", uri], LAUNCH_TIMEOUT_MS);
	}
	if (platform === "win32") {
		const explorer = await runCommand(pi, "explorer.exe", [uri], LAUNCH_TIMEOUT_MS);
		if (explorer.code === 0) return explorer;
		// Documented fallback: cmd.exe /c start "" <uri>
		return runCommand(pi, "cmd.exe", ["/c", "start", "", uri], LAUNCH_TIMEOUT_MS);
	}
	throw new Error(`Unsupported platform: ${platform}`);
}

/** Real /ide boundary: launch VS Code, poll the response, always clean up. */
function createRequestSelectionAdapter(pi) {
	return async function requestSelection() {
		const requestId = randomUUID();
		const responsePath = join(CAPTURE_DIR, `${requestId}.json`);
		try {
			// The UUID is validated before it is used as a filename.
			if (!UUID_PATTERN.test(requestId)) {
				throw new Error("failed to generate a valid request id");
			}
			await rm(responsePath, { force: true }); // remove any stale response for this id
			const result = await openCaptureUri(pi, `vscode://${URI_AUTHORITY}${URI_PATH}?id=${requestId}`);
			if (result.code !== 0) {
				const detail = (result.stderr || result.stdout || "").trim().slice(-400);
				throw new Error(detail ? `could not open VS Code: ${detail}` : "could not open VS Code");
			}
			return await pollForResponse(responsePath, requestId);
		} finally {
			await rm(responsePath, { force: true });
		}
	};
}

/** Turn a failed pi.exec result into an actionable message. */
function explainCommandFailure(label, result, hint) {
	const detail = (result.stderr || result.stdout || "").trim().slice(-400);
	const cause = detail ? `: ${detail}` : " (the command could not be started)";
	return `${label} failed (exit ${result.code})${cause}. ${hint}`;
}

/** Real /ide-install boundary: package the vendored source, install, delete the VSIX. */
function createInstallCompanionAdapter(pi) {
	// Resolve the vendored companion directory relative to this module.
	const companionDir = fileURLToPath(new URL("./vscode/", import.meta.url));
	return async function installCompanion() {
		const vsixPath = join(tmpdir(), `pi-ide-selection-${randomUUID()}.vsix`);
		try {
			const npx = process.platform === "win32" ? "npx.cmd" : "npx";
			const pack = await runCommand(pi, npx, ["--yes", "@vscode/vsce", "package", "--no-dependencies", "--out", vsixPath], PACKAGE_TIMEOUT_MS);
			if (pack.code !== 0) {
				throw new Error(
					explainCommandFailure(
						"npx @vscode/vsce package",
						pack,
						"Install Node.js and npm and make sure they are on your PATH.",
					),
				);
			}
			const codeCli = process.platform === "win32" ? "code.cmd" : "code";
			const install = await runCommand(pi, codeCli, ["--install-extension", vsixPath, "--force"], INSTALL_TIMEOUT_MS);
			if (install.code !== 0) {
				throw new Error(
					explainCommandFailure(
						"code --install-extension",
						install,
						"Open VS Code and run \"Install code command in PATH\" from the Command Palette, then retry.",
					),
				);
			}
		} finally {
			await rm(vsixPath, { force: true });
		}
	};
}

/**
 * Factory for the extension plugin. Tests inject the two external boundaries;
 * the default export wires the real adapters, which use pi.exec.
 */
export function createIdeExtension({ requestSelection, installCompanion } = {}) {
	return function plugin(pi) {
		const request = requestSelection ?? createRequestSelectionAdapter(pi);
		const install = installCompanion ?? createInstallCompanionAdapter(pi);

		pi.registerCommand("ide", {
			description: "Insert the active VS Code file and primary selection range into the editor",
			handler: async (_args, ctx) => {
				try {
					const capture = await request();
					if (!capture.ok) {
						// Capture failures are error notifications; nothing is inserted.
						ctx.ui.notify(capture.error, "error");
						return;
					}
					// pasteToEditor preserves existing editor content and never
					// triggers an agent turn.
					await ctx.ui.pasteToEditor(formatSelectionReference(capture, ctx.cwd));
					if (capture.dirty) {
						ctx.ui.notify("VS Code has unsaved changes; the model will read the saved file.", "warning");
					}
				} catch (err) {
					ctx.ui.notify(`Failed to capture VS Code selection: ${err.message}`, "error");
				}
			},
		});

		pi.registerCommand("ide-install", {
			description: "Package the vendored VS Code companion from source and install it",
			handler: async (_args, ctx) => {
				try {
					await install();
					ctx.ui.notify("Installed the VS Code companion. Reload the VS Code window if /ide does not respond.", "info");
				} catch (err) {
					ctx.ui.notify(`Failed to install VS Code companion: ${err.message}`, "error");
				}
			},
		});
	};
}

export default createIdeExtension();
