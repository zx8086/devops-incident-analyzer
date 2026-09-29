// apps/web/src/routes/api/agent/memory/candidates/server.test.ts

// SIO-1891: the pane's API maps the review module's results to HTTP and hides
// behind the kill-switch.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const listReviewRows = mock(async (agent: string) => [{ agent, skillName: "lag-corr", status: "candidate" }]);
const reviewCandidate = mock(async (action: { action: string }) =>
	action.action === "approve"
		? { ok: false as const, code: 409 as const, reason: "no confirmed task_success" }
		: { ok: true as const, status: "rejected" as const },
);
mock.module("@devops-agent/agent", () => ({
	isLearningReviewEnabled: (env: NodeJS.ProcessEnv = process.env) =>
		env.LEARNING_REVIEW_ENABLED !== "false" && env.LEARNING_REVIEW_ENABLED !== "0",
	listReviewRows,
	reviewCandidate,
}));

const { GET, POST } = await import("./+server.ts");
const prev = process.env.LEARNING_REVIEW_ENABLED;

const get = (query: string) =>
	GET({ url: new URL(`http://localhost/api/agent/memory/candidates${query}`) } as Parameters<typeof GET>[0]);
const post = (body: unknown) =>
	POST({
		request: new Request("http://localhost/api/agent/memory/candidates", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	} as Parameters<typeof POST>[0]);

beforeEach(() => {
	delete process.env.LEARNING_REVIEW_ENABLED;
	listReviewRows.mockClear();
	reviewCandidate.mockClear();
});
afterEach(() => {
	if (prev === undefined) delete process.env.LEARNING_REVIEW_ENABLED;
	else process.env.LEARNING_REVIEW_ENABLED = prev;
});

describe("/api/agent/memory/candidates (SIO-1891)", () => {
	test("GET lists the agent's candidates", async () => {
		const res = await get("?agent=elastic-iac");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { agent: string; candidates: unknown[] };
		expect(body.agent).toBe("elastic-iac");
		expect(body.candidates).toHaveLength(1);
		expect(listReviewRows).toHaveBeenCalledWith("elastic-iac");
	});

	test("GET rejects an unknown agent and hides when disabled", async () => {
		expect((await get("?agent=nope")).status).toBe(400);
		process.env.LEARNING_REVIEW_ENABLED = "false";
		expect((await get("?agent=elastic-iac")).status).toBe(404);
		expect((await post({ agent: "elastic-iac", skillName: "x", action: "reject" })).status).toBe(404);
	});

	test("POST maps a refused approve to 409 with the reason, and a reject to 200", async () => {
		const refused = await post({ agent: "incident-analyzer", skillName: "lag-corr", action: "approve" });
		expect(refused.status).toBe(409);
		expect(((await refused.json()) as { error: string }).error).toContain("task_success");
		const ok = await post({ agent: "incident-analyzer", skillName: "lag-corr", action: "reject" });
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ ok: true, status: "rejected" });
	});

	test("POST passes kind and expectedStatus through", async () => {
		const res = await post({
			agent: "incident-analyzer",
			skillName: "lag-corr",
			kind: "runbook",
			expectedStatus: "candidate",
			action: "reject",
		});
		expect(res.status).toBe(200);
		expect(reviewCandidate).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "runbook", expectedStatus: "candidate", action: "reject" }),
		);
	});

	test("POST validates the body", async () => {
		expect((await post({ agent: "incident-analyzer", skillName: "Bad Name", action: "reject" })).status).toBe(400);
		expect((await post({ agent: "incident-analyzer", skillName: "x", action: "explode" })).status).toBe(400);
	});
});
