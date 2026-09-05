import { assert, describe, it } from "vitest";
import { assessToolCall, PermissionGateState } from "../extensions/permission-gate.ts";
import { analyzeShellCommand } from "../extensions/permission-gate/shell-analysis.ts";

// All command strings are assessed, never executed. Paths are synthetic fixtures.
const decision = (command: string) => assessToolCall("bash", { command }).decision;

describe("resolved protected paths", () => {
	it.each([
		["read", "/home/gate-review/.ssh/./id_ed25519", "/tmp"],
		["read", "/home/gate-review/.ssh//id_ed25519", "/tmp"],
		["read", "id_ed25519", "/home/gate-review/.ssh"],
		["edit", "../.aws/credentials", "/home/gate-review/project"],
		["write", "hostname", "/proc/sys/kernel"],
		["write", "../sys/kernel/hostname", "/proc/self"],
	])("blocks %s %s relative to %s", (tool, path, cwd) => {
		assert.equal(assessToolCall(tool, { path }, { cwd }).decision, "block");
	});
	it.each([
		"cd /home/gate-review/.ssh && cat id_ed25519",
		"env -C /home/gate-review/.ssh cat id_ed25519",
		"uv run --directory /home/gate-review/.ssh cat id_ed25519",
	])("blocks shell credential access: %s", (command) => assert.equal(decision(command), "block"));
	it("uses the supplied cwd, not the harness process cwd", () => {
		assert.equal(assessToolCall("bash", { command: "cat id_ed25519" }, { cwd: "/home/gate-review/.ssh" }).decision, "block");
	});
	it.each([".env", ".envrc", ".npmrc", ".netrc", ".ssh/id_ed25519.pub", "src/file.ts"])("keeps ordinary path %s allowed", (path) => {
		assert.equal(assessToolCall("read", { path }, { cwd: "/home/gate-review" }).decision, "allow");
	});
});

describe("inline interpreter syntax", () => {
	it.each([
		"python3 -W ignore -c 'open(\"review.txt\", \"w\").write(\"demo\")'",
		"python3 -X utf8 -W ignore -c 'open(\"review.txt\", \"w\")'",
		"node --input-type module -e 'import {writeFileSync} from \"node:fs\"; writeFileSync(\"review.txt\", \"demo\")'",
		"python3 -c 'open(\"review.txt\", mode=\"w\").write(\"demo\")'",
		"python3 -c 'open(mode=\"a\", file=\"review.txt\")'",
		"python3 -c 'open(\"review.txt\", encoding=\"utf-8\", mode=\"r+\")'",
	])("asks for %s", (command) => assert.equal(decision(command), "ask"));
	it.each([
		"python3 -W ignore -c 'print(1)'",
		"python3 -X utf8 -c 'open(\"review.txt\", mode=\"r\").read()'",
		"python3 -c 'open(mode=\"rb\", file=\"review.txt\").read()'",
		"node --input-type module -e 'console.log(1)'",
		"python3 existing.py -c 'open(\"argument.txt\", \"w\")'",
	])("keeps read-only code and script arguments allowed: %s", (command) => assert.equal(decision(command), "allow"));
});

describe("generated scripts through cwd-changing wrappers", () => {
	it.each([
		"env -C /tmp/gate-review python3 runner.py",
		"env --chdir=/tmp/gate-review python3 runner.py",
		"env -C/tmp/gate-review python3 runner.py",
		"uv run --directory /tmp/gate-review python3 runner.py",
		"uv run --directory=/tmp/gate-review python3 runner.py",
		"uv --directory /tmp/gate-review run python3 runner.py",
		"env -C /tmp uv run --directory gate-review python3 runner.py",
	])("asks for %s", (command) => {
		const state = new PermissionGateState();
		state.stageWrites("write", [{ path: "/tmp/gate-review/runner.py", cwd: "/tmp" }]);
		state.completeWrites("write", true);
		assert.equal(assessToolCall("bash", { command }, { state, cwd: "/tmp" }).decision, "ask");
	});
	it("keeps outer redirections and later commands in the parent cwd", () => {
		const shell = analyzeShellCommand("env -C child python3 runner.py > result.txt; python3 later.py", "/tmp/gate-review");
		assert.deepEqual(shell.executed, [{ path: "runner.py", cwd: "/tmp/gate-review/child" }, { path: "later.py", cwd: "/tmp/gate-review" }]);
		assert.deepEqual(shell.written, [{ path: "result.txt", cwd: "/tmp/gate-review" }]);
	});
	it("does not treat uv --project as a directory change", () => {
		const shell = analyzeShellCommand("uv run --project /tmp/other python3 runner.py", "/tmp/gate-review");
		assert.deepEqual(shell.executed, [{ path: "runner.py", cwd: "/tmp/gate-review" }]);
	});
});

describe("ordinary package-manager and curl options", () => {
	it.each([
		"npm --workspace app install example-package",
		"npm -w app install example-package",
		"npm --workspace=app install example-package",
		"npm --registry https://example.invalid install example-package",
		"pnpm -C /tmp/review add example-package",
		"pnpm --filter app add example-package",
		"yarn --cwd /tmp/review add example-package",
		"bun --cwd /tmp/review add example-package",
		"curl -sSX POST https://example.invalid",
		"curl -sSXPOST https://example.invalid",
		"curl -sSd example https://example.invalid",
		"curl -sSH 'Authorization: Bearer example' https://example.invalid",
	])("asks for %s", (command) => assert.equal(decision(command), "ask"));
	it.each([
		"npm --workspace install view example-package",
		"pnpm --filter add list",
		"npm view install",
		"curl -fsS https://example.invalid",
		"curl -sSoDownloaded https://example.invalid",
		"curl -sSADataClient https://example.invalid",
		"curl -sS -o -download.txt https://example.invalid",
	])("does not mistake option values for actions: %s", (command) => assert.equal(decision(command), "allow"));
});

describe("Git hook-bypass aliases", () => {
	it.each(["git commit -n -m demo", "git commit -an -m demo", "git -C /tmp/review commit -n -m demo"])("blocks %s", (command) => {
		assert.equal(decision(command), "block");
	});
	it.each(["git commit -m -n", "git commit -mnonsense", "git commit -Skeyname -m demo", "git commit -- -n", "git push -n"])("does not mistake values, paths, or push dry-run for bypass: %s", (command) => {
		assert.equal(decision(command), "ask");
	});
});
