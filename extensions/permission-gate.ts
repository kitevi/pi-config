/**
 * Permission Gate Extension
 *
 * Runtime note:
 * - This is the stable entry point; focused implementation modules live in permission-gate/.
 * - The extension is intentionally plain-Node-runnable, erasable TypeScript.
 * - Keep TypeScript syntax to forms Node can strip directly: `type`, `import type`,
 *   const assertions, etc.
 * - Avoid enums, namespaces, decorators, parameter properties, or other TS constructs
 *   requiring transpilation.
 * - Tests live in tests/permission-gate.test.ts and run with `npm test`.
 *
 * Purpose:
 * - This is a behavior-shaping guardrail, not a sandbox.
 * - It allows normal agent work, including reads/writes outside the workspace and /tmp.
 * - It interrupts dangerous shell/tool calls with explicit rule-based decisions.
 * - It does not use risk scoring. Rules either allow, ask, or block.
 * - Block rules always win over ask rules.
 *
 * HOW A SHELL CALL IS READ:
 * - One lexer recovers every command in the call, not just the top-level text:
 *   pipelines, command substitutions, heredocs, `sh -c` bodies, `eval`, `xargs`,
 *   `find -exec`, privilege wrappers (`sudo`), runner wrappers (`uv run`,
 *   `mise exec`), and the command strings embedded in inline interpreter code
 *   (`python -c "os.system(...)"`, `node -e "execSync(...)"`).
 * - Rules match on resolved executables and lexed words, so quoting alone cannot
 *   hide a command from them: `sh -c 'rm -rf x'` is seen as `rm`.
 * - Inline interpreter bodies are additionally scanned for file mutation, process
 *   spawning, and outbound network calls.
 * - A script is Turing-complete and this is static text matching. The gate raises
 *   the cost of an accidental bypass. It cannot stop a determined one; for that,
 *   run Pi in a container.
 *
 * BLOCKS:
 * 1. Credential/private material reads or writes:
 *    - SSH private keys and known credential files
 *    - GPG material
 *    - private key/cert files: .pem, .key, .p12, .pfx
 *    - cloud/container credential files such as AWS, gcloud, Azure, Docker auth
 *    - NOTE: .env, .envrc, .npmrc, .netrc are intentionally NOT blocked
 * 2. Catastrophic disk/system commands:
 *    - mkfs
 *    - dd writing to /dev/*
 *    - sudo rm
 *    - chmod -R 777 / or equivalent root-wide permission changes
 *    - curl/wget piped into sudo shell execution
 * 3. Writes to pseudo-filesystems:
 *    - /dev, /proc, /sys
 * 4. Agent-controlled nested Pi agent runs through bash/nu:
 *    - blocks print/JSON modes and interactive startup with an initial prompt
 *    - allows Pi management, export, diagnostics, and promptless startup for troubleshooting
 *    - does not affect Pi launched directly by the user from a terminal or with `!`
 * 5. Git commands using --no-verify to bypass hooks.
 *
 * ASKS:
 * 1. Any command that deletes files: rm, rmdir, shred, `find -delete`.
 * 2. Shell-side file mutation via chmod, chown, tee, truncate, dd, in-place
 *    `sed -i`/`perl -pi`, and nushell `save`.
 * 3. Inline interpreter code (python, node, ruby, perl, php, awk) that writes
 *    files, spawns processes, sends data, or runs a decoded payload.
 * 4. Running a script this session created (write/edit tool, redirection, tee).
 * 5. Sudo/elevated commands unless already blocked.
 * 6. Destructive Git commands: reset --hard, clean -f, checkout -- ., restore ., force push,
 *    and any `git rm` (it removes paths and stages the deletion).
 * 7. Commits.
 * 8. Mutating package manager commands across npm/pnpm/yarn/bun, pip/uv/pipx/poetry,
 *    cargo, go, gem, brew, and system package managers.
 * 9. Network upload, push, remote execution, or credentialed network calls:
 *    - git push, ssh, scp, rsync, nc, socat
 *    - curl/wget upload, data, auth-header, or mutating-method flags
 *    - curl/wget piped into a shell
 *    - NOTE: download-to-file (curl -o, wget -O) is intentionally NOT asked.
 *
 * ALLOWS:
 * 1. Normal structured reads/writes, including outside the workspace and /tmp.
 * 2. Tests, builds, lints, typechecks.
 * 3. Plain network fetches/searches.
 * 4. Reading documentation, dependencies, and generated scratch files.
 * 5. .env, .envrc, .npmrc, .netrc files (low-stakes project config).
 * 6. Basic shell operations: touch, mkdir, mv, cp, file redirections, npx, bunx.
 * 7. Inline interpreter code with no detected side effect.
 * 8. Non-agent Pi CLI operations: management, export, diagnostics, and promptless startup.
 *
 * ASK OUTCOMES:
 * - Allowed: the call runs.
 * - Declined (explicit "no" or dismissal): the call is blocked and the turn is
 *   aborted, so the model cannot immediately try another form.
 * - Timed out (nobody answered): the call is blocked and the turn is aborted
 *   too — the user stepped away, so unattended work stops there rather than
 *   continuing without permission. The model gets timeout wording, not the
 *   decline wording: "nobody answered" is not "you said no".
 * - In every blocked case the reason is delivered to the model twice: as the tool
 *   result, and as a next-turn message. The second delivery matters because pi's
 *   agent loop checks the abort signal before the block reason, so an aborted
 *   turn would otherwise show the model a bare "Operation aborted".
 */

export { default } from "./permission-gate/runtime.ts";
export {
	assessToolCall,
	escalationNote,
	NESTED_PI_OVERRIDE_ENV,
	noteRuleHits,
	rememberWrittenPath,
	resetGateState,
} from "./permission-gate/policy.ts";
export { ASK_DENY, describeAskOutcome } from "./permission-gate/presentation.ts";
