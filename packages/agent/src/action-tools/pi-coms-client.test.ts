// agent/src/action-tools/pi-coms-client.test.ts
// SIO-1635: the client is exercised against a scripted fetch at the network
// boundary; no hub process is spawned.
import { describe, expect, test } from "bun:test";
import type { PiComsConfig } from "@devops-agent/shared";
import { PI_COMS_AWAIT_SLICE_MS, PI_COMS_SENDER_NAME, PiComsClient, PiComsHttpError } from "./pi-coms-client.ts";

const config: PiComsConfig = {
	serverUrl: "http://hub.test",
	authToken: "tok",
	project: "default",
	fallbackTarget: "ops",
	estateAgentMap: {},
	verifyTimeoutMs: 60_000,
	investigateTimeoutMs: 120_000,
};

type Call = { method: string; path: string; body: unknown; headers: Record<string, string> };

function scripted(handlers: Array<(call: Call) => { status?: number; body?: unknown }>) {
	const calls: Call[] = [];
	const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
		const headers = Object.fromEntries(
			Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
		);
		const call: Call = {
			method: init?.method ?? "GET",
			path: input.replace(config.serverUrl, ""),
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			headers,
		};
		calls.push(call);
		const handler = handlers[calls.length - 1];
		if (!handler) throw new Error(`unexpected call #${calls.length}: ${call.method} ${call.path}`);
		const out = handler(call);
		return new Response(out.body === undefined ? "" : JSON.stringify(out.body), {
			status: out.status ?? 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { calls, fetchImpl };
}

describe("PiComsClient", () => {
	test("register posts an explicit sender card with the bearer token", async () => {
		const { calls, fetchImpl } = scripted([() => ({ body: { ok: true, agent: { name: PI_COMS_SENDER_NAME } } })]);
		const client = new PiComsClient(config, { fetchImpl, sessionId: "sid-1" });
		await client.register();
		expect(calls[0]?.path).toBe("/v1/agents/register");
		expect(calls[0]?.headers.authorization).toBe("Bearer tok");
		const body = calls[0]?.body as Record<string, unknown>;
		expect(body.session_id).toBe("sid-1");
		expect(body.name).toBe(PI_COMS_SENDER_NAME);
		expect(body.explicit).toBe(true);
		expect(body.project).toBe("default");
	});

	test("send forwards target, schema, conversation id and optional ttl", async () => {
		const { calls, fetchImpl } = scripted([
			() => ({ body: { ok: true, msg_id: "m1", status: "delivered", target_session: "t1" } }),
			() => ({ body: { ok: true, msg_id: "m2", status: "queued", target_session: null } }),
		]);
		const client = new PiComsClient(config, { fetchImpl, sessionId: "sid-1" });
		const sent = await client.send("eu-oit-prd", "check this", {
			responseSchema: { type: "object" },
			conversationId: "conv-1",
		});
		expect(sent).toEqual({ msg_id: "m1", status: "delivered", target_session: "t1" });
		const body = calls[0]?.body as Record<string, unknown>;
		expect(body.target).toBe("eu-oit-prd");
		expect(body.sender_session).toBe("sid-1");
		expect(body.response_schema).toEqual({ type: "object" });
		expect(body.conversation_id).toBe("conv-1");
		expect(body.hops).toBe(0);
		expect("ttl_ms" in body).toBe(false);

		const queued = await client.send("ops", "later", { ttlMs: 3_600_000 });
		expect(queued.status).toBe("queued");
		const queuedBody = calls[1]?.body as Record<string, unknown> | undefined;
		expect(queuedBody?.ttl_ms).toBe(3_600_000);
	});

	test("hub errors surface the status and hub error code", async () => {
		const { fetchImpl } = scripted([() => ({ status: 404, body: { ok: false, error: "target_not_found" } })]);
		const client = new PiComsClient(config, { fetchImpl });
		const err = await client.send("ghost", "hi").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PiComsHttpError);
		expect((err as PiComsHttpError).status).toBe(404);
		expect((err as PiComsHttpError).code).toBe("target_not_found");
	});

	test("awaitReply returns the terminal reply from a single slice", async () => {
		const { calls, fetchImpl } = scripted([
			() => ({ body: { msg_id: "m1", status: "complete", response: { ok: 1 }, error: null } }),
		]);
		const client = new PiComsClient(config, { fetchImpl });
		const reply = await client.awaitReply("m1", 60_000);
		expect(reply).toEqual({ status: "complete", response: { ok: 1 }, error: null });
		expect(calls[0]?.path).toBe(`/v1/messages/m1/await?timeout_ms=${PI_COMS_AWAIT_SLICE_MS}`);
	});

	test("awaitReply treats a slice timeout as in-flight, heartbeats, and keeps polling", async () => {
		let clock = 0;
		const { calls, fetchImpl } = scripted([
			// slice 1 expires at the awaiter, message still delivered
			() => {
				clock += PI_COMS_AWAIT_SLICE_MS;
				return { body: { msg_id: "m1", status: "timeout", response: null, error: "timeout" } };
			},
			() => ({ body: { msg_id: "m1", status: "delivered", response: null, error: null } }),
			() => ({ body: { ok: true } }), // heartbeat
			// slice 2 completes
			() => ({ body: { msg_id: "m1", status: "complete", response: "done", error: null } }),
		]);
		const client = new PiComsClient(config, { fetchImpl, sessionId: "sid-1", now: () => clock });
		const reply = await client.awaitReply("m1", 60_000);
		expect(reply.status).toBe("complete");
		expect(reply.response).toBe("done");
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			`GET /v1/messages/m1/await?timeout_ms=${PI_COMS_AWAIT_SLICE_MS}`,
			"GET /v1/messages/m1",
			"POST /v1/agents/sid-1/heartbeat",
			`GET /v1/messages/m1/await?timeout_ms=${PI_COMS_AWAIT_SLICE_MS}`,
		]);
	});

	test("awaitReply reports a message that became terminal timeout during a slice", async () => {
		const { fetchImpl } = scripted([
			() => ({ body: { msg_id: "m1", status: "timeout", response: null, error: "timeout" } }),
			() => ({ body: { msg_id: "m1", status: "timeout", response: null, error: "timeout" } }),
		]);
		const client = new PiComsClient(config, { fetchImpl });
		const reply = await client.awaitReply("m1", 60_000);
		expect(reply.status).toBe("timeout");
	});

	test("awaitReply gives up when the budget is spent and caps the last slice", async () => {
		let clock = 0;
		const { calls, fetchImpl } = scripted([
			() => {
				clock += 10_000;
				return { body: { msg_id: "m1", status: "timeout", response: null, error: "timeout" } };
			},
			() => ({ body: { msg_id: "m1", status: "delivered", response: null, error: null } }),
			() => ({ body: { ok: true } }),
		]);
		const client = new PiComsClient(config, { fetchImpl, now: () => clock });
		const reply = await client.awaitReply("m1", 10_000);
		expect(reply.status).toBe("budget_exhausted");
		expect(reply.error).toContain("10000");
		expect(calls[0]?.path).toBe("/v1/messages/m1/await?timeout_ms=10000");
	});

	test("deregister only fires after a registration and swallows hub errors", async () => {
		const { calls, fetchImpl } = scripted([
			() => ({ body: { ok: true, agent: { name: PI_COMS_SENDER_NAME } } }),
			() => ({ status: 404, body: { ok: false, error: "agent_not_found" } }),
		]);
		const client = new PiComsClient(config, { fetchImpl, sessionId: "sid-9" });
		await client.deregister();
		expect(calls.length).toBe(0);
		await client.register();
		await client.deregister();
		expect(calls[1]?.method).toBe("DELETE");
		expect(calls[1]?.path).toBe("/v1/agents/sid-9?project=default");
		await client.deregister();
		expect(calls.length).toBe(2);
	});
});
