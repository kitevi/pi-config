/**
 * Pi ↔ VS Code selection bridge.
 *
 * `/ide` asks native desktop VS Code for the active file path, dirty flag, and
 * primary selection range, then pastes a readable file/range reference into
 * Pi's input editor. The selected source text never crosses the bridge; the
 * model reads the saved file itself.
 *
 * `/ide-install` packages the vendored VS Code companion (`./vscode`) into a
 * temporary VSIX on demand and installs it with the `code` CLI, then deletes
 * the VSIX.
 *
 * `createIdeExtension({ requestSelection, installCompanion })` exposes the two
 * external boundaries as injectable adapters so tests exercise the public
 * command handlers without touching the filesystem, processes, or VS Code.
 */
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL_VERSION = 1;
const URI_AUTHORITY = "ppowo.pi-ide-selection";
const RESPONSE_DIR = join(homedir(), ".pi", "ide-capture");
const POLL_INTERVAL_MS = 200;
const POLL_TIMEOUT_MS = 5_000;
const LAUNCH_TIMEOUT_MS = 5_000;
const PACKAGE_TIMEOUT_MS = 180_000;
const INSTALL_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isObject = (value) =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const execDetail = (result) => (result.stderr || result.stdout || "").trim();

/**
 * Native desktop launchers for `vscode://` URIs. The URI contains only a
 * generated UUID, never user input.
 */
function launcherCommands(uri) {
	switch (process.platform) {
		case "darwin":
			return [["/usr/bin/open", [uri]]];
		case "win32":
			// explorer.exe is primary; cmd.exe /c start is the documented
			// fallback if direct Explorer invocation proves unreliable.
			return [
				["explorer.exe", [uri]],
				["cmd.exe", ["/c", "start", "", uri]],
			];
		default:
			return [
				["xdg-open", [uri]],
				["gio", ["open", uri]],
			];
	}
}

async function openCaptureUri(pi, uri) {
	let lastError;
	for (const [command, args] of launcherCommands(uri)) {
		const result = await pi.exec(command, args, { timeout: LAUNCH_TIMEOUT_MS });
		if (result.code === 0) return;
		const detail = execDetail(result);
		lastError = new Error(
			`Failed to open VS Code (${command} exited ${result.code})${detail ? `: ${detail}` : ""}`,
		);
	}
	throw lastError ?? new Error("Failed to open VS Code");
}

async function pollForResponse(responsePath) {
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			return JSON.parse(await readFile(responsePath, "utf8"));
		} catch {
			// Not written yet, or a partial read; keep polling.
			await sleep(POLL_INTERVAL_MS);
		}
	}
	throw new Error(
		"Timed out waiting for VS Code. Run /ide-install and reload the VS Code window, then retry.",
	);
}

function validatePosition(position, label) {
	if (
		!isObject(position) ||
		!Number.isInteger(position.line) ||
		position.line < 0 ||
		!Number.isInteger(position.character) ||
		position.character < 0
	) {
		throw new Error(`VS Code sent an invalid ${label} position`);
	}
	return { line: position.line, character: position.character };
}

function validateCapture(response, requestId) {
	if (!isObject(response)) throw new Error("VS Code sent an invalid response");
	if (response.version !== PROTOCOL_VERSION) {
		throw new Error(`Unsupported VS Code response version: ${String(response.version)}`);
	}
	if (response.requestId !== requestId) {
		throw new Error("VS Code response does not match this request");
	}
	if (response.ok === false) {
		const message =
			typeof response.error === "string" && response.error.length > 0
				? response.error
				: "VS Code could not capture the selection";
		throw new Error(message);
	}
	if (response.ok !== true) throw new Error("VS Code sent an invalid response");
	if (typeof response.filePath !== "string" || response.filePath.length === 0) {
		throw new Error("VS Code response is missing the file path");
	}
	if (typeof response.dirty !== "boolean") {
		throw new Error("VS Code response has an invalid dirty flag");
	}
	const start = validatePosition(response.start, "start");
	const end = validatePosition(response.end, "end");
	if (start.line > end.line || (start.line === end.line && start.character > end.character)) {
		throw new Error("VS Code response has an invalid selection range");
	}
	return { filePath: response.filePath, dirty: response.dirty, start, end };
}

