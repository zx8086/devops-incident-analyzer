// agent/src/action-tools/pi-coms-client.test.ts
// SIO-1635: the client is exercised against a scripted fetch at the network
// boundary; no hub process is spawned.
import { describe, expect, test } from "bun:test";
import type { PiComsHubConfig } from "@devops-agent/shared";
import {
	isMonitorAgentName,
	isPiComsConfigured,
	PI_COMS_AWAIT_SLICE_MS,
	PI_COMS_SENDER_NAME_PREFIX,
	PiComsClient,
	PiComsHttpError,
	resolvePiComsConfig,
	senderNameFor,
	spokesOnly,
} from "./pi-coms-client.ts";

describe("SIO-1665 monitor names", () => {
	test("the monitor- prefix marks a monitor, in both the bootstrap and code-default forms", () => {
		expect(isMonitorAgentName("monitor-eu-oit-prd")).toBe(true);
		expect(isMonitorAgentName("monitor-aws-123456789012")).toBe(true);
		expect(isMonitorAgentName("eu-oit-prd")).toBe(false);
		expect(isMonitorAgentName("ops")).toBe(false);
		// The prefix, not a substring: a spoke whose name merely contains it stays.
		expect(isMonitorAgentName("eu-monitor-prd")).toBe(false);
	});

	test("spokesOnly drops monitors and keeps every other card in order", () => {
		const cards = [
			{ name: "monitor-eu-oit-prd", status: "online" },
			{ name: "eu-oit-prd", status: "online" },
			{ name: "eu-shared-services-prd", status: "stale" },
			{ name: "monitor-eu-shared-services-prd", status: "online" },
		];
		expect(spokesOnly(cards).map((c) => c.name)).toEqual(["eu-oit-prd", "eu-shared-services-prd"]);
	});
});

