// tests/inbox.integration.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import {
	api,
	type InboxListing,
	readSseEvents,
	register,
	type SendResponse,
	send,
	startHub,
	stopAllHubs,
	stopHub,
	TOKEN,
} from "./harness.ts";

afterEach(async () => {
	await stopAllHubs();
});

describe("shared inbox", () => {
	test("two sessions read the same inbox, including completed reports", async () => {
		const hub = await startHub();
		await register(hub, "SENDER", "monitor");
		await send(hub, "SENDER", "ops", "report one", 86_400_000);
		await Bun.sleep(10);
		const s2 = await send(hub, "SENDER", "ops", "report two", 86_400_000);
		const { msg_id: secondId } = (await s2.json()) as SendResponse;

		// Deliver and complete the first report through a duty session.
		const sseUrl = await register(hub, "DUTY", "ops");
		const resp = await fetch(hub.url + sseUrl, { headers: { authorization: `Bearer ${TOKEN}` } });
		const prompts = await readSseEvents(resp, "prompt", 2);
		await api(hub, "POST", `/v1/messages/${prompts[0].msg_id}/response`, {
			project: "default",
			responder_session: "DUTY",
			response: "ack",
			error: null,
		});
		await resp.body?.cancel();

		// Two other operators read the same inbox on demand.
		await register(hub, "USER1", "simon");
		await register(hub, "USER2", "jane");
		const read = async () => {
			const r = await api(hub, "GET", "/v1/mailbox?project=default&name=ops&limit=10");
			expect(r.status).toBe(200);
			return ((await r.json()) as InboxListing).messages;
		};
		const one = await read();
		const two = await read();
		expect(one).toEqual(two);
		expect(one).toHaveLength(2);
		expect(one.map((m) => m.prompt)).toEqual(["report one", "report two"]);
		expect(one[0].status).toBe("complete"); // completed mail stays readable
		expect(one[0].sender_name).toBe("monitor");

		// since-cursor: only the second report comes back.
		const r = await api(hub, "GET", `/v1/mailbox?project=default&name=ops&limit=10&since=${one[0].msg_id}`);
		const newer = ((await r.json()) as InboxListing).messages;
		expect(newer.map((m) => m.msg_id)).toEqual([secondId]);
	});

	test("inbox survives a hub restart", async () => {
		const hub = await startHub();
		await register(hub, "SENDER", "monitor");
		await send(hub, "SENDER", "ops", "durable report", 86_400_000);
		const home = hub.home;
		await stopHub(hub);
		const hub2 = await startHub(home);
		await register(hub2, "USER1", "simon");
		const r = await api(hub2, "GET", "/v1/mailbox?project=default&name=ops&limit=10");
		const msgs = ((await r.json()) as InboxListing).messages;
		expect(msgs.map((m) => m.prompt)).toEqual(["durable report"]);
	});

	test("a completed conversation becomes part of the target's inbox, an in-flight one does not (SIO-1620)", async () => {
		const hub = await startHub();
		await register(hub, "SENDER", "monitor");
		const sseUrl = await register(hub, "TGT", "helper");
		const resp = await fetch(hub.url + sseUrl, { headers: { authorization: `Bearer ${TOKEN}` } });
		await Bun.sleep(100);
		await send(hub, "SENDER", "helper", "quick question"); // default TTL
		const [prompt] = await readSseEvents(resp, "prompt", 1);

		// delivered but unanswered: not history yet
		let r = await api(hub, "GET", "/v1/mailbox?project=default&name=helper&limit=10");
		expect(((await r.json()) as InboxListing).messages).toHaveLength(0);

		await api(hub, "POST", `/v1/messages/${prompt.msg_id}/response`, {
			project: "default",
			responder_session: "TGT",
			response: "answer",
			error: null,
		});
		await resp.body?.cancel();
		r = await api(hub, "GET", "/v1/mailbox?project=default&name=helper&limit=10");
		const msgs = ((await r.json()) as InboxListing).messages;
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toMatchObject({
			prompt: "quick question",
			status: "complete",
			response: "answer",
			sender_name: "monitor",
		});
		// the shared ops inbox is untouched by conversations with other names
		const ops = await api(hub, "GET", "/v1/mailbox?project=default&name=ops&limit=10");
		expect(((await ops.json()) as InboxListing).messages).toHaveLength(0);
	});

	test("a conversation leaves hub memory after the message TTL but stays on disk until the retention window (SIO-1620)", async () => {
		// SIO-1785: PI_COMS_NET_MESSAGE_TTL_MS governs two things in the hub. It is how long a
		// COMPLETED conversation stays in memory (what this test is about), and it is also how
		// long an UNANSWERED message lives before ttlScanTick marks it `expired`. The second one
		// applies to this test's own round trip: send, read the prompt off SSE, POST the response.
		// At the old 200 ms a CI runner took longer than that, the message expired first, the
		// response was refused, and the inbox row carried `response: null` (PR #817, run
		// 35238949885). The hub is a spawned process on real timers, so there is no clock to
		// inject; the margin has to be real. The round trip exceeded 200 ms on the failing
		// runner, so 2000 ms leaves roughly an order of magnitude. Retention is set well clear of
		// it so "out of memory, still on disk" is a window the assertions can land in, not an
		// instant.
		const MESSAGE_TTL_MS = 2000;
		const SCAN_MS = 100;
		const RETAIN_MS = 4000;
		const POLL_MS = 100;
		const hub = await startHub(undefined, {
			PI_COMS_NET_MESSAGE_TTL_MS: String(MESSAGE_TTL_MS),
			PI_COMS_NET_TTL_SCAN_MS: String(SCAN_MS),
			PI_COMS_NET_HISTORY_RETAIN_MS: String(RETAIN_MS),
		});
		await register(hub, "SENDER", "monitor");
		const sseUrl = await register(hub, "TGT", "helper");
		const resp = await fetch(hub.url + sseUrl, { headers: { authorization: `Bearer ${TOKEN}` } });
		await Bun.sleep(100);
		await send(hub, "SENDER", "helper", "remember me");
		const [prompt] = await readSseEvents(resp, "prompt", 1);
		const answered = await api(hub, "POST", `/v1/messages/${prompt.msg_id}/response`, {
			project: "default",
			responder_session: "TGT",
			response: "kept",
			error: null,
		});
		// Fail HERE if the race ever comes back, not two assertions later on a null response.
		expect(answered.status).toBe(200);
		await resp.body?.cancel();

		// Still in memory right after completion: eviction is the TTL, not the completion.
		expect((await api(hub, "GET", `/v1/messages/${prompt.msg_id}`)).status).toBe(200);

		// past the message TTL: gone from the live message map, present in the inbox.
		// Eviction lands at most one scan after the TTL; the bound is twice that.
		let inMemory = 200;
		for (let i = 0; i < (2 * (MESSAGE_TTL_MS + SCAN_MS)) / POLL_MS && inMemory !== 404; i++) {
			await Bun.sleep(POLL_MS);
			inMemory = (await api(hub, "GET", `/v1/messages/${prompt.msg_id}`)).status;
		}
		expect(inMemory).toBe(404);
		let r = await api(hub, "GET", "/v1/mailbox?project=default&name=helper&limit=10");
		expect(((await r.json()) as InboxListing).messages.map((m) => m.response)).toEqual(["kept"]);

		// past the retention window: purged. Retention counts from completion, so the wait
		// left is RETAIN_MS minus what the loop above already spent; the full window bounds it.
		let left = 1;
		for (let i = 0; i < (RETAIN_MS + SCAN_MS) / POLL_MS && left !== 0; i++) {
			await Bun.sleep(POLL_MS);
			r = await api(hub, "GET", "/v1/mailbox?project=default&name=helper&limit=10");
			left = ((await r.json()) as InboxListing).messages.length;
		}
		expect(left).toBe(0);
	}, 20_000);

	test("mailbox endpoint requires auth and a name", async () => {
		const hub = await startHub();
		const noAuth = await fetch(`${hub.url}/v1/mailbox?name=ops`);
		expect(noAuth.status).toBe(401);
		const noName = await api(hub, "GET", "/v1/mailbox?project=default");
		expect(noName.status).toBe(400);
	});
});
