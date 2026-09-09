// tests/hub-validation.integration.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	api,
	type ErrorResponse,
	type InboxListing,
	type MessageLookup,
	register,
	type SendResponse,
	send,
	startHub,
	stopAllHubs,
	TOKEN,
} from "./harness.ts";

afterEach(async () => {
	await stopAllHubs();
});

describe("hub request validation", () => {
	test("a project name that is not a plain directory name is 400", async () => {
		const hub = await startHub();
		const r = await api(hub, "POST", "/v1/agents/register", {
			project: "../../evil",
			session_id: "S1",
			name: "x",
			purpose: "",
			model: "t",
			color: "#888888",
			cwd: "/tmp",
			explicit: false,
		});
		expect(r.status).toBe(400);
		expect(((await r.json()) as ErrorResponse).error).toBe("invalid_project");
		expect(fs.existsSync(path.join(hub.home, ".pi", "coms-net", "evil"))).toBe(false);
		expect((await api(hub, "GET", "/v1/mailbox?project=..&name=ops")).status).toBe(400);
	});

	test("reading the inbox of an unknown project is empty and creates nothing on disk", async () => {
		const hub = await startHub();
		const r = await api(hub, "GET", "/v1/mailbox?project=nope&name=ops");
		expect(r.status).toBe(200);
		expect(((await r.json()) as InboxListing).messages).toEqual([]);
		expect(fs.existsSync(path.join(hub.home, ".pi", "coms-net", "projects", "nope"))).toBe(false);
	});

	test("a request body above the cap is 413", async () => {
		const hub = await startHub(undefined, { PI_COMS_NET_MAX_BODY_BYTES: "65536" });
		await register(hub, "S1", "a");
		const r = await api(hub, "POST", "/v1/messages", {
			project: "default",
			sender_session: "S1",
			target: "a",
			target_session: null,
			prompt: "x".repeat(70_000),
			conversation_id: null,
			response_schema: null,
			hops: 0,
		});
		expect(r.status).toBe(413);
	});

	test("with the shared token every caller owns every session", async () => {
		const hub = await startHub();
		await register(hub, "S1", "a");
		await register(hub, "S2", "b");
		const hb = { project: "default", context_used_pct: 1, queue_depth: 0 };
		expect((await api(hub, "POST", "/v1/agents/S1/heartbeat", hb, TOKEN)).status).toBe(200);
		expect((await api(hub, "DELETE", "/v1/agents/S2?project=default", undefined, TOKEN)).status).toBe(200);
	});
});

// SIO-1678: a responder that posts a blank body with no error was stored as a
// completed reply; every sender then read "" as an answer.
describe("blank replies", () => {
	test("a blank response with no error is stored as error empty_reply, never complete", async () => {
		const hub = await startHub();
		await register(hub, "S1", "asker");
		await register(hub, "S2", "spoke");
		const sent = (await (await send(hub, "S1", "spoke", "Reply with exactly: ok")).json()) as SendResponse;
		for (const blank of ["", "   \n", null]) {
			const r = await api(hub, "POST", `/v1/messages/${sent.msg_id}/response`, {
				project: "default",
				responder_session: "S2",
				response: blank,
				error: null,
			});
			// Only the first submission lands; the message is terminal afterwards.
			if (blank === "") expect(r.status).toBe(200);
			else expect(r.status).toBe(409);
		}
		const looked = (await (await api(hub, "GET", `/v1/messages/${sent.msg_id}`)).json()) as MessageLookup;
		expect(looked.status).toBe("error");
		expect(looked.error).toBe("empty_reply");
	});

	test("a blank error string with a blank body is still empty_reply", async () => {
		const hub = await startHub();
		await register(hub, "S1", "asker");
		await register(hub, "S2", "spoke");
		const sent = (await (await send(hub, "S1", "spoke", "hi")).json()) as SendResponse;
		const r = await api(hub, "POST", `/v1/messages/${sent.msg_id}/response`, {
			project: "default",
			responder_session: "S2",
			response: "",
			error: "",
		});
		expect(r.status).toBe(200);
		const looked = (await (await api(hub, "GET", `/v1/messages/${sent.msg_id}`)).json()) as MessageLookup;
		expect(looked.status).toBe("error");
		expect(looked.error).toBe("empty_reply");
	});

	test("an explicit error keeps its own text", async () => {
		const hub = await startHub();
		await register(hub, "S1", "asker");
		await register(hub, "S2", "spoke");
		const sent = (await (await send(hub, "S1", "spoke", "hi")).json()) as SendResponse;
		const r = await api(hub, "POST", `/v1/messages/${sent.msg_id}/response`, {
			project: "default",
			responder_session: "S2",
			response: null,
			error: "agent run error: AccessDeniedException: Model access is denied",
		});
		expect(r.status).toBe(200);
		const looked = (await (await api(hub, "GET", `/v1/messages/${sent.msg_id}`)).json()) as MessageLookup;
		expect(looked.status).toBe("error");
		expect(looked.error).toBe("agent run error: AccessDeniedException: Model access is denied");
	});
});
