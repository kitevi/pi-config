import plugin from "../reminders/hbm-companion.ts";
import { describe, it, beforeEach, afterEach, assert } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "hbm-test-"));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function touch(relative: string): string {
	const absolute = path.join(root, relative);
	fs.mkdirSync(path.dirname(absolute), { recursive: true });
	fs.writeFileSync(absolute, "");
	return absolute;
}

function readArgs(filePath: string) {
	return { event: { toolName: "read", input: { path: filePath } }, ctx: { cwd: root } };
}

void describe("hbm-companion", () => {
	void it("registers for tool results and reports the package-local mapping once", () => {
		const reminder = plugin({} as never);
		const java = touch("src/main/java/entities/Foo.java");
		touch("src/main/resources/entities/Foo.hbm.xml");
		assert.equal(reminder.on, "tool_result");
		assert.isTrue(reminder.when(readArgs(java)));
		assert.match(reminder.message(readArgs(java)), /Hibernate mapping `src\/main\/resources\/entities\/Foo\.hbm\.xml`/);
		assert.isFalse(reminder.when(readArgs(java)));
	});

	void it("ignores non-read tools, failed reads, non-Java files, and missing paths", () => {
		const reminder = plugin({} as never);
		const args = readArgs(touch("src/main/java/Foo.java"));
		touch("src/main/resources/Foo.hbm.xml");
		assert.isFalse(reminder.when({ ...args, event: { ...args.event, toolName: "grep" } }));
		assert.isFalse(reminder.when({ ...args, event: { ...args.event, isError: true } }));
		assert.isFalse(reminder.when(readArgs("src/main/java/Foo.txt")));
		assert.isFalse(reminder.when({ event: { toolName: "read" }, ctx: args.ctx }));
		assert.isTrue(reminder.when(args));
	});

	void it("finds parent mappings for nested Sinfomar logging packages", () => {
		const reminder = plugin({} as never);
		const java = touch("EJBPcsRemote/src/main/java/ejbpcs/entities/logs/anc/ANCLog.java");
		touch("EJBPcsRemote/src/main/resources/ejbpcs/entities/ANCLog.hbm.xml");
		assert.isTrue(reminder.when(readArgs(java)));
		assert.include(reminder.message(readArgs(java)), "resources/ejbpcs/entities/ANCLog.hbm.xml");
	});

	void it("prefers the nearest package mapping over a parent mapping", () => {
		const reminder = plugin({} as never);
		const java = touch("src/main/java/entities/nested/Foo.java");
		touch("src/main/resources/entities/nested/Foo.hbm.xml");
		touch("src/main/resources/entities/Foo.hbm.xml");
		assert.isTrue(reminder.when(readArgs(java)));
		assert.include(reminder.message(readArgs(java)), "resources/entities/nested/Foo.hbm.xml");
		assert.notInclude(reminder.message(readArgs(java)), "resources/entities/Foo.hbm.xml");
	});

	void it("does not let unrelated same-name classes consume the entity reminder", () => {
		const reminder = plugin({} as never);
		const unrelated = touch("src/main/java/it/trieste/porto/sinfomar/resources/utils/Documento.java");
		const entity = touch("src/main/java/ejbpcs/entities/Documento.java");
		touch("src/main/resources/ejbpcs/entities/Documento.hbm.xml");
		assert.isFalse(reminder.when(readArgs(unrelated)));
		assert.isTrue(reminder.when(readArgs(entity)));
	});

	void it("keeps mappings and reminder suppression local to each module", () => {
		const reminder = plugin({} as never);
		for (const module of ["moduleA", "moduleB"]) {
			const java = touch(`${module}/src/main/java/entities/Foo.java`);
			touch(`${module}/src/main/resources/entities/Foo.hbm.xml`);
			assert.isTrue(reminder.when(readArgs(java)));
			assert.include(reminder.message(readArgs(java)), `${module}/src/main/resources/entities/Foo.hbm.xml`);
		}
		const other = touch("moduleC/src/main/java/entities/Foo.java");
		assert.isFalse(reminder.when(readArgs(other)));
	});

	void it("stops at the resource root and ignores copied build mappings", () => {
		const reminder = plugin({} as never);
		const java = touch("src/main/java/entities/Foo.java");
		for (const mapping of ["src/main/Foo.hbm.xml", "target/classes/entities/Foo.hbm.xml", "copied/Foo.hbm.xml"]) touch(mapping);
		assert.isFalse(reminder.when(readArgs(java)));
		touch("src/main/resources/Foo.hbm.xml");
		assert.isTrue(reminder.when(readArgs(java)));
	});

	void it("normalizes relative paths and shares suppression with absolute paths", () => {
		const reminder = plugin({} as never);
		const java = touch("src/main/java/entities/Foo.java");
		touch("src/main/resources/entities/Foo.hbm.xml");
		assert.isTrue(reminder.when(readArgs("./src/main/java/entities/../entities/Foo.java")));
		assert.isFalse(reminder.when(readArgs(java)));
	});

	void it("supports absolute Java paths outside cwd and displays absolute mappings", () => {
		const reminder = plugin({} as never);
		const java = touch("module/src/main/java/Foo.java");
		const mapping = touch("module/src/main/resources/Foo.hbm.xml");
		const args = { ...readArgs(java), ctx: { cwd: path.join(root, "elsewhere") } };
		assert.isTrue(reminder.when(args));
		assert.include(reminder.message(args), `\`${mapping}\``);
	});

	void it("does not require cwd for absolute paths", () => {
		const reminder = plugin({} as never);
		const java = touch("src/main/java/Foo.java");
		touch("src/main/resources/Foo.hbm.xml");
		assert.isTrue(reminder.when({ event: readArgs(java).event }));
	});

	void it("ignores Java files outside the Maven main source tree", () => {
		const reminder = plugin({} as never);
		touch("src/main/resources/Foo.hbm.xml");
		for (const java of ["Foo.java", "src/test/java/Foo.java", "target/classes/Foo.java"]) {
			assert.isFalse(reminder.when(readArgs(touch(java))));
		}
	});

	void it("requires exact filename case and does not treat directories as mappings", () => {
		const reminder = plugin({} as never);
		const java = touch("src/main/java/Foo.java");
		touch("src/main/resources/foo.hbm.xml");
		assert.isFalse(reminder.when(readArgs(java)));
		fs.mkdirSync(path.join(root, "src/main/resources/Foo.hbm.xml"));
		assert.isFalse(reminder.when(readArgs(java)));
	});

	void it("does not need a base-class denylist when a real mapping exists", () => {
		const reminder = plugin({} as never);
		const java = touch("src/main/java/Basic.java");
		touch("src/main/resources/Basic.hbm.xml");
		assert.isTrue(reminder.when(readArgs(java)));
	});
});
