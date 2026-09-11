// tests/response-shape.integration.test.ts
// SIO-1698: a schema-constrained reply arrives as a parsed OBJECT. The submit
// handler used String(), which stored the literal "[object Object]" and
// destroyed every verify-with-pi / investigate-with-pi verdict before it
// reached the sender. These drive the real hub over HTTP: the shape the sender
// reads back is the contract, not an internal detail.
import { afterEach, describe, expect, test } from "bun:test";
import { decodeStoredResponse } from "../scripts/coms-net-server.ts";
import { api, type MessageLookup, register, type SendResponse, send, startHub, stopAllHubs } from "./harness.ts";

afterEach(async () => {
	await stopAllHubs();
});

async function sendAndReply(
	hub: Awaited<ReturnType<typeof startHub>>,
	response: unknown,
): Promise<{ msg_id: string; submit: Response }> {
	await register(hub, "SENDER", "sender");
	await register(hub, "TARGET", "target");
	const sent = await send(hub, "SENDER", "target", "verify this report");
	const { msg_id } = (await sent.json()) as SendResponse;
	const submit = await api(hub, "POST", `/v1/messages/${msg_id}/response`, {
		project: "default",
		responder_session: "TARGET",
		response,
		error: null,
	});
	return { msg_id, submit };
}

async function lookup(hub: Awaited<ReturnType<typeof startHub>>, msg_id: string): Promise<MessageLookup> {
	const r = await api(hub, "GET", `/v1/messages/${msg_id}`);
	return (await r.json()) as MessageLookup;
}

describe("response shape round-trip (SIO-1698)", () => {
	test("an object reply survives intact instead of becoming [object Object]", async () => {
		const hub = await startHub();
		const verdict = {
			verdict: "partially_confirmed",
			summary: "AWS-side claims confirmed.",
			claims: [{ claim: "3/3 ECS tasks", status: "confirmed", evidence: "describe-services" }],
			additional_observations: ["CPU-low alarm at 11:59:36Z"],
			recommended_investigation: null,
		};
		const { msg_id, submit } = await sendAndReply(hub, verdict);
		expect(submit.status).toBe(200);

		const got = await lookup(hub, msg_id);
		expect(got.status).toBe("complete");
		// The exact regression: this was the string "[object Object]".
		expect(typeof got.response).toBe("object");
		expect(got.response).toEqual(verdict);
	});

	test("a nested array reply round-trips", async () => {
		const hub = await startHub();
		const payload = { evidence: [{ resource: "ecs:svc", observation: "3/3" }], confidence: 0.8 };
		const { msg_id } = await sendAndReply(hub, payload);
		expect((await lookup(hub, msg_id)).response).toEqual(payload);
	});

	test("a plain-text reply is still a string, not a JSON-wrapped one", async () => {
		// The fleet pane path: no response_schema, prose reply. Storage now
		// serializes it, so the reader must hand back the same bare string.
		const hub = await startHub();
		const { msg_id } = await sendAndReply(hub, "all three targets are healthy");
		const got = await lookup(hub, msg_id);
		expect(got.response).toBe("all three targets are healthy");
	});

	test("a blank reply is still recorded as an error (SIO-1678 unaffected)", async () => {
		const hub = await startHub();
		const { msg_id } = await sendAndReply(hub, "   ");
		const got = await lookup(hub, msg_id);
		expect(got.status).toBe("error");
		expect(got.error).toBe("empty_reply");
	});

	test("an oversized object is refused rather than silently truncated", async () => {
		// capReplyBody appends a marker, which would make serialized JSON
		// unparseable -- a half-object is worse than a clear error.
		const hub = await startHub(undefined, { PI_COMS_NET_REPLY_CAP_BYTES: "512" });
		const big = { summary: "x".repeat(2000) };
		const { msg_id, submit } = await sendAndReply(hub, big);
		expect(submit.status).toBe(413);
		const got = await lookup(hub, msg_id);
		expect(got.status).toBe("error");
		expect(got.error).toBe("reply_too_large");
	});

	test("decodeStoredResponse survives a pre-fix [object Object] row", () => {
		// Rows written before this fix hold a bare `[object Object]`, which is not
		// JSON. The body was never stored and is unrecoverable, but a listing that
		// spans one must not throw -- one poisoned row would take out a whole
		// mailbox or inbox page. The broken text stays visible rather than vanishing.
		expect(decodeStoredResponse("[object Object]")).toBe("[object Object]");
		expect(decodeStoredResponse(null)).toBeNull();
		expect(decodeStoredResponse('{"verdict":"confirmed"}')).toEqual({ verdict: "confirmed" });
		expect(decodeStoredResponse('"plain text"')).toBe("plain text");
	});

	test("an oversized STRING is still capped, not refused", async () => {
		const hub = await startHub(undefined, { PI_COMS_NET_REPLY_CAP_BYTES: "512" });
		const { msg_id, submit } = await sendAndReply(hub, "y".repeat(2000));
		expect(submit.status).toBe(200);
		const got = await lookup(hub, msg_id);
		expect(got.status).toBe("complete");
		expect(typeof got.response).toBe("string");
		expect(got.response as string).toContain("[truncated by hub]");
	});
});
