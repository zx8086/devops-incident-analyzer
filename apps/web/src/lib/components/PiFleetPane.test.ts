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

// SIO-1714: isDigest defaults false -- most fixture rows are follow-ups. The
// digest cases pass true explicitly, so a test that means "this is the report of
// record" says so rather than relying on its position in the array.
function inboxMessage(msgId: string, senderName: string, prompt: string, isDigest = false) {
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
		isDigest,
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
					isDigest: true,
				},
			],
		});
		const body = renderPane(state);
		expect(body).toContain("monitor-eu-oit-prd");
		// The tail of the report, which the old slice cut off.
		expect(body).toContain("saw 3 error-pattern events");
		expect(body).not.toContain(`${report.slice(0, 140)}...`);
	});

	// SIO-1712: the ops inbox card used to render INSIDE the spoke picker, whose
	// region is height-capped, so a whole daily digest came through a letterbox
	// while the replies region sat empty below it. The card belongs in the main
	// scroll region, beside the replies it relates to.
	test("renders the ops inbox digest in the replies region, not inside the capped picker", () => {
		const state = applyMailbox(applyAgents(initialPiFleetState(), listing), {
			hubKey: "eu-shared-services-dev",
			environment: "dev",
			name: "ops",
			missingDigest: [],
			windowTruncated: false,
			messages: [inboxMessage("m1", "monitor-eu-oit-prd", "[info] daily digest")],
		});
		const body = renderPane(state);
		const picker = body.indexOf("max-h-[20rem]");
		const replies = body.indexOf("flex-1 overflow-y-auto min-h-[8rem]");
		const card = body.indexOf("<details");
		expect(picker).toBeGreaterThan(-1);
		expect(replies).toBeGreaterThan(-1);
		// The card opens after the replies region does, so it is no longer nested
		// in the capped picker above it.
		expect(card).toBeGreaterThan(replies);
		expect(card).toBeGreaterThan(picker);
	});

	// SIO-1712: several loaded mailboxes plus a running reply have to coexist in
	// one scroll region, so the card collapses. Native <details>, so it is
	// keyboard-operable without any component state.
	test("the ops inbox card is collapsible and open by default", () => {
		const state = applyMailbox(applyAgents(initialPiFleetState(), listing), {
			hubKey: "eu-shared-services-dev",
			environment: "dev",
			name: "ops",
			missingDigest: [],
			windowTruncated: false,
			messages: [inboxMessage("m1", "monitor-eu-oit-prd", "[info] daily digest")],
		});
		const body = renderPane(state);
		expect(body).toMatch(/<details[^>]*\sopen/);
		expect(body).toContain("<summary");
		// The count is on the summary, so a collapsed card still says how much it holds.
		expect(body).toContain("1 report");
	});

	// SIO-1712: gray-500 on tommy-offwhite is 4.02:1 and gray-400 on white is
	// 2.54:1 -- both under the 4.5:1 floor. The digest body is the thing the
	// operator actually reads, so it carries full-contrast text on the same
	// surface a spoke reply uses; gray-600 clears both cream and white.
	test("renders the digest body at a legible contrast, with no gray-400 anywhere", () => {
		const state = applyMailbox(applyAgents(initialPiFleetState(), listing), {
			hubKey: "eu-shared-services-dev",
			environment: "dev",
			name: "ops",
			missingDigest: [],
			windowTruncated: false,
			// SIO-1714: the digest row is the one carrying the surfaced treatment.
			messages: [inboxMessage("m1", "monitor-eu-oit-prd", "[info] daily digest", true)],
		});
		const body = renderPane(state);
		expect(body).toContain("text-gray-700");
		expect(body).toContain("bg-tommy-offwhite");
		expect(body).not.toContain("text-gray-400");
	});

	// SIO-1712: Refresh was a bare text link that ignored the `busy` prop it was
	// already given, so it neither read as a control nor showed it was working.
	test("Refresh is a labelled button that disables and spins while busy", () => {
		const idle = renderPane(applyAgents(initialPiFleetState(), listing), false);
		expect(idle).toContain('aria-label="Refresh the fleet spoke list"');
		expect(idle).toContain("Refresh");

		const busy = renderPane(applyAgents(initialPiFleetState(), listing), true);
		const tag = busy.match(/<button[^>]*aria-label="Refresh the fleet spoke list"[^>]*>/)?.[0] ?? "";
		expect(/\sdisabled(=|\s|>)/.test(tag)).toBe(true);
		// Spinning is gated so it stops for prefers-reduced-motion.
		expect(busy).toContain("animate-spin motion-reduce:animate-none");
	});

	// SIO-1714: the digest is the report of record; everything after it happened
	// SINCE it. Rendered identically, the eye had nothing to land on.
	test("labels the daily digest and subordinates the messages after it", () => {
		const state = applyMailbox(applyAgents(initialPiFleetState(), listing), {
			hubKey: "eu-shared-services-dev",
			environment: "dev",
			name: "ops",
			missingDigest: [],
			windowTruncated: false,
			messages: [
				inboxMessage("m1", "monitor-eu-oit-prd", "[info] aws-1 daily digest (since x)", true),
				inboxMessage("m2", "monitor-eu-oit-prd", "a follow-up finding"),
			],
		});
		const body = renderPane(state);
		expect(body).toContain("Daily digest");
		// The follow-up is indented under a rule; the digest is not.
		expect(body).toContain("ml-3 border-l border-gray-200 pl-3");
		// The digest keeps the surfaced treatment.
		expect(body).toContain("bg-tommy-offwhite rounded p-2");
		// Both bodies stay legible: subordination is position, never dimming.
		expect(body).not.toContain("text-gray-400");
	});

	// An estate with no digest in the window marks nothing, so the pane must not
	// label anything as the report of record.
	test("labels nothing when no row is the digest", () => {
		const state = applyMailbox(applyAgents(initialPiFleetState(), listing), {
			hubKey: "eu-shared-services-dev",
			environment: "dev",
			name: "ops",
			missingDigest: ["eu-oit-prd"],
			windowTruncated: false,
			messages: [inboxMessage("m1", "monitor-eu-oit-prd", "[critical] alarm, no digest today")],
		});
		const body = renderPane(state);
		expect(body).not.toContain("Daily digest");
		// The findings are still shown in full -- hiding them is the worse error.
		expect(body).toContain("alarm, no digest today");
	});

	// SIO-1714: SIO-1703 pinned the picker as a capped SCROLL region, which is not
	// the same as pinning what is inside it. With a real fleet (six spokes on one
	// hub, as observed live) the rows overflow the cap, and scrolling to reach the
	// last one carried the hub header off the top -- losing both which hub is being
	// addressed and the Inbox button.
	test("keeps the hub header visible when the spoke rows overflow the picker", () => {
		const sixSpokes: PiFleetAgentsResponse = {
			...listing,
			hubs: [
				{
					hubKey: "eu-shared-services-prd",
					environment: "prd",
					project: "default",
					fallbackTarget: "ops",
					error: null,
					peers: [
						"eu-b2b-ecom-prd",
						"eu-b2becom-v2-prd",
						"eu-ediservices-prd",
						"eu-mendix-platform-prd",
						"eu-oit-prd",
						"eu-shared-services-prd",
					].map((name, i) => ({
						name,
						status: "online" as const,
						purpose: null,
						sessionId: `s${i}`,
					})),
				},
			],
		};
		const body = renderPane(applyAgents(initialPiFleetState(), sixSpokes), false, [
			"eu-b2b-ecom-prd",
			"eu-b2becom-v2-prd",
			"eu-ediservices-prd",
			"eu-mendix-platform-prd",
			"eu-oit-prd",
			"eu-shared-services-prd",
		]);
		// The header row pins to the top of the scrolling picker.
		expect(body).toContain("sticky top-0");
		// Opaque, or the rows scroll visibly underneath it.
		expect(body).toContain("bg-tommy-cream");
		// All six are still rendered -- the fix is what stays put, not what is shown.
		expect(body).toContain("eu-b2b-ecom-prd");
		expect(body).toContain("eu-shared-services-prd");
	});

	// SIO-1715: the picker cap is a fixed REM, never a percentage of the pane. The
	// pane is `h-screen` minus chrome, and that chrome is tallest exactly when this
	// pane is usable, so a percentage gave the target list MORE room than the
	// report on a short viewport. Measured with six spokes: 35% took 195px against
	// the digest's 163px at a 560px pane; a rem ceiling puts the digest ahead at every
	// height (182px at 560px, 502px at 880px vs 399px before).
	test("caps the picker in rem so the digest wins on a short pane", () => {
		const body = renderPane(applyAgents(initialPiFleetState(), listing));
		expect(body).toContain("max-h-[20rem]");
		// A percentage cap is the regression this guards against.
		expect(body).not.toMatch(/max-h-\[\d+%\]/);
	});

	// SIO-1717: SIO-1715's 11rem ceiling was tuned to beat the digest at every
	// pane height and ignored how many spokes there actually are. The real prd
	// fleet is SIX, which needs ~278px of rows, so 176px left two spokes
	// unreachable while the region below sat empty. The ceiling must clear a
	// six-spoke fleet; it exists for the outlier, not the normal case.
	test("the picker ceiling clears a real six-spoke fleet without clipping", () => {
		const body = renderPane(applyAgents(initialPiFleetState(), listing));
		const m = body.match(/max-h-\[(\d+(?:\.\d+)?)rem\]/);
		expect(m).not.toBeNull();
		const px = Number(m?.[1]) * 16;
		// header 30 + top pad 8 + 6 rows of 34 + 5 gaps of 4 + bottom pad 12.
		expect(px).toBeGreaterThanOrEqual(8 + 30 + 4 + 6 * 34 + 5 * 4 + 12);
	});

	// SIO-1717: navy is the card title and the hubKey, so a navy chip merged with
	// the header instead of marking the anchor row.
	test("the digest chip is solid accent blue, not a navy tint", () => {
		const state = applyMailbox(applyAgents(initialPiFleetState(), listing), {
			hubKey: "eu-shared-services-dev",
			environment: "dev",
			name: "ops",
			missingDigest: [],
			windowTruncated: false,
			messages: [inboxMessage("m1", "monitor-eu-oit-prd", "[info] daily digest", true)],
		});
		const body = renderPane(state);
		expect(body).toContain("bg-tommy-accent-blue");
		expect(body).toContain("Daily digest");
		expect(body).not.toContain("bg-tommy-navy/5");
	});

	// SIO-1718: the three regions must fit INSIDE the pane. The picker was
	// `shrink-0`, so on a short pane it kept its full height, squeezed the digest
	// region to 0px and pushed the composer past the wrapper's `overflow-hidden`
	// edge -- the spoke list looked truncated and the send box was gone entirely.
	// Measured live at a 465px pane: children summed to 495px.
	test("the picker yields, the digest keeps a floor, and the composer never shrinks", () => {
		const body = renderPane(applyAgents(initialPiFleetState(), listing));
		// The picker gives way rather than holding its height.
		expect(body).toContain("min-h-0 shrink max-h-[20rem]");
		expect(body).not.toContain("shrink-0 max-h-[20rem]");
		// The digest cannot be collapsed to nothing by a long spoke list.
		expect(body).toContain("min-h-[8rem]");
		// The send box is the pane's primary control; it is never the thing squeezed out.
		expect(body).toContain("shrink-0 border-t border-gray-200");
	});

	// SIO-1706: the pane no longer offers to "open the fleet console". The header pi
	// icon toggles THIS pane and the box below addresses the spokes, so the button
	// advertised a destination that does not exist. SIO-1702 rewrote its label
	// instead of asking whether the door was real; these assertions replace that
	// test so the copy cannot come back.
	// SIO-1707: the hub account runs a spoke too, so its name is both the hub and
	// one of its own peers. Confirmed live: hubKey eu-shared-services-prd, peers
	// including eu-shared-services-prd. Both readings are correct, so the row is
	// labelled by role rather than renamed.
	test("labels the hub row as the hub, and still lists a spoke of the same name", () => {
		const collision: PiFleetAgentsResponse = {
			...listing,
			hubs: [
				{
					hubKey: "eu-shared-services-prd",
					environment: "prd",
					project: "default",
					fallbackTarget: "ops",
					peers: [
						{ name: "eu-oit-prd", status: "online", purpose: null, sessionId: "s1" },
						{ name: "eu-shared-services-prd", status: "online", purpose: null, sessionId: "s2" },
					],
					error: null,
				},
			],
		};
		const body = renderPane(applyAgents(initialPiFleetState(), collision), false, [
			"eu-oit-prd",
			"eu-shared-services-prd",
		]);
		const text = body.replace(/<!--[\s\S]*?-->/g, "");
		// The header says what it IS, so the repeated name is not read as two spokes.
		expect(text).toContain(">hub<");
		// The hub's own spoke is a real target and must stay addressable.
		expect(text).toContain("eu-shared-services-prd");
		expect((text.match(/eu-shared-services-prd/g) ?? []).length).toBeGreaterThan(1);
	});

	test("never offers to open a fleet console", () => {
		const body = renderPane(applyAgents(initialPiFleetState(), listing), false);
		expect(body).not.toContain("Open the fleet console");
		expect(body).not.toContain("Switches agent");
		expect(body).not.toContain("Ask all spokes at once");
	});

	// SIO-1708: no selection is not an error state -- it means ask everyone in
	// scope, from the same box and the same Send button. No extra control.
	test("with no spoke selected the box is live and addresses every spoke in scope", () => {
		const body = renderPane(applyAgents(initialPiFleetState(), listing), false);
		const tag = body.match(/<textarea[^>]*/)?.[0] ?? "";
		expect(/\sdisabled(=|\s|>)/.test(tag.replace(/class="[^"]*"/, ""))).toBe(false);
		expect(body).toContain("Ask every spoke in scope");
		// The count names the scope, so a scoped fan-out is not mistaken for the fleet.
		expect(body).toContain("To all 1 spoke in scope");
	});

	test("the fan-out counts only spokes the scope is showing", () => {
		const twoHubs: PiFleetAgentsResponse = {
			...listing,
			hubs: [
				{
					hubKey: "eu-shared-services-prd",
					environment: "prd",
					project: "default",
					fallbackTarget: "ops",
					peers: [
						{ name: "eu-oit-prd", status: "online", purpose: null, sessionId: "a" },
						{ name: "eu-ediservices-prd", status: "online", purpose: null, sessionId: "b" },
					],
					error: null,
				},
			],
		};
		const all = renderPane(applyAgents(initialPiFleetState(), twoHubs), false, ["eu-oit-prd", "eu-ediservices-prd"]);
		expect(all).toContain("To all 2 spokes in scope");
		// Scoping to one account makes that account the whole fan-out.
		const scoped = renderPane(applyAgents(initialPiFleetState(), twoHubs), false, ["eu-oit-prd"]);
		expect(scoped).toContain("To all 1 spoke in scope");
	});

	test("the box stays disabled when the scope leaves no spoke to ask", () => {
		const body = renderPane(applyAgents(initialPiFleetState(), listing), false, []);
		const tag = body.match(/<textarea[^>]*/)?.[0] ?? "";
		expect(/\sdisabled(=|\s|>)/.test(tag.replace(/class="[^"]*"/, ""))).toBe(true);
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
	// SIO-1717: the ceiling is 20rem (SIO-1715 set 11rem, which clipped a real
	// six-spoke fleet at 278px). The ops inbox card used to render
	// inside this region, so a whole daily digest came through a letterbox. The
	// card moved to the replies region below; what is left here is rows.
	test("pins the spoke picker in its own scroll region, separate from the replies", () => {
		const body = renderPane(applyAgents(initialPiFleetState(), listing));
		// SIO-1715: a REM cap, not a percentage. A percentage split a short pane
		// badly -- at 560px the picker took 195px against the digest's 163px, so
		// the target list outweighed the report. Measured: a rem ceiling puts the digest
		// ahead at every pane height.
		expect(body).toContain("max-h-[20rem]");
		expect(body).not.toContain("max-h-[35%]");
		// The replies keep their own flex-1 region below it.
		expect(body).toContain("flex-1 overflow-y-auto min-h-[8rem]");
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

	// SIO-1709: the monitor writes markdown, so a literal render showed the asterisks.
	test("renders a string reply as markdown, not as literal asterisks", () => {
		const selected = selectPeer(applyAgents(initialPiFleetState(), listing), {
			hubKey: "eu-shared-services-dev",
			name: "alpha-dev",
		});
		const pending = startEntry(selected, {
			id: "e1",
			hubKey: "eu-shared-services-dev",
			target: "alpha-dev",
			prompt: "digest",
			sentAt: 0,
		});
		const done = applySendResult(pending, "e1", {
			hubKey: "eu-shared-services-dev",
			environment: "dev",
			msgId: "m1",
			status: "complete",
			response: "**HCL Commerce ts-app (warn)** -- 18 SRVE0255E errors",
			error: null,
			target: "alpha-dev",
			sender: "pi-fleet-abcd1234",
			sentAt: "x",
		});
		const body = renderPane(done);
		expect(body).toContain("<strong>HCL Commerce ts-app (warn)</strong>");
		expect(body).not.toContain("**HCL Commerce");
	});

	// The reply is untrusted: agent-authored text about production accounts, rendered
	// through {@html}. This pane SERVER-renders, so the sanitizer must hold outside a
	// browser -- the browser-only guard SIO-1042 shipped would pass this straight through.
	test("strips hostile html from a reply, in SSR", () => {
		const selected = selectPeer(applyAgents(initialPiFleetState(), listing), {
			hubKey: "eu-shared-services-dev",
			name: "alpha-dev",
		});
		const pending = startEntry(selected, {
			id: "e1",
			hubKey: "eu-shared-services-dev",
			target: "alpha-dev",
			prompt: "digest",
			sentAt: 0,
		});
		const done = applySendResult(pending, "e1", {
			hubKey: "eu-shared-services-dev",
			environment: "dev",
			msgId: "m1",
			status: "complete",
			response: "before <img src=x onerror=alert(1)> <script>alert(2)</script> after",
			error: null,
			target: "alpha-dev",
			sender: "pi-fleet-abcd1234",
			sentAt: "x",
		});
		const body = renderPane(done);
		expect(body).not.toContain("onerror");
		expect(body).not.toContain("alert(2)");
		// The surrounding prose still reaches the reader.
		expect(body).toContain("before");
		expect(body).toContain("after");
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
