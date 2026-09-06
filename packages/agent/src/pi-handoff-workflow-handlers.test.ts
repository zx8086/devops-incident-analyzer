// agent/src/pi-handoff-workflow-handlers.test.ts
// SIO-1651: the graph + agent handler wiring, with the hub scripted at the
// fetch boundary (the pi-verifier.test.ts scriptedHub shape). Covers the
// never-throws contract: every failure mode must resolve to a PiHandoffResult.
import { describe, expect, test } from "bun:test";
import type { PiVerdict } from "@devops-agent/shared";
import type { PiAgentCard } from "./action-tools/pi-coms-client.ts";
import { isPiHandoffEnabled, runPiHandoff } from "./pi-handoff-workflow-handlers.ts";

const env: NodeJS.ProcessEnv = {
	PI_COMS_NET_SERVER_URL: "http://hub.test",
	PI_COMS_NET_AUTH_TOKEN: "tok",
	PI_COMS_NET_ENVIRONMENT: "prd",
};

const report = "## Summary\n\nALB 5xx spike on checkout at 10:02 UTC.\n\nConfidence: 0.72";

type Call = { method: string; path: string; body: Record<string, unknown> | undefined };

function scriptedHub(opts: { agents: PiAgentCard[]; reply?: unknown; replyStatus?: string }) {
	const calls: Call[] = [];
	const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
		const parsed = new URL(input);
		const path = parsed.pathname + parsed.search;
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
		calls.push({ method, path, body });
		const json = (b: unknown, status = 200) =>
			new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
		if (path === "/v1/agents/register") return json({ ok: true, agent: { name: "incident-analyzer" } });
		if (path.startsWith("/v1/agents?")) return json({ agents: opts.agents });
		if (path === "/v1/messages") return json({ ok: true, msg_id: "m1", status: "delivered", target_session: "t1" });
		if (path.startsWith("/v1/messages/m1/await"))
			return json({ msg_id: "m1", status: opts.replyStatus ?? "complete", response: opts.reply ?? null, error: null });
		if (path.includes("/heartbeat")) return json({ ok: true });
		if (method === "DELETE") return json({ ok: true });
		return json({ ok: false, error: `unscripted ${method} ${path}` }, 500);
	};
	return { calls, fetchImpl };
}

const online: PiAgentCard[] = [{ session_id: "s1", name: "eu-oit-prd", status: "online" }];
const offline: PiAgentCard[] = [{ session_id: "s1", name: "eu-oit-prd", status: "offline" }];

const confirmed: PiVerdict = {
	verdict: "confirmed",
	summary: "All claims hold.",
	claims: [{ claim: "ALB 5xx spike", status: "confirmed", evidence: "CloudWatch datapoints" }],
};

const ctx = { threadId: "thread-1", estate: "eu-oit-prd", requestId: "thread-1" };

describe("SIO-1651 isPiHandoffEnabled", () => {
	// SIO-1655: flipped to default ON (kill-switch semantics). The hand-off still
	// self-skips when no hub is configured, so a deployment without pi-coms sends
	// nothing regardless of this flag.
	test("defaults on", () => {
		expect(isPiHandoffEnabled({})).toBe(true);
		expect(isPiHandoffEnabled({ PI_HANDOFF_ENABLED: "true" })).toBe(true);
		expect(isPiHandoffEnabled({ PI_HANDOFF_ENABLED: "1" })).toBe(true);
	});

	test("off only for an explicit false or 0", () => {
		expect(isPiHandoffEnabled({ PI_HANDOFF_ENABLED: "false" })).toBe(false);
		expect(isPiHandoffEnabled({ PI_HANDOFF_ENABLED: "0" })).toBe(false);
	});
});

describe("SIO-1651 runPiHandoff", () => {
	test("graph feeds the report to the spoke and returns the verdict enum", async () => {
		const hub = scriptedHub({ agents: online, reply: confirmed });
		const result = await runPiHandoff(ctx, {
			readCompletedReport: async () => report,
			verifierDeps: { env, fetchImpl: hub.fetchImpl },
		});

		expect(result).toEqual({ status: "verdict", verdict: "confirmed", target: "eu-oit-prd", msgId: "m1" });
		// The report reached the spoke through the send body.
		const send = hub.calls.find((c) => c.path === "/v1/messages");
		expect(String(send?.body?.prompt)).toContain("ALB 5xx spike");
		// Registered and deregistered around the send.
		expect(hub.calls.some((c) => c.path === "/v1/agents/register")).toBe(true);
		expect(hub.calls.some((c) => c.method === "DELETE")).toBe(true);
	});

	test("an offline spoke queues to the mailbox and reports no verdict", async () => {
		const hub = scriptedHub({ agents: offline });
		const result = await runPiHandoff(ctx, {
			readCompletedReport: async () => report,
			verifierDeps: { env, fetchImpl: hub.fetchImpl },
		});

		expect(result.status).toBe("queued");
		// No await: a queued send has no reply to wait for.
		expect(hub.calls.some((c) => c.path.startsWith("/v1/messages/m1/await"))).toBe(false);
	});

	test("a reply that does not match the verdict schema fails the verify step", async () => {
		const hub = scriptedHub({ agents: online, reply: { verdict: "not-an-enum-member" } });
		const result = await runPiHandoff(ctx, {
			readCompletedReport: async () => report,
			verifierDeps: { env, fetchImpl: hub.fetchImpl },
		});

		expect(result.status).toBe("failed");
		expect(result.status === "failed" && result.reason).toContain("schema mismatch");
	});

	test("an empty completed report skips before any hub traffic", async () => {
		const hub = scriptedHub({ agents: online, reply: confirmed });
		const result = await runPiHandoff(ctx, {
			readCompletedReport: async () => "   ",
			verifierDeps: { env, fetchImpl: hub.fetchImpl },
		});

		expect(result.status).toBe("skipped");
		expect(hub.calls).toHaveLength(0);
	});

	test("skips when no hub is configured", async () => {
		const result = await runPiHandoff(ctx, {
			readCompletedReport: async () => report,
			verifierDeps: { env: {} },
		});
		expect(result).toEqual({ status: "skipped", reason: "pi-coms hub is not configured" });
	});

	test("never throws when the report reader itself fails", async () => {
		const hub = scriptedHub({ agents: online, reply: confirmed });
		const result = await runPiHandoff(ctx, {
			readCompletedReport: async () => {
				throw new Error("checkpoint unreadable");
			},
			verifierDeps: { env, fetchImpl: hub.fetchImpl },
		});

		expect(result.status).toBe("skipped");
		expect(result.status === "skipped" && result.reason).toContain("checkpoint unreadable");
	});

	test("never throws when the hub is unreachable", async () => {
		const result = await runPiHandoff(ctx, {
			readCompletedReport: async () => report,
			verifierDeps: {
				env,
				fetchImpl: async () => {
					throw new Error("ECONNREFUSED");
				},
			},
		});

		expect(result.status).toBe("failed");
		expect(result.status === "failed" && result.reason).toContain("ECONNREFUSED");
	});

	test("refuses an estate whose environment has no hub (no cross-environment access)", async () => {
		const hub = scriptedHub({ agents: online, reply: confirmed });
		const result = await runPiHandoff(
			{ ...ctx, estate: "eu-oit-dev" },
			{ readCompletedReport: async () => report, verifierDeps: { env, fetchImpl: hub.fetchImpl } },
		);

		expect(result.status).toBe("failed");
		expect(hub.calls).toHaveLength(0);
	});
});
