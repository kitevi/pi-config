import plugin from "../reminders/hbm-companion.ts";
import { describe, it, beforeEach, afterEach } from "vitest";
import { assert } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Reminder = {
	on: string;
	when: (args: { event: unknown; ctx?: { cwd?: string } }) => boolean;
	message: (args: { event: unknown; ctx?: { cwd?: string } }) => string;
};

function createReminder(): Reminder {
	return plugin({} as never) as unknown as Reminder;
}

function readEvent(filePath: string, over: Record<string, unknown> = {}) {
	return { toolName: "read", isError: false, input: { path: filePath }, ...over };
}

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "hbm-test-"));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

/** Create a file, making parent dirs. Returns the absolute path. */
function touch(rel: string): string {
	const abs = path.join(root, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, "");
	return abs;
}

void describe("hbm-companion", () => {
	void it("does not fire for non-read tools", () => {
		const r = createReminder();
		const java = touch("src/main/java/Foo.java");
		touch("src/main/resources/Foo.hbm.xml");
		const event = readEvent(java, { toolName: "grep" });
		assert.strictEqual(r.when({ event, ctx: { cwd: root } }), false);
	});

	void it("does not fire for errored reads", () => {
		const r = createReminder();
		const java = touch("src/main/java/Foo.java");
		touch("src/main/resources/Foo.hbm.xml");
		const event = readEvent(java, { isError: true });
		assert.strictEqual(r.when({ event, ctx: { cwd: root } }), false);
	});

	void it("does not fire for non-java files", () => {
		const r = createReminder();
		const txt = touch("src/main/java/Foo.txt");
		touch("src/main/resources/Foo.hbm.xml");
		assert.strictEqual(r.when({ event: readEvent(txt), ctx: { cwd: root } }), false);
	});

	void it("does not fire when no companion mapping exists", () => {
		const r = createReminder();
		const java = touch("src/main/java/Foo.java");
		assert.strictEqual(r.when({ event: readEvent(java), ctx: { cwd: root } }), false);
	});

	void it("fires when a companion .hbm.xml exists", () => {
		const r = createReminder();
		const java = touch("src/main/java/Foo.java");
		touch("src/main/resources/Foo.hbm.xml");
		assert.strictEqual(r.when({ event: readEvent(java), ctx: { cwd: root } }), true);
	});

	void it("matches stem case-insensitively", () => {
		const r = createReminder();
		const java = touch("src/main/java/Foo.java");
		touch("src/main/resources/foo.hbm.xml");
		assert.strictEqual(r.when({ event: readEvent(java), ctx: { cwd: root } }), true);
	});

	void it("message references the mapping file", () => {
		const r = createReminder();
		const java = touch("src/main/java/Foo.java");
		touch("src/main/resources/Foo.hbm.xml");
		const event = readEvent(java);
		r.when({ event, ctx: { cwd: root } });
		const msg = r.message({ event, ctx: { cwd: root } });
		assert.match(msg, /Foo\.hbm\.xml/);
		assert.match(msg, /Hibernate/i);
	});

	void it("fires only once per mapping file across repeated reads", () => {
		const r = createReminder();
		const java = touch("src/main/java/Foo.java");
		touch("src/main/resources/Foo.hbm.xml");
		const event = readEvent(java);
		assert.strictEqual(r.when({ event, ctx: { cwd: root } }), true);
		assert.strictEqual(r.when({ event, ctx: { cwd: root } }), false);
	});

	void it("ignores base classes like ABean/Basic/Loggable", () => {
		const r = createReminder();
		for (const name of ["ABean.java", "Basic.java", "Loggable.java"]) {
			const java = touch(`src/main/java/${name}`);
			touch(`src/main/resources/${name.replace(".java", ".hbm.xml")}`);
			assert.strictEqual(r.when({ event: readEvent(java), ctx: { cwd: root } }), false);
		}
	});

	void it("prefers the source mapping over a copied build artifact", () => {
		const r = createReminder();
		const java = touch("src/main/java/Foo.java");
		touch("src/main/resources/Foo.hbm.xml");
		// Build artifact copies live under a different root; simulate one NOT
		// under src/ so dedupe can drop it. Use a non-skipped dir name.
		touch("copied/Foo.hbm.xml");
		const event = readEvent(java);
		assert.strictEqual(r.when({ event, ctx: { cwd: root } }), true);
		const msg = r.message({ event, ctx: { cwd: root } });
		assert.match(msg, /src\/main\/resources\/Foo\.hbm\.xml/);
		assert.notMatch(msg, /copied\/Foo\.hbm\.xml/);
	});

	void it("keeps all source mappings when there are genuinely several", () => {
		const r = createReminder();
		const java = touch("src/main/java/Foo.java");
		touch("moduleA/src/main/resources/Foo.hbm.xml");
		touch("moduleB/src/main/resources/Foo.hbm.xml");
		const event = readEvent(java);
		assert.strictEqual(r.when({ event, ctx: { cwd: root } }), true);
		const msg = r.message({ event, ctx: { cwd: root } });
		assert.match(msg, /moduleA\/src\/main\/resources\/Foo\.hbm\.xml/);
		assert.match(msg, /moduleB\/src\/main\/resources\/Foo\.hbm\.xml/);
		assert.match(msg, /mappings:/);
	});

	void it("skips mappings under build/output directories like target/", () => {
		const r = createReminder();
		const java = touch("src/main/java/Foo.java");
		touch("target/classes/Foo.hbm.xml");
		// Only the target copy exists → no companion.
		assert.strictEqual(r.when({ event: readEvent(java), ctx: { cwd: root } }), false);
	});

	void it("uses plural wording only when multiple source mappings exist", () => {
		const r = createReminder();
		const java = touch("src/main/java/Foo.java");
		touch("src/main/resources/Foo.hbm.xml");
		const event = readEvent(java);
		r.when({ event, ctx: { cwd: root } });
		assert.match(r.message({ event, ctx: { cwd: root } }), /mapping:/);
	});
});
