// apps/web/src/lib/components/PiFleetPane.test.ts
// SIO-1650: SSR shape checks for the pi-fleet pane. The send, select and refresh
// handlers are runes-driven and are covered by the manual e2e against a hub.
import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";
import type { PiFleetAgentsResponse } from "../pi-fleet-types.ts";
import {
	applyAgents,
	applySendResult,
	expireEntry,
	initialPiFleetState,
	type PiFleetState,
	selectPeer,
	startEntry,
} from "../stores/pi-fleet-reducer.ts";
import PiFleetPane from "./PiFleetPane.svelte";

const noop = () => undefined;
const handlers = { onSend: noop, onRefresh: noop, onSelect: noop, onLoadMailbox: noop };

const listing: PiFleetAgentsResponse = {
	configured: true,
	senderPrefix: "pi-fleet",
	awaitMs: 25_000,
	totalBudgetMs: 300_000,
	hubs: [
		{
			hubKey: "eu-shared-services-dev",
			environment: "dev",
			project: "default",
			fallbackTarget: "ops",
			peers: [{ name: "alpha-dev", status: "online", purpose: "aws spoke", sessionId: "s1" }],
			error: null,
		},
		{
			hubKey: "eu-shared-services-prd",
			environment: "prd",
			project: "default",
			fallbackTarget: "ops-prd",
			peers: [],
			error: "hub GET failed: 500",
		},
	],
};

function renderPane(state: PiFleetState, busy = false): string {
	return render(PiFleetPane, { props: { pane: state, busy, mailboxBusy: null, ...handlers } }).body;
}

describe("PiFleetPane", () => {
	test("lists peers under their environment with status and purpose, and shows a hub error inline", () => {
		const body = renderPane(applyAgents(initialPiFleetState(), listing));
		expect(body).toContain("alpha-dev");
		expect(body).toContain("aws spoke");
		expect(body).toContain("online");
		expect(body).toContain("dev");
		expect(body).toContain("hub GET failed: 500");
	});

	test("shows the empty-state copy before any peer is selected", () => {
		const body = renderPane(applyAgents(initialPiFleetState(), { ...listing, hubs: [] }));
		expect(body).toContain("No spokes are registered");
		expect(body).toContain("Select a spoke");
	});

	test("renders a reply as data with hub attribution, and a pending entry as waiting", () => {
		const selected = selectPeer(applyAgents(initialPiFleetState(), listing), { hubKey: "eu-shared-services-dev", name: "alpha-dev" });
		const pending = startEntry(selected, {
			id: "e1",
			hubKey: "eu-shared-services-dev",
			target: "alpha-dev",
			prompt: "ping",
			sentAt: 0,
		});
		expect(renderPane(pending, true)).toContain("Waiting for alpha-dev");
		const done = applySendResult(pending, "e1", {
			hubKey: "eu-shared-services-dev",
			environment: "dev",
			msgId: "m1",
			status: "complete",
			response: { summary: "ALB healthy", claims: [] },
			error: null,
			target: "alpha-dev",
			sender: "pi-fleet-abcd1234",
			sentAt: "x",
		});
		const body = renderPane(done);
		expect(body).toContain("<pre");
		expect(body).toContain('"summary": "ALB healthy"');
		expect(body).toContain("pi-fleet-abcd1234");
		// SIO-1666: attribution names the HUB, which is what tells two prd hubs apart.
		expect(body).toContain("on hub eu-shared-services-dev");
	});

	test("an expired wait reads as a timeout, not a hang", () => {
		const selected = selectPeer(applyAgents(initialPiFleetState(), listing), { hubKey: "eu-shared-services-dev", name: "alpha-dev" });
		const pending = startEntry(selected, {
			id: "e1",
			hubKey: "eu-shared-services-dev",
			target: "alpha-dev",
			prompt: "ping",
			sentAt: 0,
		});
		const body = renderPane(expireEntry(pending, "e1", 300_000));
		expect(body).toContain("no reply from alpha-dev within 300 s");
		expect(body).toContain("expired");
	});
});
