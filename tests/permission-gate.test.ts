import gate, { assessToolCall } from "../extensions/permission-gate.ts";
import { describe, it } from "vitest";
import { assert } from "vitest";
import { homedir } from "node:os";

// Seam 1: the pure decision seam. Every row reads as a spec of the policy:
// routine work stays silent; catastrophic or privacy-sensitive calls ask.
// Table-driven on purpose — adding a rule is adding rows, not writing tests.

type Case = [name: string, toolName: string, input: Record<string, unknown>, ask: boolean];

const cwd = process.cwd();
const shell = (command: string) => ({ command });
const path = (p: string) => ({ path: p });

const cases: Case[] = [
	// ── routine work must stay silent ────────────────────────────────────────
	["tsc via npx", "bash", shell("npx tsc -p tsconfig.json"), false],
	["runs a session-created scratch script", "bash", shell("npx tsx /tmp/probe.ts"), false],
	["npm install", "bash", shell("npm install"), false],
	["npm ci", "bash", shell("npm ci"), false],
	["uv sync", "bash", shell("uv sync"), false],
	["cargo add", "bash", shell("cargo add serde"), false],
	["go get", "bash", shell("go get golang.org/x/tools"), false],
	["maven build", "bash", shell("mvn clean install"), false],
	["maven test piped through tee", "bash", shell("mvn -q test 2>&1 | tee /tmp/mvn.log"), false],
	["maven exec with main class", "bash", shell("mvn -q exec:java -Dexec.mainClass=com.x.Main"), false],
	["gradle build", "bash", shell("./gradlew test"), false],
	["rm of build output inside the project", "bash", shell("rm -rf target/classes/tmp"), false],
	["rm of node_modules", "bash", shell("rm -rf node_modules"), false],
	["rm of a single file", "bash", shell("rm file.txt"), false],
	["rm under /tmp", "bash", shell("rm -rf /tmp/build"), false],
	["rm of an absolute in-project path", "bash", shell(`rm -rf ${cwd}/target`), false],
	["mvn clean then rm of build output", "bash", shell("mvn clean package && rm -rf target/classes/tmp"), false],
	["git rm", "bash", shell("git rm --cached x"), false],
	["git commit", "bash", shell("git commit -m 'fix: thing'"), false],
	["git push", "bash", shell("git push"), false],
	["git push with upstream flag", "bash", shell("git push -u origin feat"), false],
	["git push --follow-tags", "bash", shell("git push --follow-tags"), false],
	["commit message mentioning a drop is prose", "bash", shell("git commit -m 'Drop table legacy_x'"), false],
	["grep for DROP TABLE is not a database call", "bash", shell("grep -rn 'DROP TABLE' src/"), false],
	["sed in place", "bash", shell("sed -i 's/a/b/' README.md"), false],
	["chmod a project script", "bash", shell("chmod +x scripts/run.sh"), false],
	["chmod ~/.ssh/config is not a key", "bash", shell("chmod 600 ~/.ssh/config"), false],
	["redirect to /dev/null", "bash", shell("echo x > /dev/null"), false],
	["inline python write", "bash", shell("python3 -c \"open('x','w').write('y')\""), false],
	["inline node write", "bash", shell("node -e \"require('fs').writeFileSync('a','b')\""), false],
	["curl fetch", "bash", shell("curl -s https://example.com"), false],
	["curl POST to localhost", "bash", shell("curl -X POST http://localhost:8080/api -d '{}'"), false],
	["ssh for remote listing", "bash", shell("ssh host ls"), false],
	["rsync between local trees", "bash", shell("rsync -av a/ b/"), false],
	["cat .env is project config", "bash", shell("cat .env"), false],
	["psql select is not destructive", "bash", shell("psql -c 'select 1'"), false],
	["find -delete inside the project", "bash", shell("find . -name '*.tmp' -delete"), false],
	["which sudo is a lookup", "bash", shell("which sudo"), false],
	["git restore --staged only unstages", "bash", shell("git restore --staged ."), false],
	["git checkout of a single file", "bash", shell("git checkout -- src/Foo.java"), false],
	["git stash is recoverable", "bash", shell("git stash"), false],
	["git clean dry run", "bash", shell("git clean -n"), false],
	["read of project file", "read", path("src/main.ts"), false],
	["read of a public SSH key", "read", path("~/.ssh/id_ed25519.pub"), false],

	// ── catastrophic or privacy-sensitive calls must ask ────────────────────
	["rm -rf of root", "bash", shell("rm -rf /"), true],
	["rm -rf of home", "bash", shell("rm -rf ~"), true],
	["rm -rf of $HOME glob", "bash", shell("rm -rf $HOME/*"), true],
	["rm -rf mixing safe and home targets", "bash", shell("rm -rf node_modules ~/"), true],
	["rm -rf inside a subshell", "bash", shell("sh -c 'rm -rf ~'"), true],
	["rm -rf of a parent path", "bash", shell("rm -rf ../"), true],
	["rm -rf of the repo metadata", "bash", shell("rm -rf .git"), true],
	["rm -rf of everything here", "bash", shell("rm -rf ./*"), true],
	["rm -rf of the whole project by absolute path", "bash", shell(`rm -rf ${cwd}`), true],
	["rm -rf of /tmp itself", "bash", shell("rm -rf /tmp"), true],
	["rm -rf of a home document tree", "bash", shell("rm -rf ~/Documents/thesis"), true],
	["recursive chmod on root", "bash", shell("chmod -R 777 /"), true],
	["recursive chown on home", "bash", shell("chown -R me ~"), true],
	["mkfs a device", "bash", shell("mkfs.ext4 /dev/sda1"), true],
	["dd to a disk device", "bash", shell("dd if=/dev/zero of=/dev/sda"), true],
	["redirect into a disk device", "bash", shell("cat img > /dev/sdb"), true],
	["git push --force", "bash", shell("git push --force"), true],
	["git push -f", "bash", shell("git push -f origin main"), true],
	["git push --force-with-lease", "bash", shell("git push --force-with-lease"), true],
	["git push --delete", "bash", shell("git push origin --delete main"), true],
	["git push of a ref deletion", "bash", shell("git push origin :old"), true],
	["git push of a forced refspec", "bash", shell("git push origin +main"), true],
	["git reset --hard", "bash", shell("git reset --hard HEAD~1"), true],
	["git checkout discarding everything", "bash", shell("git checkout -- ."), true],
	["git checkout bare dot", "bash", shell("git checkout ."), true],
	["git restore whole tree", "bash", shell("git restore ."), true],
	["git clean with force", "bash", shell("git clean -fdx"), true],
	["git stash clear", "bash", shell("git stash clear"), true],
	["git stash drop", "bash", shell("git stash drop"), true],
	["sudo install", "bash", shell("sudo apt install jq"), true],
	["sudo service restart", "bash", shell("sudo systemctl restart nginx"), true],
	["sudo inside a subshell", "bash", shell("sh -c 'sudo rm -rf /opt/x'"), true],
	["reading a private SSH key", "bash", shell("cat ~/.ssh/id_ed25519"), true],
	["reading AWS credentials", "bash", shell("cat ~/.aws/credentials"), true],
	["reading docker auth", "bash", shell("cat ~/.docker/config.json"), true],
	["reading pi's own credential store", "bash", shell(`cat ${homedir()}/.pi/agent/auth.json`), true],
	["reading git credentials", "bash", shell("cat ~/.git-credentials"), true],
	["grepping a gh token store", "bash", shell("grep -r token ~/.config/gh/hosts.yml"), true],
	["reading kube config", "bash", shell("cat ~/.kube/config"), true],
	["archiving the gpg home", "bash", shell("tar czf /tmp/k.tgz ~/.gnupg"), true],
	["psql drop database", "bash", shell("psql -c 'DROP DATABASE prod'"), true],
	["mysql truncate", "bash", shell("mysql -e 'truncate table users'"), true],
	["npm publish", "bash", shell("npm publish"), true],
	["maven deploy", "bash", shell("./mvnw -q deploy -DskipTests"), true],
	["cargo publish", "bash", shell("cargo publish"), true],
	["structured read of a private key", "read", path("~/.ssh/id_ed25519"), true],
	["structured read of pi credentials", "read", path(`${homedir()}/.pi/agent/auth.json`), true],
	["structured write over AWS credentials", "write", path("~/.aws/credentials"), true],
];