const hub: PiComsHubConfig = {
	serverUrl: "http://hub.test",
	authToken: "tok",
	project: "default",
	fallbackTarget: "ops",
	environment: "prd",
	estates: ["eu-oit-prd"],
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
			path: input.replace(hub.serverUrl, ""),
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
	test("senderNameFor derives a unique prefixed name from the session id", () => {
		expect(senderNameFor("0f1e2d3c-4b5a-6978-8899-aabbccddeeff")).toBe(`${PI_COMS_SENDER_NAME_PREFIX}-0f1e2d3c`);
		expect(senderNameFor("abc")).toBe(`${PI_COMS_SENDER_NAME_PREFIX}-abc`);
	});

	test("register posts an explicit sender card with the bearer token", async () => {
		const { calls, fetchImpl } = scripted([() => ({ body: { ok: true, agent: { name: "incident-analyzer-sid1" } } })]);
		const client = new PiComsClient(hub, { fetchImpl, sessionId: "sid-1" });
		await client.register();
		expect(calls[0]?.path).toBe("/v1/agents/register");
		expect(calls[0]?.headers.authorization).toBe("Bearer tok");
		const body = calls[0]?.body as Record<string, unknown>;
		expect(body.session_id).toBe("sid-1");
		expect(body.name).toBe(`${PI_COMS_SENDER_NAME_PREFIX}-sid1`);
		expect(body.explicit).toBe(true);
		expect(body.project).toBe("default");
	});

	test("send forwards target, schema, conversation id and optional ttl", async () => {
		const { calls, fetchImpl } = scripted([
			() => ({ body: { ok: true, msg_id: "m1", status: "delivered", target_session: "t1" } }),
			() => ({ body: { ok: true, msg_id: "m2", status: "queued", target_session: null } }),
		]);
		const client = new PiComsClient(hub, { fetchImpl, sessionId: "sid-1" });
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
		const client = new PiComsClient(hub, { fetchImpl });
		const err = await client.send("ghost", "hi").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PiComsHttpError);
		expect((err as PiComsHttpError).status).toBe(404);
		expect((err as PiComsHttpError).code).toBe("target_not_found");
	});

	// SIO-1661: the hub reports a rejection as { error, details }; the details name
	// the refused name and the principal that refused it. Keep them on the error
	// rather than discarding them -- that loss is what forced live curl probing.
	test("a rejection keeps the hub's details alongside the status and code", async () => {
		const { fetchImpl } = scripted([
			() => ({
				status: 403,
				body: {
					ok: false,
					error: "name_not_allowed",
					details: { name: "pi-fleet-abcd1234", principal: "incident-analyzer" },
				},
			}),
		]);
		const client = new PiComsClient(hub, { fetchImpl, senderPrefix: "pi-fleet", sessionId: "abcd1234-0000" });
		const err = (await client.register().catch((e: unknown) => e)) as PiComsHttpError;
		expect(err).toBeInstanceOf(PiComsHttpError);
		expect(err.status).toBe(403);
		expect(err.code).toBe("name_not_allowed");
		expect(err.details).toEqual({ name: "pi-fleet-abcd1234", principal: "incident-analyzer" });
		// register is the only frame that knows the name it sent, so it names it.
		expect(err.message.split("\n")[0]).toBe("pi-coms hub POST /v1/agents/register failed: 403 name_not_allowed");
		expect(err.message).toContain('sender "pi-fleet-abcd1234"');
		expect(err.message).toContain('principal "incident-analyzer"');
	});

	test("a rejection without a details object degrades to empty rather than throwing", async () => {
		const { fetchImpl } = scripted([() => ({ status: 409, body: { ok: false, error: "name_taken" } })]);
		const client = new PiComsClient(hub, { fetchImpl, sessionId: "sid-1" });
		const err = (await client.register().catch((e: unknown) => e)) as PiComsHttpError;
		expect(err.details).toEqual({});
		expect(err.code).toBe("name_taken");
		// Still names the sender; the principal clause is simply absent.
		expect(err.message).toContain(`sender "${PI_COMS_SENDER_NAME_PREFIX}-sid1"`);
		expect(err.message).not.toContain("principal");
	});

	test("awaitReply returns the terminal reply from a single slice", async () => {
		const { calls, fetchImpl } = scripted([
			() => ({ body: { msg_id: "m1", status: "complete", response: { ok: 1 }, error: null } }),
		]);
		const client = new PiComsClient(hub, { fetchImpl });
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
		const client = new PiComsClient(hub, { fetchImpl, sessionId: "sid-1", now: () => clock });
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
		const client = new PiComsClient(hub, { fetchImpl });
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
		const client = new PiComsClient(hub, { fetchImpl, now: () => clock });
		const reply = await client.awaitReply("m1", 10_000);
		expect(reply.status).toBe("budget_exhausted");
		expect(reply.error).toContain("10000");
		expect(calls[0]?.path).toBe("/v1/messages/m1/await?timeout_ms=10000");
	});

	test("senderNameFor accepts a prefix and the client registers with it", async () => {
		expect(senderNameFor("abcd1234-x", "fleet-inbox")).toBe("fleet-inbox-abcd1234");
		const { calls, fetchImpl } = scripted([() => ({ body: { ok: true } })]);
		const client = new PiComsClient(hub, { fetchImpl, sessionId: "sid-1", senderPrefix: "fleet-inbox" });
		await client.register();
		const body = calls[0]?.body as Record<string, unknown>;
		expect(body.name).toBe("fleet-inbox-sid1");
	});

	test("heartbeat is public and posts the online status", async () => {
		const { calls, fetchImpl } = scripted([() => ({ body: { ok: true } })]);
		const client = new PiComsClient(hub, { fetchImpl, sessionId: "sid-1" });
		await client.heartbeat();
		expect(calls[0]?.path).toBe("/v1/agents/sid-1/heartbeat");
		const body = calls[0]?.body as Record<string, unknown>;
		expect(body.status).toBe("online");
	});

	test("mailbox reads the durable inbox with project, name, limit and since", async () => {
		const message = {
			msg_id: "01H",
			sender_name: "monitor-aws-1",
			target_name: "ops",
			prompt: "p",
			status: "queued",
			error: null,
			response: null,
			created_at: "t",
			delivered_at: null,
			completed_at: null,
		};
		const { calls, fetchImpl } = scripted([() => ({ body: { ok: true, name: "ops", messages: [message] } })]);
		const client = new PiComsClient(hub, { fetchImpl });
		const messages = await client.mailbox("ops", { limit: 5, since: "01G" });
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.path).toBe("/v1/mailbox?project=default&name=ops&limit=5&since=01G");
		expect(messages).toEqual([message]);
	});

	test("deregister only fires after a registration and swallows hub errors", async () => {
		const { calls, fetchImpl } = scripted([
			() => ({ body: { ok: true, agent: { name: "incident-analyzer-sid9" } } }),
			() => ({ status: 404, body: { ok: false, error: "agent_not_found" } }),
		]);
		const client = new PiComsClient(hub, { fetchImpl, sessionId: "sid-9" });
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

describe("resolvePiComsConfig (per-environment hubs)", () => {
	test("PI_COMS_HUBS json wins and fills project and fallback defaults per hub", () => {
		const cfg = resolvePiComsConfig({
			PI_COMS_HUBS: JSON.stringify({
				dev: { serverUrl: "http://dev.hub.test", authToken: "d", environment: "dev", estates: ["eu-oit-dev"] },
				prd: {
					serverUrl: "http://prd.hub.test",
					authToken: "p",
					project: "fleet",
					fallbackTarget: "ops-prd",
					environment: "prd",
					estates: ["eu-oit-prd"],
				},
			}),
		});
		expect(cfg.hubs.dev).toEqual({
			serverUrl: "http://dev.hub.test",
			authToken: "d",
			project: "default",
			fallbackTarget: "ops",
			environment: "dev",
			estates: ["eu-oit-dev"],
		});
		expect(cfg.hubs.prd?.project).toBe("fleet");
		expect(cfg.hubs.stg).toBeUndefined();
	});

	test("the single-hub variables become a one-entry map for PI_COMS_NET_ENVIRONMENT (default dev)", () => {
		const cfg = resolvePiComsConfig({ PI_COMS_NET_SERVER_URL: "http://hub.test", PI_COMS_NET_AUTH_TOKEN: "t" });
		expect(Object.keys(cfg.hubs)).toEqual(["dev"]);
		const prd = resolvePiComsConfig({
			PI_COMS_NET_SERVER_URL: "http://hub.test",
			PI_COMS_NET_AUTH_TOKEN: "t",
			PI_COMS_NET_ENVIRONMENT: "prd",
		});
		expect(Object.keys(prd.hubs)).toEqual(["prd"]);
	});

	test("a malformed PI_COMS_HUBS is a readable error, never a silent fallback", () => {
		expect(() =>
			resolvePiComsConfig({
				PI_COMS_HUBS: "{not json",
				PI_COMS_NET_SERVER_URL: "http://hub.test",
				PI_COMS_NET_AUTH_TOKEN: "t",
			}),
		).toThrow("PI_COMS_HUBS");
		expect(() =>
			resolvePiComsConfig({ PI_COMS_HUBS: JSON.stringify({ qa: { serverUrl: "http://x.test", authToken: "t" } }) }),
		).toThrow("PI_COMS_HUBS");
	});

	test("isPiComsConfigured accepts either form", () => {
		expect(isPiComsConfigured({})).toBe(false);
		expect(isPiComsConfigured({ PI_COMS_HUBS: "{}" })).toBe(false);
		expect(isPiComsConfigured({ PI_COMS_HUBS: '{"dev":{"serverUrl":"http://x.test","authToken":"t"}}' })).toBe(true);
		expect(isPiComsConfigured({ PI_COMS_NET_SERVER_URL: "http://x.test", PI_COMS_NET_AUTH_TOKEN: "t" })).toBe(true);
	});
});
