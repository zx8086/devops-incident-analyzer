// apps/web/src/routes/api/pi/messages/server.test.ts
// SIO-1650: validation and error envelopes of the send and re-await routes, and
// of the mailbox route, with the server module mocked.
import { describe, expect, mock, test } from "bun:test";

class PiFleetRequestError extends Error {
	readonly status: 400 | 404;
	constructor(status: 400 | 404, message: string) {
		super(message);
		this.status = status;
	}
}

const calls: { fn: string; input: unknown }[] = [];
let nextError: Error | undefined;
function record(fn: string, input: unknown, result: unknown) {
	calls.push({ fn, input });
	if (nextError) {
		const err = nextError;
		nextError = undefined;
		throw err;
	}
	return result;
}

mock.module("$lib/server/pi-fleet", () => ({
	PiFleetRequestError,
	sendFleetMessage: async (input: unknown) =>
		record("send", input, {
			hubKey: "eu-shared-services-dev",
			msgId: "m1",
			status: "complete",
			response: { ok: true },
			error: null,
			target: "alpha-dev",
			sender: "pi-fleet-abcd1234",
			sentAt: "2026-09-06T10:00:00.000Z",
		}),
	awaitFleetMessage: async (input: unknown) =>
		record("await", input, {
			hubKey: "eu-shared-services-dev",
			msgId: "m1",
			status: "budget_exhausted",
			response: null,
			error: "x",
		}),
	readFleetMailbox: async (input: unknown) =>
		record("mailbox", input, { hubKey: "eu-shared-services-dev", name: "ops", messages: [] }),
}));

const { GET, POST } = await import("./+server.ts");
const { GET: getMailbox } = await import("../mailbox/+server.ts");

function post(body: unknown) {
	return {
		request: new Request("http://localhost/api/pi/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	} as never;
}

function get(path: string, search: string) {
	return { url: new URL(`http://localhost/api/pi/${path}${search}`) } as never;
}

describe("POST /api/pi/messages", () => {
	test("sends a validated prompt and returns the reply as data", async () => {
		const res = await POST(
			post({ hubKey: "eu-shared-services-dev", target: "alpha-dev", prompt: "Is the ALB healthy?" }),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ msgId: "m1", status: "complete", response: { ok: true } });
		expect(calls.at(-1)).toEqual({
			fn: "send",
			input: { hubKey: "eu-shared-services-dev", target: "alpha-dev", prompt: "Is the ALB healthy?" },
		});
	});

	test("rejects an empty prompt, a missing target and an empty hub key with 400", async () => {
		for (const body of [
			{ hubKey: "eu-shared-services-dev", target: "alpha-dev", prompt: "" },
			{ hubKey: "eu-shared-services-dev", prompt: "p" },
			{ hubKey: "", target: "alpha-dev", prompt: "p" },
		]) {
			const res = await POST(post(body));
			expect(res.status).toBe(400);
			expect((await res.json()).error).toBe("Invalid request");
		}
	});

	test("maps a request error to its status and any other error to 500", async () => {
		nextError = new PiFleetRequestError(404, 'no pi-coms hub "eu-nowhere-prd"');
		const notFound = await POST(post({ hubKey: "eu-nowhere-prd", target: "x", prompt: "p" }));
		expect(notFound.status).toBe(404);
		expect((await notFound.json()).error).toContain('no pi-coms hub "eu-nowhere-prd"');

		nextError = new Error("hub unreachable");
		const failed = await POST(post({ hubKey: "eu-shared-services-dev", target: "x", prompt: "p" }));
		expect(failed.status).toBe(500);
		expect((await failed.json()).error).toBe("hub unreachable");
	});
});

describe("GET /api/pi/messages", () => {
	test("re-awaits by hub and msgId", async () => {
		const res = await GET(get("messages", "?hubKey=eu-shared-services-dev&msgId=m1"));
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ status: "budget_exhausted" });
		expect(calls.at(-1)).toEqual({ fn: "await", input: { hubKey: "eu-shared-services-dev", msgId: "m1" } });
	});

	test("requires both query parameters", async () => {
		const res = await GET(get("messages", "?hubKey=eu-shared-services-dev"));
		expect(res.status).toBe(400);
	});
});

describe("GET /api/pi/mailbox", () => {
	test("reads the hub inbox with optional name and limit", async () => {
		const res = await getMailbox(get("mailbox", "?hubKey=eu-shared-services-dev&name=eu-oit-dev&limit=5"));
		expect(res.status).toBe(200);
		expect(calls.at(-1)).toEqual({
			fn: "mailbox",
			input: { hubKey: "eu-shared-services-dev", name: "eu-oit-dev", limit: 5 },
		});
		await getMailbox(get("mailbox", "?hubKey=eu-shared-services-dev"));
		expect(calls.at(-1)).toEqual({
			fn: "mailbox",
			input: { hubKey: "eu-shared-services-dev", name: undefined, limit: undefined },
		});
	});

	test("rejects a non-numeric limit", async () => {
		const res = await getMailbox(get("mailbox", "?hubKey=eu-shared-services-dev&limit=many"));
		expect(res.status).toBe(400);
	});
});
