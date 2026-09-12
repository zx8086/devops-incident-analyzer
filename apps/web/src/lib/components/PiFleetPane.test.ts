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

// SIO-1702: the console button is `{#if onAskAll}`, so it renders only where the
// deployment offers it. Opt-in here, keeping the not-offered case testable.
function renderPane(state: PiFleetState, busy = false, onAskAll?: () => void): string {
	return render(PiFleetPane, {
		props: { pane: state, busy, mailboxBusy: null, ...handlers, ...(onAskAll ? { onAskAll } : {}) },
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

	// SIO-1702: the button LEAVES this pane (it switches agent); it never fed the
	// input box below it, which an arrow alone did not convey. And the console can
	// only ask spokes it can reach, so a down hub must gate it -- `consoleAvailable`
	// upstream is a deployment fact, not a liveness one.
	test("names the destination and explains that the question is asked in the chat", () => {
		const body = renderPane(applyAgents(initialPiFleetState(), listing), false, noop);
		expect(body).toContain("Open the fleet console");
		expect(body).toContain("Switches agent: ask one question in the chat");
		// The old label read as if it acted on this pane.
		expect(body).not.toContain("Ask all spokes at once");
	});

	test("points the disabled input at both paths when spokes are reachable", () => {
		const body = renderPane(applyAgents(initialPiFleetState(), listing), false, noop);
		expect(body).toContain("Select a spoke above");
		expect(body).toContain("or open the fleet console to ask them all at once");
	});

	test("disables the console button and says why when no spoke is reachable", () => {
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
		const body = renderPane(applyAgents(initialPiFleetState(), unreachable), false, noop);
		const tag = body.match(/<button[^>]*>\s*Open the fleet console/)?.[0] ?? "";
		// The ATTRIBUTE, not the Tailwind `disabled:` variants in the class list.
		expect(/\sdisabled(=|\s|>)/.test(tag.replace(/class="[^"]*"/, ""))).toBe(true);
		expect(body).toContain("Unavailable while no spoke is reachable");
		expect(body).toContain("No spoke is reachable. Fix the hub above");
	});

	test("leaves the console button enabled while a spoke is reachable", () => {
		const body = renderPane(applyAgents(initialPiFleetState(), listing), false, noop);
		const tag = body.match(/<button[^>]*>\s*Open the fleet console/)?.[0] ?? "";
		expect(/\sdisabled(=|\s|>)/.test(tag.replace(/class="[^"]*"/, ""))).toBe(false);
	});

	test("omits the console button entirely where the deployment does not offer it", () => {
		const body = renderPane(applyAgents(initialPiFleetState(), listing));
		expect(body).not.toContain("Open the fleet console");
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

	test("an empty selection scopes nothing rather than hiding every spoke", () => {
		// No selection is not a request for a narrower fleet; hiding everything
		// would read as an outage.
		const body = renderPane(applyAgents(initialPiFleetState(), listing));
		expect(body).toContain("alpha-dev");
		expect(body).not.toContain("Scoped to the selected AWS estates");
	});

	test("a selection matching no spoke empties the list and gates the console", () => {
		const body = render(PiFleetPane, {
			props: {
				pane: applyAgents(initialPiFleetState(), listing),
				busy: false,
				mailboxBusy: null,
				...handlers,
				onAskAll: noop,
				scopeEstates: ["eu-oit-prd"],
			},
		}).body;
		expect(body).not.toContain("alpha-dev");
		const tag = body.match(/<button[^>]*>\s*Open the fleet console/)?.[0] ?? "";
		expect(/\sdisabled(=|\s|>)/.test(tag.replace(/class="[^"]*"/, ""))).toBe(true);
	});

	// SIO-1703: the picker and the replies were in ONE scroll container, so a long
	// reply scrolled the picker out of view.
	test("pins the spoke picker in its own scroll region, separate from the replies", () => {
		const body = renderPane(applyAgents(initialPiFleetState(), listing));
		expect(body).toContain("max-h-[40%]");
		// The replies keep their own flex-1 region below it.
		expect(body).toContain("flex-1 overflow-y-auto min-h-0");
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
