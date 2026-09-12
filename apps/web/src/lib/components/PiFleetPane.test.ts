// apps/web/src/lib/components/PiFleetPane.test.ts
// SIO-1650: SSR shape checks for the pi-fleet pane. The send, select and refresh
// handlers are runes-driven and are covered by the manual e2e against a hub.
import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";
import type { PiFleetAgentsResponse } from "../pi-fleet-types.ts";
import {
	applyAgents,
	applyMailbox,
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
	test("lists peers under their environment with status, and shows a hub error inline", () => {
		const body = renderPane(applyAgents(initialPiFleetState(), listing));
		expect(body).toContain("alpha-dev");
		expect(body).toContain("online");
		expect(body).toContain("dev");
		expect(body).toContain("hub GET failed: 500");
	});

	// The row is a target picker. `purpose` is agent-authored prose of unbounded
	// length; rendering it squeezed the name column until account-shaped names
	// wrapped across three lines. The fixture still carries one, so this fails if
	// it is ever rendered again.
	test("does not render the agent-authored purpose", () => {
		const body = renderPane(applyAgents(initialPiFleetState(), listing));
		expect(body).not.toContain("aws spoke");
	});

	// The monitor's report IS the content: there is no detail view to click into,
	// so a 140-char slice lost the findings the digest exists to deliver.
	test("renders a monitor report in full, not a 140-char preview", () => {
		const report =
			"[info] aws-762715229080 daily digest (since 2026-09-11T00:00:19.265Z) - findings: 61 " +
			"(alarm=49 logs=10 trail=2) - notable warn+ findings (last 24h): " +
			"alarm-eu-oit-prd-DatabaseServerCPUUtilization-eu-oit-prd-psql-db-0 entered ALARM, " +
			"/ecs/fargate/catalog-prd-log-group saw 3 error-pattern events";
		expect(report.length).toBeGreaterThan(140);
		const state = applyMailbox(applyAgents(initialPiFleetState(), listing), {
			hubKey: "eu-shared-services-dev",
			environment: "dev",
			name: "ops",
			messages: [
				{
					msgId: "m1",
					senderName: "monitor-eu-oit-prd",
					targetName: "ops",
					prompt: report,
					status: "queued",
					error: null,
					response: null,
					createdAt: "2026-09-11T00:00:19.265Z",
					completedAt: null,
				},
			],
		});
		const body = renderPane(state);
		expect(body).toContain("monitor-eu-oit-prd");
		// The tail of the report, which the old slice cut off.
		expect(body).toContain("saw 3 error-pattern events");
		expect(body).not.toContain(`${report.slice(0, 140)}...`);
	});

	test("shows the empty-state copy before any peer is selected", () => {
		const body = renderPane(applyAgents(initialPiFleetState(), { ...listing, hubs: [] }));
		expect(body).toContain("No spokes are registered");
		expect(body).toContain("Select a spoke");
	});

	test("renders a reply as data with hub attribution, and a pending entry as waiting", () => {
		const selected = selectPeer(applyAgents(initialPiFleetState(), listing), {
			hubKey: "eu-shared-services-dev",
			name: "alpha-dev",
		});
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

	// SIO-1678: eu-oit-prd answered `complete` + "" for two hours; the pane showed nothing.
	test("an empty completed reply is named as such, not rendered as nothing", () => {
		const selected = selectPeer(applyAgents(initialPiFleetState(), listing), {
			hubKey: "eu-shared-services-dev",
			name: "alpha-dev",
		});
		const pending = startEntry(selected, {
			id: "e1",
			hubKey: "eu-shared-services-dev",
			target: "alpha-dev",
			prompt: "Reply with exactly: ok",
			sentAt: 0,
		});
		const done = applySendResult(pending, "e1", {
			hubKey: "eu-shared-services-dev",
			environment: "dev",
			msgId: "m1",
			status: "complete",
			response: "",
			error: null,
			target: "alpha-dev",
			sender: "pi-fleet-abcd1234",
			sentAt: "x",
		});
		const body = renderPane(done);
		expect(body).toContain("empty reply from alpha-dev");
		expect(body).toContain("not answered");
		expect(body).not.toContain("<pre");
		// A timeout with no body is not an "empty reply": the turn never completed.
		const timedOut = applySendResult(pending, "e1", {
			hubKey: "eu-shared-services-dev",
			environment: "dev",
			msgId: "m1",
			status: "timeout",
			response: null,
			error: null,
			target: "alpha-dev",
			sender: "pi-fleet-abcd1234",
			sentAt: "x",
		});
		expect(renderPane(timedOut)).not.toContain("empty reply from");
	});

	test("an expired wait reads as a timeout, not a hang", () => {
		const selected = selectPeer(applyAgents(initialPiFleetState(), listing), {
			hubKey: "eu-shared-services-dev",
			name: "alpha-dev",
		});
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
