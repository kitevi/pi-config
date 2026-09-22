import { assert, describe, it } from "vitest";
import techSpecPrewalk, {
	isTechSpecInvocation,
	PREWALK_REQUEST_EVENT,
	requestPrewalkArm,
	type FabricPrewalkRequestV1,
	type PrewalkEventBus,
} from "../extensions/tech-spec-prewalk.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const fakeContext = {} as ExtensionContext;

function fakeBus(
	listener?: (request: FabricPrewalkRequestV1) => void,
): PrewalkEventBus & { emitted: Array<[string, unknown]> } {
	const emitted: Array<[string, unknown]> = [];
	return {
		emitted,
		emit(channel, data) {
			emitted.push([channel, data]);
			listener?.(data as FabricPrewalkRequestV1);
		},
	};
}

void describe("isTechSpecInvocation", () => {
	void it.each([
		"/skill:tech-spec",
		"/skill:tech-spec write a spec for the billing rewrite",
		"/tech-spec",
		"/tech-spec   ",
		"  /skill:tech-spec",
		"/SKILL:TECH-SPEC args",
	])("matches %s", (text) => {
		assert.isTrue(isTechSpecInvocation(text));
	});

	void it.each([
		"",
		"/skill:tech-spec-review",
		"/tech-specs",
		"/skill:techspec",
		"/skill:other",
		"please run the tech-spec skill",
		"prefix /skill:tech-spec",
	])("rejects %s", (text) => {
		assert.isFalse(isTechSpecInvocation(text));
	});
});

void describe("requestPrewalkArm", () => {
	void it("resolves armed when Fabric claims and acknowledges", async () => {
		const bus = fakeBus((request) => {
			assert.strictEqual(request.version, 1);
			assert.strictEqual(request.context, fakeContext);
			assert.isTrue(request.claim());
			request.respond({ ok: true });
		});
		const outcome = await requestPrewalkArm(bus, fakeContext);
		assert.deepStrictEqual(outcome, { status: "armed" });
		assert.strictEqual(bus.emitted[0][0], PREWALK_REQUEST_EVENT);
	});

	void it("resolves failed when Fabric reports an arm failure", async () => {
		const bus = fakeBus((request) => {
			request.claim();
			request.respond({ ok: false, error: "Fabric prewalk is disabled" });
		});
		const outcome = await requestPrewalkArm(bus, fakeContext);
		assert.deepStrictEqual(outcome, { status: "failed", error: "Fabric prewalk is disabled" });
	});

	void it("resolves unclaimed when no Fabric runtime listens", async () => {
		const outcome = await requestPrewalkArm(fakeBus(), fakeContext);
		assert.deepStrictEqual(outcome, { status: "unclaimed" });
	});

	void it("lets only the first claimant own the request", async () => {
		const claims: boolean[] = [];
		const bus = fakeBus((request) => {
			// Two competing listeners during the same synchronous emit.
			claims.push(request.claim());
			claims.push(request.claim());
			request.respond({ ok: true });
		});
		const outcome = await requestPrewalkArm(bus, fakeContext);
		assert.deepStrictEqual(claims, [true, false]);
		assert.deepStrictEqual(outcome, { status: "armed" });
	});

	void it("ignores a late acknowledgment after settlement", async () => {
		let held: FabricPrewalkRequestV1 | undefined;
		const bus = fakeBus((request) => {
			request.claim();
			held = request;
		});
		const outcome = await requestPrewalkArm(bus, fakeContext, { timeoutMs: 5 });
		assert.deepStrictEqual(outcome, { status: "timeout" });
		// A respond() after the timeout must not throw or re-settle.
		held?.respond({ ok: true });
	});

	void it("ignores a claim after settlement", async () => {
		let held: FabricPrewalkRequestV1 | undefined;
		const bus = fakeBus((request) => {
			held = request;
		});
		const outcome = await requestPrewalkArm(bus, fakeContext);
		assert.deepStrictEqual(outcome, { status: "unclaimed" });
		assert.isFalse(held?.claim());
	});
});

void describe("techSpecPrewalk extension", () => {
	type AnyHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

	function fakePi(listener?: (request: FabricPrewalkRequestV1) => void) {
		const handlers = new Map<string, AnyHandler>();
		const notified: string[] = [];
		const bus = fakeBus(listener);
		const pi = {
			on(event: string, handler: AnyHandler) {
				handlers.set(event, handler);
			},
			events: bus,
		};
		const ctx = {
			ui: { notify: (message: string) => notified.push(message) },
		} as unknown as ExtensionContext;
		const sendInput = (text: string) =>
			handlers.get("input")?.({ type: "input", text, source: "interactive" }, ctx);
		const settle = () => handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
		return { pi, ctx, bus, notified, handlers, sendInput, settle };
	}

	void it("defers the arm until the tech-spec turn settles", async () => {
		const host = fakePi((request) => {
			request.claim();
			request.respond({ ok: true });
		});
		techSpecPrewalk(host.pi as never);

		const inputResult = await host.sendInput("/skill:tech-spec plan the migration");
		assert.deepStrictEqual(inputResult, { action: "continue" });
		// The skill turn (including the spec write) runs with prewalk idle.
		assert.strictEqual(host.bus.emitted.length, 0);

		await host.settle();
		assert.strictEqual(host.bus.emitted.length, 1);
		assert.strictEqual(host.bus.emitted[0][0], PREWALK_REQUEST_EVENT);
		assert.deepStrictEqual(host.notified, ["tech-spec: fabric prewalk armed."]);
	});

	void it("arms only once across later settles", async () => {
		const host = fakePi((request) => {
			request.claim();
			request.respond({ ok: true });
		});
		techSpecPrewalk(host.pi as never);
		await host.sendInput("/tech-spec");
		await host.settle();
		await host.settle();
		assert.strictEqual(host.bus.emitted.length, 1);
	});

	void it("does not arm when the skill was not invoked", async () => {
		const host = fakePi();
		techSpecPrewalk(host.pi as never);
		const inputResult = await host.sendInput("hello world");
		assert.deepStrictEqual(inputResult, { action: "continue" });
		await host.settle();
		assert.strictEqual(host.bus.emitted.length, 0);
		assert.deepStrictEqual(host.notified, []);
	});

	void it("warns when no Fabric runtime claims the request", async () => {
		const host = fakePi();
		techSpecPrewalk(host.pi as never);
		await host.sendInput("/tech-spec");
		await host.settle();
		assert.deepStrictEqual(host.notified, [
			"tech-spec: no Fabric runtime claimed the prewalk request; is pi-fabric installed?",
		]);
	});
});
