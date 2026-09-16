// tests/hub-run-health.integration.test.ts
import { afterEach, expect, test } from "bun:test";
import { type AgentListing, api, register, startHub, stopAllHubs } from "./harness.ts";

afterEach(async () => {
	await stopAllHubs();
});

// SIO-1681: a spoke whose model calls all fail is still alive and heartbeating,
// so it keeps reporting `status: "online"` and carries its failure count beside
// it. eu-oit-prd sat "online" for two hours that way on 2026-09-09.
async function heartbeat(hub: Parameters<typeof api>[0], body: Record<string, unknown>): Promise<void> {
	const r = await api(hub, "POST", "/v1/agents/S1/heartbeat", { project: "default", ...body });
	expect(r.status).toBe(200);
}

async function card(hub: Parameters<typeof api>[0]) {
	const r = await api(hub, "GET", "/v1/agents?project=default");
	expect(r.status).toBe(200);
	const listing = (await r.json()) as AgentListing;
	const agent = listing.agents.find((a) => a.session_id === "S1");
	expect(agent).toBeDefined();
	return agent;
}

test("the hub records a spoke's model-failure count without touching its liveness", async () => {
	const hub = await startHub();
	await register(hub, "S1", "eu-oit-prd");

	await heartbeat(hub, {
		context_used_pct: 12,
		queue_depth: 0,
		consecutive_run_errors: 9,
		last_run_error: "AccessDeniedException: Model access is denied",
	});

	const sick = await card(hub);
	expect(sick?.consecutive_run_errors).toBe(9);
	expect(sick?.last_run_error).toContain("AccessDeniedException");
	// The whole point: it is online AND failing. Folding this into `status`
	// would have claimed the spoke was unreachable, which it is not.
	expect(sick?.status).toBe("online");

	// One good turn clears it.
	await heartbeat(hub, { context_used_pct: 12, queue_depth: 0, consecutive_run_errors: 0 });
	const healthy = await card(hub);
	expect(healthy?.consecutive_run_errors).toBe(0);
	expect(healthy?.last_run_error).toBeUndefined();
});

// An older spoke build omits the field entirely. Treating "absent" as zero
// would silently report a sick spoke as recovered on its next heartbeat.
test("a heartbeat that omits the count leaves the last reading standing", async () => {
	const hub = await startHub();
	await register(hub, "S1", "eu-oit-prd");

	await heartbeat(hub, { context_used_pct: 5, queue_depth: 0, consecutive_run_errors: 4, last_run_error: "403" });
	expect((await card(hub))?.consecutive_run_errors).toBe(4);

	await heartbeat(hub, { context_used_pct: 6, queue_depth: 0 });
	const after = await card(hub);
	expect(after?.consecutive_run_errors).toBe(4);
	expect(after?.last_run_error).toBe("403");
});

// Greptile P1 on PR #800, verified: a session re-registers on every SSE
// reconnect, and registration rebuilds the card from `existing` field by field.
// Without carrying these over, a failing spoke reads healthy until its next
// heartbeat -- the same "silence is not recovery" rule as the heartbeat path.
test("re-registering the same session keeps the failure count", async () => {
	const hub = await startHub();
	await register(hub, "S1", "eu-oit-prd");
	await heartbeat(hub, { context_used_pct: 8, queue_depth: 0, consecutive_run_errors: 6, last_run_error: "403" });
	expect((await card(hub))?.consecutive_run_errors).toBe(6);

	// Exactly what a reconnect does: same session_id, same name.
	await register(hub, "S1", "eu-oit-prd");
	const after = await card(hub);
	expect(after?.consecutive_run_errors).toBe(6);
	expect(after?.last_run_error).toBe("403");
});
