import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const bootstrapPath = join(repoRoot, "bootstrap.mjs");
const skillUrlEnvironmentVariable = "PI_CONFIG_FABRIC_EXEC_SKILL_URL";

interface SkillServer {
	url: string;
	close(): Promise<void>;
}

async function startSkillServer(status: number, body: string): Promise<SkillServer> {
	const server = createServer((_request, response) => {
		response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
		response.end(body);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});

	const address = server.address();
	assert.ok(address && typeof address !== "string");

	return {
		url: `http://127.0.0.1:${address.port}/SKILL.md`,
		close: () => closeServer(server),
	};
}

async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
	});
}

async function runBootstrap(home: string, skillUrl: string): Promise<void> {
	await execFileAsync(process.execPath, [bootstrapPath, "--light"], {
		cwd: repoRoot,
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			[skillUrlEnvironmentVariable]: skillUrl,
		},
		timeout: 30_000,
	});
}

function appendSystemPath(home: string): string {
	return join(home, ".pi", "agent", "APPEND_SYSTEM.md");
}

void describe("bootstrap reconciliation", () => {
	void it("generates APPEND_SYSTEM.md from repository rules and the fetched Fabric skill", async () => {
		const home = await mkdtemp(join(tmpdir(), "pi-config-bootstrap-"));
		const skill = [
			"---",
			"name: fabric-exec",
			"description: Test Fabric contract.",
			"---",
			"",
			"# fabric_exec — core reference",
			"",
			"Only returned values reach the model.",
			"",
		].join("\n");
		const server = await startSkillServer(200, skill);

		try {
			await runBootstrap(home, server.url);

			const baseRules = await readFile(join(repoRoot, "APPEND_SYSTEM.md"), "utf8");
			const expected = `${baseRules.trimEnd()}\n\n${skill.trimEnd()}\n`;
			const generatedPath = appendSystemPath(home);
			const firstOutput = await readFile(generatedPath, "utf8");
			const targetStat = await lstat(generatedPath);

			assert.equal(firstOutput, expected);
			assert.equal(targetStat.isFile(), true);
			assert.equal(targetStat.isSymbolicLink(), false);

			await runBootstrap(home, server.url);
			assert.equal(await readFile(generatedPath, "utf8"), firstOutput);
		} finally {
			await server.close();
			await rm(home, { recursive: true, force: true });
		}
	});

	void it("preserves existing managed files when fetching the Fabric skill fails", async () => {
		const home = await mkdtemp(join(tmpdir(), "pi-config-bootstrap-"));
		const generatedPath = appendSystemPath(home);
		const server = await startSkillServer(503, "unavailable");

		try {
			await mkdir(dirname(generatedPath), { recursive: true });
			await writeFile(generatedPath, "existing prompt\n");

			await assert.rejects(runBootstrap(home, server.url));
			assert.equal(await readFile(generatedPath, "utf8"), "existing prompt\n");
		} finally {
			await server.close();
			await rm(home, { recursive: true, force: true });
		}
	});

	void it("rejects fetched content that is not the Fabric skill before cleanup", async () => {
		const home = await mkdtemp(join(tmpdir(), "pi-config-bootstrap-"));
		const generatedPath = appendSystemPath(home);
		const server = await startSkillServer(200, "not a skill\n");

		try {
			await mkdir(dirname(generatedPath), { recursive: true });
			await writeFile(generatedPath, "existing prompt\n");

			await assert.rejects(runBootstrap(home, server.url));
			assert.equal(await readFile(generatedPath, "utf8"), "existing prompt\n");
		} finally {
			await server.close();
			await rm(home, { recursive: true, force: true });
		}
	});
});
