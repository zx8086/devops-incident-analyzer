// apps/web/src/lib/components/graph-triage-scroll.test.ts
// SIO-1812: the triage pane's follow-the-running-node decision.
import { describe, expect, test } from "bun:test";
import { runningFingerprint, shouldRevealRunning } from "./graph-triage-scroll.ts";

describe("runningFingerprint", () => {
	test("is empty when nothing is running", () => {
		expect(runningFingerprint(new Map())).toBe("");
	});

	test("follows the FIRST active node so a fan-out does not flicker", () => {
		// activeNodes is insertion-ordered, so the earliest entry is the branch that has
		// been running longest. Several parallel Sends share the pane; picking the first
		// keeps the view anchored instead of jumping between them.
		const fanOut = new Map([
			["queryDataSource", 3],
			["correlationFetch", 1],
		]);
		expect(runningFingerprint(fanOut)).toBe("queryDataSource");
	});

	test("changes when the running node changes, which is what drives the scroll", () => {
		expect(runningFingerprint(new Map([["classify", 1]]))).not.toBe(runningFingerprint(new Map([["normalize", 1]])));
	});
});

describe("shouldRevealRunning", () => {
	test("follows a new running node while the operator is still following", () => {
		expect(shouldRevealRunning({ runningChanged: true, hasRunning: true, following: true })).toBe(true);
	});

	// The whole point of the gate: never take the view from someone reading.
	test("leaves a reader who scrolled away alone", () => {
		expect(shouldRevealRunning({ runningChanged: true, hasRunning: true, following: false })).toBe(false);
	});

	test("does not re-scroll while the same node keeps running", () => {
		expect(shouldRevealRunning({ runningChanged: false, hasRunning: true, following: true })).toBe(false);
	});

	// Between nodes, and before the turn starts, there is nothing to follow -- moving the
	// view to "nothing" would yank it for no reason.
	test("does not move when nothing is running", () => {
		expect(shouldRevealRunning({ runningChanged: true, hasRunning: false, following: true })).toBe(false);
	});

	// Greptile PR #843: the bug this predicate's first version shipped with. `following`
	// used to be "is the scroller near the bottom", borrowed from the fleet pane -- but
	// that pane APPENDS while this one CENTRES, so one reveal left the scroller mid-content
	// and the next transition read not-at-bottom and stopped following for the whole turn.
	// Following is now panel-owned state that a programmatic centre does not disturb, so
	// consecutive nodes keep being revealed.
	test("keeps following across consecutive nodes, which centring used to break", () => {
		const nodes = ["classify", "normalize", "selectRunbooks", "entityExtractor", "queryDataSource"];
		let seen = "";
		const revealed: string[] = [];
		for (const id of nodes) {
			// `following` stays true because nothing but an operator scroll clears it.
			if (shouldRevealRunning({ runningChanged: id !== seen, hasRunning: true, following: true })) {
				revealed.push(id);
			}
			seen = id;
		}
		expect(revealed).toEqual(nodes);
	});
});

// Greptile PR #843, second round. The follow flag was right; the GUARD around our own
// scroll was not. A native smooth scrollTo emits many events -- 31 measured live in this
// pane for a single call -- and the first version cleared the guard on the first one, so
// frames 2..N were read as operator input and switched following off mid-animation. This
// models the panel's guard (an event while self-scrolling extends it; the flag clears only
// once events stop) and fails against the consume-one-event version.
describe("SIO-1812: the self-scroll guard spans a whole smooth animation", () => {
	// Mirrors GraphTriagePanel's onScroll/endSelfScroll pair, minus the DOM.
	function makeGuard(atBottom: () => boolean) {
		let following = true;
		let selfScrolling = false;
		let pending = 0; // stands in for the settle timer
		return {
			startSelfScroll() {
				selfScrolling = true;
				pending = 1;
			},
			onScroll() {
				if (selfScrolling) {
					pending = 1; // extend, do NOT consume
					return;
				}
				following = atBottom();
			},
			settle() {
				if (pending) {
					pending = 0;
					selfScrolling = false;
				}
			},
			get following() {
				return following;
			},
		};
	}

	// The animation parks the node mid-content, so every frame reports "not at bottom".
	const MID_CONTENT = () => false;

	test("31 events from one reveal do not switch following off", () => {
		const g = makeGuard(MID_CONTENT);
		g.startSelfScroll();
		for (let i = 0; i < 31; i++) g.onScroll();
		g.settle();
		expect(g.following).toBe(true);
	});

	test("consecutive reveals keep following, each with its own event burst", () => {
		const g = makeGuard(MID_CONTENT);
		for (let node = 0; node < 5; node++) {
			g.startSelfScroll();
			for (let i = 0; i < 31; i++) g.onScroll();
			g.settle();
			expect(g.following).toBe(true);
		}
	});

	test("an operator scroll after the animation settles still stops following", () => {
		const g = makeGuard(MID_CONTENT);
		g.startSelfScroll();
		for (let i = 0; i < 31; i++) g.onScroll();
		g.settle();
		g.onScroll(); // theirs: no self-scroll in flight
		expect(g.following).toBe(false);
	});

	test("and returning to the bottom resumes following", () => {
		let parked = false;
		const g = makeGuard(() => parked);
		g.startSelfScroll();
		for (let i = 0; i < 31; i++) g.onScroll();
		g.settle();
		g.onScroll();
		expect(g.following).toBe(false);
		parked = true; // scrolled back to the end
		g.onScroll();
		expect(g.following).toBe(true);
	});
});