void describe("assessToolCall", () => {
	for (const [name, toolName, input, ask] of cases) {
		void it(`${ask ? "asks" : "allows"}: ${name}`, () => {
			const assessment = assessToolCall(toolName, input, { cwd });
			assert.strictEqual(assessment.decision, ask ? "ask" : "allow", `${name}: reason=${assessment.reason ?? "-"}`);
			if (ask) assert.ok(assessment.reason, "an ask must say why");
		});
	}

	void it("ignores tools with no shell or path input", () => {
		assert.strictEqual(assessToolCall("fabric_exec", { code: "anything" }, { cwd }).decision, "allow");
		assert.strictEqual(assessToolCall("bash", { command: "" }, { cwd }).decision, "allow");
	});
});

// Seam 2: the runtime seam. tool_call allow → undefined; ask approve →
// undefined plus a permission_gate:ask event; ask declined or unanswered →
// block plus an aborted turn; no UI → block.

const install = (choice: string | undefined) => {
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const prompts: string[] = [];
	const optionsSeen: Array<string[]> = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		sendMessage: () => {},
		events: { emit: (channel: string, data: unknown) => emitted.push({ channel, data }) },
	};
	gate(pi as never);

	let aborted = false;
	const ctx = {
		cwd,
		hasUI: true,
		ui: {
			select: (title: string, options: string[]) => {
				prompts.push(title);
				optionsSeen.push(options);
				return Promise.resolve(choice);
			},
			notify: () => {},
		},
		abort: () => {
			aborted = true;
		},
	};

	const call = (toolName: string, input: Record<string, unknown>) =>
		handlers.get("tool_call")?.({ toolCallId: "c1", toolName, input }, ctx) as Promise<{ block?: boolean; reason?: string } | undefined>;

	return { call, emitted, prompts, optionsSeen, wasAborted: () => aborted };
};

