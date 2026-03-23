// shared/src/tracing/__tests__/session.test.ts
import { describe, expect, test } from "bun:test";
import { createSessionContext, getCurrentSession, getCurrentSessionId, runWithSession } from "../session.ts";

describe("Session Context", () => {
	test("getCurrentSession returns undefined outside session", () => {
		expect(getCurrentSession()).toBeUndefined();
	});

	test("runWithSession propagates context", async () => {
		const ctx = createSessionContext("conn-1", "http", "sess-1", { name: "Test Client" });

		await runWithSession(ctx, () => {
			const session = getCurrentSession();
			expect(session).toBeDefined();
			expect(session?.sessionId).toBe("sess-1");
			expect(session?.connectionId).toBe("conn-1");
			expect(session?.transportMode).toBe("http");
			expect(session?.clientInfo?.name).toBe("Test Client");
			expect(session?.startTime).toBeGreaterThan(0);
		});
	});

	test("getCurrentSessionId returns id inside session", async () => {
		const ctx = createSessionContext("conn-2", "stdio", "sess-2");

		await runWithSession(ctx, () => {
			expect(getCurrentSessionId()).toBe("sess-2");
		});
	});

	test("createSessionContext uses connectionId as sessionId fallback", () => {
		const ctx = createSessionContext("conn-3", "http");
		expect(ctx.sessionId).toBe("conn-3");
	});

	test("nested sessions override parent", async () => {
		const outer = createSessionContext("conn-outer", "http", "outer");
		const inner = createSessionContext("conn-inner", "stdio", "inner");

		await runWithSession(outer, async () => {
			expect(getCurrentSessionId()).toBe("outer");

			await runWithSession(inner, () => {
				expect(getCurrentSessionId()).toBe("inner");
			});

			expect(getCurrentSessionId()).toBe("outer");
		});
	});
});
