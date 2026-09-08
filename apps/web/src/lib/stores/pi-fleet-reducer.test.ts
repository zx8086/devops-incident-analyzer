// apps/web/src/lib/stores/pi-fleet-reducer.test.ts
// SIO-1650: the pane's state transitions, kept pure so the runes store stays thin.
import { describe, expect, test } from "bun:test";
import type { PiFleetAgentsResponse } from "../pi-fleet-types.ts";
import {
	applyAgents,
	applyLoadError,
	applySendResult,
	applyStatus,
	expireEntry,
	failEntry,
	formatReply,
	initialPiFleetState,
	isTerminal,
	selectPeer,
	shouldKeepPolling,
	startEntry,
} from "./pi-fleet-reducer.ts";

const listing: PiFleetAgentsResponse = {
	configured: true,
	senderPrefix: "pi-fleet",
	awaitMs: 25_000,
	totalBudgetMs: 60_000,
	hubs: [
		{
			hubKey: "eu-shared-services-prd",
			environment: "prd",
			project: "default",
			fallbackTarget: "ops-prd",
			peers: [{ name: "eu-oit-prd", status: "online", purpose: "aws spoke", sessionId: "s1" }],
			error: null,
		},
		{
			hubKey: "eu-shared-services-dev",
			environment: "dev",
			project: "default",
			fallbackTarget: "ops",
			peers: [
				{ name: "alpha-dev", status: "stale", purpose: null, sessionId: "s2" },
				{ name: "beta-dev", status: "offline", purpose: null, sessionId: "s3" },
			],
			error: null,
		},
	],
};

describe("applyAgents", () => {
	test("flattens peers with their environment, ordered by environment then name", () => {
		const state = applyAgents(initialPiFleetState(), listing);
		expect(state.configured).toBe(true);
		expect(state.loaded).toBe(true);
		expect(state.loadError).toBeNull();
		expect(state.totalBudgetMs).toBe(60_000);
		expect(state.peers.map((p) => `${p.environment}/${p.name}`)).toEqual([
			"dev/alpha-dev",
			"dev/beta-dev",
			"prd/eu-oit-prd",
		]);
	});

	test("keeps the selection while the peer is still listed and clears it otherwise", () => {
		const selected = selectPeer(applyAgents(initialPiFleetState(), listing), {
			hubKey: "eu-shared-services-prd",
			name: "eu-oit-prd",
		});
		expect(applyAgents(selected, listing).selected).toEqual({
			hubKey: "eu-shared-services-prd",
			name: "eu-oit-prd",
		});
		const gone: PiFleetAgentsResponse = {
			...listing,
			hubs: [listing.hubs[1] as PiFleetAgentsResponse["hubs"][number]],
		};
		expect(applyAgents(selected, gone).selected).toBeNull();
	});

	test("an unconfigured listing hides the pane; a load error keeps the last peers", () => {
		const off = applyAgents(initialPiFleetState(), { ...listing, configured: false, hubs: [] });
		expect(off.configured).toBe(false);
		const loaded = applyAgents(initialPiFleetState(), listing);
		const errored = applyLoadError(loaded, "boom");
		expect(errored.loadError).toBe("boom");
		expect(errored.peers.length).toBe(3);
		expect(errored.loaded).toBe(true);
	});
});

describe("entries", () => {
	const base = selectPeer(applyAgents(initialPiFleetState(), listing), {
		hubKey: "eu-shared-services-prd",
		name: "eu-oit-prd",
	});
	const started = startEntry(base, {
		id: "e1",
		hubKey: "eu-shared-services-prd",
		target: "eu-oit-prd",
		prompt: "ping",
		sentAt: 1_000,
	});

	test("startEntry prepends a sending entry", () => {
		expect(started.entries[0]).toMatchObject({ id: "e1", status: "sending", msgId: null, response: null, error: null });
		const second = startEntry(started, {
			id: "e2",
			hubKey: "eu-shared-services-prd",
			target: "eu-oit-prd",
			prompt: "pong",
			sentAt: 2_000,
		});
		expect(second.entries.map((e) => e.id)).toEqual(["e2", "e1"]);
	});

	test("applySendResult records the hub ids and a terminal reply", () => {
		const done = applySendResult(started, "e1", {
			hubKey: "eu-shared-services-prd",
			environment: "prd",
			msgId: "m1",
			status: "complete",
			response: { summary: "fine" },
			error: null,
			target: "eu-oit-prd",
			sender: "pi-fleet-abcd1234",
			sentAt: "x",
		});
		expect(done.entries[0]).toMatchObject({
			msgId: "m1",
			sender: "pi-fleet-abcd1234",
			status: "complete",
			response: { summary: "fine" },
		});
		expect(isTerminal("complete")).toBe(true);
		expect(shouldKeepPolling(done.entries[0] as NonNullable<(typeof done.entries)[0]>, 5_000, 60_000)).toBe(false);
	});

	test("budget_exhausted keeps polling until the pane budget is spent, then expires readably", () => {
		const waiting = applySendResult(started, "e1", {
			hubKey: "eu-shared-services-prd",
			environment: "prd",
			msgId: "m1",
			status: "budget_exhausted",
			response: null,
			error: "no reply within 25000 ms",
			target: "eu-oit-prd",
			sender: "pi-fleet-abcd1234",
			sentAt: "x",
		});
		const entry = waiting.entries[0] as NonNullable<(typeof waiting.entries)[0]>;
		expect(isTerminal(entry.status)).toBe(false);
		expect(shouldKeepPolling(entry, 26_000, 60_000)).toBe(true);
		expect(shouldKeepPolling(entry, 61_001, 60_000)).toBe(false);
		const expired = expireEntry(waiting, "e1", 60_000);
		expect(expired.entries[0]).toMatchObject({ status: "expired", error: "no reply from eu-oit-prd within 60 s" });
		expect(isTerminal("expired")).toBe(true);
	});

	test("applyStatus keeps the sender from the send response and failEntry records a route failure", () => {
		const waiting = applySendResult(started, "e1", {
			hubKey: "eu-shared-services-prd",
			environment: "prd",
			msgId: "m1",
			status: "delivered",
			response: null,
			error: null,
			target: "eu-oit-prd",
			sender: "pi-fleet-abcd1234",
			sentAt: "x",
		});
		const done = applyStatus(waiting, "e1", {
			hubKey: "eu-shared-services-prd",
			environment: "prd",
			msgId: "m1",
			status: "error",
			response: null,
			error: "spoke crashed",
		});
		expect(done.entries[0]).toMatchObject({ sender: "pi-fleet-abcd1234", status: "error", error: "spoke crashed" });
		const failed = failEntry(started, "e1", "hub unreachable");
		expect(failed.entries[0]).toMatchObject({ status: "failed", error: "hub unreachable" });
		expect(isTerminal("failed")).toBe(true);
	});
});

describe("formatReply", () => {
	test("renders strings verbatim, null as empty and objects as pretty JSON", () => {
		expect(formatReply("plain text")).toBe("plain text");
		expect(formatReply(null)).toBe("");
		expect(formatReply(undefined)).toBe("");
		expect(formatReply({ a: 1 })).toBe('{\n  "a": 1\n}');
	});
});