/**
 * Real request adapter: UUID request id, system-wide `vscode://` URI,
 * bounded polling of the shared response directory.
 */
function defaultRequestSelection(pi) {
	return async function requestSelection() {
		const requestId = randomUUID();
		const responsePath = join(RESPONSE_DIR, `${requestId}.json`);
		// Remove any stale response for this id before requesting a fresh one.
		await rm(responsePath, { force: true });
		await openCaptureUri(pi, `vscode://${URI_AUTHORITY}/capture?id=${requestId}`);
		try {
			return validateCapture(await pollForResponse(responsePath), requestId);
		} finally {
			await rm(responsePath, { force: true });
		}
	};
}

/**
 * Real install adapter: package the vendored companion with vsce, install
 * the VSIX with the `code` CLI, and always delete the temporary VSIX.
 */
function defaultInstallCompanion(pi) {
	return async function installCompanion() {
		const companionDir = fileURLToPath(new URL("./vscode", import.meta.url));
		const vsixPath = join(tmpdir(), `pi-ide-selection-${randomUUID()}.vsix`);
		try {
			const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
			const packaged = await pi.exec(
				npxCommand,
				["--yes", "@vscode/vsce", "package", "--no-dependencies", "--out", vsixPath],
				{ cwd: companionDir, timeout: PACKAGE_TIMEOUT_MS },
			);
			if (packaged.code !== 0) {
				const detail = execDetail(packaged);
				throw new Error(
					`Failed to package the VS Code companion (${npxCommand} exited ${packaged.code}). Is npm installed?${detail ? ` ${detail}` : ""}`,
				);
			}

			const codeCommand = process.platform === "win32" ? "code.cmd" : "code";
			const installed = await pi.exec(
				codeCommand,
				["--install-extension", vsixPath, "--force"],
				{ timeout: INSTALL_TIMEOUT_MS },
			);
			if (installed.code !== 0) {
				const detail = execDetail(installed);
				throw new Error(
					`Failed to install the VS Code companion (${codeCommand} exited ${installed.code}). Is the \`code\` CLI on your PATH?${detail ? ` ${detail}` : ""}`,
				);
			}
		} finally {
			await rm(vsixPath, { force: true });
		}
	};
}

/**
 * Format the capture as a readable reference. Positions are converted from
 * VS Code's zero-based, end-exclusive coordinates to one-based display
 * positions. When a multi-line selection ends at column zero, the unselected
 * final line is excluded from the readable inclusive line range.
 */
function formatReference(cwd, capture) {
	const relativePath = relative(cwd, capture.filePath);
	const displayPath =
		relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)
			? relativePath
			: capture.filePath;
	const normalizedPath = displayPath.split(sep).join("/");

	const startLine = capture.start.line + 1;
	const startCharacter = capture.start.character + 1;
	const endLine = capture.end.line + 1;
	const endCharacter = capture.end.character + 1;

	let range;
	if (capture.start.line === capture.end.line) {
		range = `line ${startLine}`;
	} else if (capture.end.character === 0) {
		range = `lines ${startLine}–${endLine - 1}`;
	} else {
		range = `lines ${startLine}–${endLine}`;
	}
	return `Read \`${normalizedPath}\`, ${range} (selection ${startLine}:${startCharacter}–${endLine}:${endCharacter}). `;
}

export function createIdeExtension({ requestSelection, installCompanion } = {}) {
	return function ideExtension(pi) {
		const captureSelection = requestSelection ?? defaultRequestSelection(pi);
		const install = installCompanion ?? defaultInstallCompanion(pi);

		pi.registerCommand("ide", {
			description:
				"Insert the active VS Code file and primary selection range into the editor",
			handler: async (_args, ctx) => {
				try {
					const capture = await captureSelection(ctx);
					ctx.ui.pasteToEditor(formatReference(ctx.cwd, capture));
					if (capture.dirty) {
						ctx.ui.notify(
							"VS Code has unsaved changes; the model will read the saved file.",
							"warning",
						);
					}
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});

		pi.registerCommand("ide-install", {
			description: "Package the vendored VS Code companion and install it into VS Code",
			handler: async (_args, ctx) => {
				try {
					await install();
					ctx.ui.notify(
						"Installed pi-ide-selection. Reload the VS Code window if /ide does not respond.",
						"info",
					);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});
	};
}

export default createIdeExtension();