void describe("tool_call handling", () => {
	void it("lets a routine call through without prompting", async () => {
		const { call, prompts, wasAborted } = install("Allow once");
		assert.strictEqual(await call("bash", shell("npm test")), undefined);
		assert.strictEqual(prompts.length, 0);
		assert.strictEqual(wasAborted(), false);
	});

	void it("allows an approved ask and emits the notification event", async () => {
		const { call, emitted, prompts } = install("Allow once");
		assert.strictEqual(await call("bash", shell("git push --force")), undefined);
		assert.strictEqual(prompts.length, 1);
		assert.match(prompts[0], /git push --force/);
		assert.strictEqual(emitted.length, 1);
		assert.strictEqual(emitted[0].channel, "permission_gate:ask");
		assert.ok((emitted[0].data as { timeoutMs?: number }).timeoutMs > 0);
	});

	void it("offers block as the first, safe default option", async () => {
		const { call, optionsSeen } = install(undefined);
		await call("bash", shell("rm -rf ~"));
		assert.match(optionsSeen[0][0], /block/i);
	});

	void it("blocks and aborts the turn when the user declines", async () => {
		const { call, wasAborted } = install(undefined);
		const outcome = await call("bash", shell("git push --force"));
		assert.strictEqual(outcome?.block, true);
		assert.match(outcome?.reason ?? "", /did not approve/i);
		assert.strictEqual(wasAborted(), true);
	});

	void it("blocks without a UI", async () => {
		const { call, wasAborted } = install("Allow once");
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
			sendMessage: () => {},
			events: { emit: () => {} },
		};
		gate(pi as never);
		const outcome = (await handlers.get("tool_call")?.(
			{ toolCallId: "c1", toolName: "bash", input: shell("rm -rf ~") },
			{ cwd, hasUI: false, abort: () => {} },
		)) as { block?: boolean; reason?: string } | undefined;
		assert.strictEqual(outcome?.block, true);
		assert.strictEqual(wasAborted(), false);
	});
});
