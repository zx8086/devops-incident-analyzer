// tests/monitor-coms.integration.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { MonitorComs } from "../scripts/monitor/coms.ts";
import { startHub, stopAllHubs, TOKEN } from "./harness.ts";

afterEach(async () => {
	await stopAllHubs();
});

async function sendWithRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			await new Promise((r) => setTimeout(r, 25 * attempt));
		}
	}
	throw lastError;
}

describe("MonitorComs", () => {
	test("registers, sends with ttl, and answers inbound prompts", async () => {
		const hub = await startHub();
		const agent = new MonitorComs({
			serverUrl: hub.url,
			token: TOKEN,
			project: "default",
			name: "monitor-aws-123",
			purpose: "test monitor",
			onPrompt: async (p) => `pong:${p.prompt}`,
		});
		await agent.start();

		const peer = new MonitorComs({
			serverUrl: hub.url,
			token: TOKEN,
			project: "default",
			name: "laptop",
			purpose: "test operator",
			onPrompt: async () => "ok",
		});
		await peer.start();

		// send + await round trip (agent answers via onPrompt)
		const sent = await agent.send("laptop", "ping", { ttl_ms: 86_400_000 });
		expect(sent.msg_id).toBeTruthy();
		const reply = await peer.send("monitor-aws-123", "run-checks");
		const answer = await peer.awaitReply(reply.msg_id, 10_000);
		expect(answer.error ?? null).toBeNull();
		expect(answer.response).toBe("pong:run-checks");

		await agent.stop();
		await peer.stop();
	});

	test("pending entries are bounded: fire-and-forget sends park nothing, awaited replies clear, cap holds", async () => {
		const hub = await startHub();
		const agent = new MonitorComs({
			serverUrl: hub.url,
			token: TOKEN,
			project: "default",
			name: "monitor-aws-123",
			purpose: "t",
			onPrompt: async (p) => `pong:${p.prompt}`,
		});
		await agent.start();
		const peer = new MonitorComs({
			serverUrl: hub.url,
			token: TOKEN,
			project: "default",
			name: "ops",
			purpose: "t",
			onPrompt: async () => "ok",
		});
		await peer.start();

		await agent.send("ops", "digest", { ttl_ms: 86_400_000, expectReply: false });
		expect(agent.pendingSize()).toBe(0);

		const sent = await peer.send("monitor-aws-123", "status");
		expect(peer.pendingSize()).toBe(1);
		await peer.awaitReply(sent.msg_id, 10_000);
		expect(peer.pendingSize()).toBe(0);

		// 210 rapid sends over keep-alive connections. Bun's fetch reports a closed
		// socket under CI load, and a single retry was not enough on the shared
		// runner (SIO-1633). A duplicate send after a lost response cannot change
		// the result: the assertion is the pending cap, not the send count.
		for (let i = 0; i < 210; i++) {
			await sendWithRetry(() => agent.send("ops", `r${i}`, { ttl_ms: 86_400_000 }));
		}
		expect(agent.pendingSize()).toBe(200);

		await agent.stop();
		await peer.stop();
		// SIO-1693: 210 sequential round trips plus sendWithRetry's backoff do not fit
		// Bun's 5000ms default on a loaded runner -- observed failing at 5043ms. Same
		// explicit budget as the response_schema test below.
	}, 30_000);

	test("long-ttl send to an offline name queues", async () => {
		const hub = await startHub();
		const agent = new MonitorComs({
			serverUrl: hub.url,
			token: TOKEN,
			project: "default",
			name: "monitor-aws-123",
			purpose: "t",
			onPrompt: async () => "",
		});
		await agent.start();
		const sent = await agent.send("nobody-home", "report", { ttl_ms: 86_400_000 });
		expect(sent.status).toBe("queued");
		await agent.stop();
	});
});

// The hub streams the prompt to the target before it answers the sender's
// POST, so an instant reply can beat send(); it must be adopted, never waited
// out (SIO-1673). Many rounds because the ordering is a race by nature.
test("an instant reply that beats send() is adopted instead of timing out", async () => {
	const hub = await startHub();
	const monitor = new MonitorComs({
		serverUrl: hub.url,
		token: TOKEN,
		project: "default",
		name: "monitor-aws-fast",
		purpose: "test monitor",
		onPrompt: async () => "unused",
	});
	await monitor.start();
	const spoke = new MonitorComs({
		serverUrl: hub.url,
		token: TOKEN,
		project: "default",
		name: "aws-fast",
		purpose: "instant refuser",
		onPrompt: async () => {
			throw new Error("recipient muted (monitor-*)");
		},
	});
	await spoke.start();
	await new Promise((r) => setTimeout(r, 100));

	for (let i = 0; i < 10; i++) {
		const sent = await sendWithRetry(() => monitor.send("aws-fast", `investigate ${i}`, { response_schema: {} }));
		const reply = await monitor.awaitReply(sent.msg_id, 3_000);
		expect(reply.error).toBe("recipient muted (monitor-*)");
	}
	expect(monitor.pendingSize()).toBe(0);
	await spoke.stop();
	await monitor.stop();
}, 30_000);
