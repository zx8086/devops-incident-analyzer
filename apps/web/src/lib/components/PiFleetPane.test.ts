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

// SIO-1704: no estate selected means no account is in scope, so the default here
// selects the fixture's spokes -- these tests are about everything EXCEPT scoping,
// and an unscoped render would now correctly show nothing. The empty-scope case
// has its own test below.
const ALL_FIXTURE_ESTATES = ["alpha-dev", "eu-oit-prd", "eu-shared-services-prd", "eu-retail-shop-prd"];

function inboxMessage(msgId: string, senderName: string, prompt: string) {
	return {
		msgId,
		senderName,
		targetName: "ops",
		prompt,
		status: "queued",
		error: null,
		response: null,
		createdAt: "2026-09-11T00:00:00.000Z",
		completedAt: null,
	};
}

function renderPane(state: PiFleetState, busy = false, scopeEstates: string[] = ALL_FIXTURE_ESTATES): string {
	return render(PiFleetPane, {
		props: { pane: state, busy, mailboxBusy: null, ...handlers, scopeEstates },
	}).body;
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
			missingDigest: [],
			windowTruncated: false,
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

	// SIO-1706: the pane no longer offers to "open the fleet console". The header pi
	// icon toggles THIS pane and the box below addresses the spokes, so the button
	// advertised a destination that does not exist. SIO-1702 rewrote its label
	// instead of asking whether the door was real; these assertions replace that
	// test so the copy cannot come back.
	test("never offers to open a fleet console", () => {
		const body = renderPane(applyAgents(initialPiFleetState(), listing), false);
		expect(body).not.toContain("Open the fleet console");
		expect(body).not.toContain("Switches agent");
		expect(body).not.toContain("Ask all spokes at once");
	});

	test("points the input box at the only path there is", () => {
		const body = renderPane(applyAgents(initialPiFleetState(), listing), false);
		expect(body).toContain("Select a spoke above to send it a prompt");
		expect(body).not.toContain("ask them all at once");
	});

	// The reachability copy outlived the button it used to gate: an operator facing
	// a down hub still needs to be told why nothing can be sent.
	test("says why nothing can be sent when no spoke is reachable", () => {
		const unreachable: PiFleetAgentsResponse = {
			...listing,
			hubs: [
				{
					hubKey: "eu-shared-services-prd",
					environment: "prd",
					project: "default",
					fallbackTarget: "ops",
					peers: [],
					error: 'cannot reach hub "eu-shared-services-prd" -- the SSM tunnel is probably down',
				},
			],
		};
		const body = renderPane(applyAgents(initialPiFleetState(), unreachable), false);
		expect(body).toContain("No spoke is reachable. Fix the hub above");
	});

	// SIO-1703: scoping an investigation to one estate scopes the spokes too.
	test("scopes the spoke list to the selected AWS estates", () => {
		const scoped = render(PiFleetPane, {
			props: {
				pane: applyAgents(initialPiFleetState(), listing),
				busy: false,
				mailboxBusy: null,
				...handlers,
				scopeEstates: ["alpha-dev"],
			},
		}).body;
		expect(scoped).toContain("alpha-dev");
		// alpha-dev is the only spoke in the fixture, so nothing is hidden and the
		// note correctly stays away -- the count is asserted in the next test.
		expect(scoped).not.toContain("Scoped to the selected AWS estates");
	});

	test("reports how many spokes the scope hid", () => {
		const twoSpokes: PiFleetAgentsResponse = {
			...listing,
			hubs: [
				{
					hubKey: "eu-shared-services-prd",
					environment: "prd",
					project: "default",
					fallbackTarget: "ops",
					error: null,
					peers: [
						{ name: "eu-oit-prd", status: "online", purpose: null, sessionId: "p1" },
						{ name: "eu-shared-services-prd", status: "online", purpose: null, sessionId: "p2" },
					],
				},
			],
		};
		const body = render(PiFleetPane, {
			props: {
				pane: applyAgents(initialPiFleetState(), twoSpokes),
				busy: false,
				mailboxBusy: null,
				...handlers,
				scopeEstates: ["eu-oit-prd"],
			},
		}).body;
		expect(body).toContain("eu-oit-prd");
		expect(body).toContain("1 other spoke hidden");
	});

	// SIO-1704 replaces the SIO-1703 rule. Treating an empty selection as "no
	// narrowing" let an operator who had deselected every estate still address any
	// account -- the mistake the scoping exists to prevent.
	test("an empty selection puts no account in scope, so no spoke is addressable", () => {
		const body = renderPane(applyAgents(initialPiFleetState(), listing), false, []);
		expect(body).not.toContain("alpha-dev");
		expect(body).toContain("No AWS estate selected");
	});

	test("an emptied hub says the scope excluded it, not that the fleet is unregistered", () => {
		// The spokes ARE registered; claiming otherwise sends the operator chasing
		// a fleet problem that does not exist.
		const body = renderPane(applyAgents(initialPiFleetState(), listing), false, []);
		expect(body).toContain("No spoke here is in the selected scope");
		expect(body).not.toContain("No spokes are registered on this hub");
	});

	test("a selection matching no spoke on a hub empties that hub's list", () => {
		const body = renderPane(applyAgents(initialPiFleetState(), listing), false, ["eu-oit-prd"]);
		expect(body).not.toContain("alpha-dev");
	});

	// SIO-1703: the picker and the replies were in ONE scroll container, so a long
	// reply scrolled the picker out of view.
	test("pins the spoke picker in its own scroll region, separate from the replies", () => {
		const body = renderPane(applyAgents(initialPiFleetState(), listing));
		expect(body).toContain("max-h-[40%]");
		// The replies keep their own flex-1 region below it.
		expect(body).toContain("flex-1 overflow-y-auto min-h-0");
	});

	// SIO-1703: `project` is a hub-side namespace derived per ENVIRONMENT, so two
	// prd hubs in different accounts both render "pi-coms-prd". Showing it beside
	// the hubKey gives the operator a value that looks identifying and is not --
	// the collision SIO-1666 removed from routing. hubKey is the identity.
	test("identifies a hub by its key, never by the shared project namespace", () => {
		const twoPrdHubs: PiFleetAgentsResponse = {
			...listing,
			hubs: [
				{
					hubKey: "eu-shared-services-prd",
					environment: "prd",
					project: "pi-coms-prd",
					fallbackTarget: "ops",
					error: null,
					peers: [{ name: "eu-oit-prd", status: "online", purpose: null, sessionId: "p1" }],
				},
				{
					// A second prd hub in a different account: same project string.
					hubKey: "eu-retail-prd",
					environment: "prd",
					project: "pi-coms-prd",
					fallbackTarget: "ops",
					error: null,
					peers: [{ name: "eu-retail-shop-prd", status: "online", purpose: null, sessionId: "p2" }],
				},
			],
		};
		const body = renderPane(applyAgents(initialPiFleetState(), twoPrdHubs));
		// Strip HTML comments: SSR emits them, and this file's own rationale
		// comments name the very string under test.
		const visible = body.replace(/<!--[\s\S]*?-->/g, "");
		expect(visible).toContain("eu-shared-services-prd");
		expect(visible).toContain("eu-retail-prd");
		// The ambiguous namespace is not what the operator reads.
		expect(visible).not.toContain("pi-coms-prd");
	});

	// SIO-1705: the scope filter moved to the server, which needs it to decide
	// WHICH rows to fetch (see anchorOnDigest in pi-fleet.test.ts). The pane now
	// renders exactly the anchored range it was handed -- asserting a second,
	// client-side filter here would re-pin the bug SIO-1705 removed.
	test("renders every inbox row the server returned, unfiltered", () => {
		const state = applyMailbox(applyAgents(initialPiFleetState(), listing), {
			hubKey: "eu-shared-services-dev",
			environment: "dev",
			name: "ops",
			missingDigest: [],
			windowTruncated: false,
			messages: [
				inboxMessage("m1", "monitor-eu-oit-prd", "[info] aws-762715229080 daily digest"),
				inboxMessage("m2", "monitor-eu-oit-prd", "[critical] aws-762715229080 CloudTrail NOT logging"),
			],
		});
		const body = renderPane(state, false, ["eu-oit-prd"]);
		expect(body).toContain("aws-762715229080 daily digest");
		expect(body).toContain("CloudTrail NOT logging");
	});

	test("names the estates whose digest fell outside the fetched window", () => {
		const state = applyMailbox(applyAgents(initialPiFleetState(), listing), {
			hubKey: "eu-shared-services-dev",
			environment: "dev",
			name: "ops",
			missingDigest: ["eu-oit-prd"],
			windowTruncated: true,
			messages: [inboxMessage("m1", "monitor-eu-oit-prd", "[warn] aws-762715229080 alarm")],
		});
		const body = renderPane(state, false, ["eu-oit-prd"]);
		// A partial range must say so: the rows shown start mid-day, not at the digest.
		expect(body).toContain("No daily digest found for eu-oit-prd");
		expect(body).toContain("older digest may sit beyond it");
	});

	test("keeps an inbox entry whose sender is not estate-shaped", () => {
		// A spoke replying, or an operator: no estate to match. An estate filter
		// must not silently drop what it cannot classify.
		const state = applyMailbox(applyAgents(initialPiFleetState(), listing), {
			hubKey: "eu-shared-services-dev",
			environment: "dev",
			name: "ops",
			missingDigest: [],
			windowTruncated: false,
			messages: [inboxMessage("m3", "simon", "handover note for the next shift")],
		});
		const body = renderPane(state, false, ["eu-oit-prd"]);
		expect(body).toContain("handover note for the next shift");
	});

	test("says so when the anchored read returned nothing for the scope", () => {
		const state = applyMailbox(applyAgents(initialPiFleetState(), listing), {
			hubKey: "eu-shared-services-dev",
			environment: "dev",
			name: "ops",
			missingDigest: [],
			windowTruncated: false,
			messages: [],
		});
		const body = renderPane(state, false, ["eu-oit-prd"]);
		expect(body).toContain("No reports from the selected estates");
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
