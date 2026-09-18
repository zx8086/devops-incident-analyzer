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

// Greptile PR #843, rounds 2 and 3 -- the two halves of the same question, which is why
// they are tested together: a fix for either one alone reintroduces the other.
//
// Scroll events cannot answer "who moved the view". One smooth scrollTo emits ~31 of them
// (measured live in this pane) and they are identical to the operator's. Round 2 consumed
// one event, so the animation's remaining frames looked like the operator and following
// died mid-turn. Round 3 swallowed them all, so a wheel spin DURING the animation looked
// like the animation and the operator was dragged back to the node they had just left.
//
// The panel therefore decides from INPUT events -- wheel/touchmove, which fire
// independently of any animation -- and uses scroll only to re-arm when the operator
// parks at the bottom. This models that pair.
describe("SIO-1812: following is driven by operator input, not by scroll events", () => {
	// Mirrors GraphTriagePanel's onOperatorInput/onScroll pair, minus the DOM.
	function makePanel(atBottom: () => boolean) {
		let following = true;
		return {
			operatorInput() {
				following = false;
			},
			scrolled() {
				if (!following && atBottom()) following = true;
			},
			get following() {
				return following;
			},
		};
	}

	// A reveal parks the node mid-content, so every frame reports "not at bottom".
	const MID_CONTENT = () => false;
	const SMOOTH_FRAMES = 31;

	// Round 2's bug.
	test("an animation's own frames never switch following off", () => {
		const p = makePanel(MID_CONTENT);
		for (let i = 0; i < SMOOTH_FRAMES; i++) p.scrolled();
		expect(p.following).toBe(true);
	});

	test("consecutive reveals keep following, each with its own frame burst", () => {
		const p = makePanel(MID_CONTENT);
		for (let node = 0; node < 5; node++) {
			for (let i = 0; i < SMOOTH_FRAMES; i++) p.scrolled();
			expect(p.following).toBe(true);
		}
	});

	// Round 3's bug: the operator interrupting mid-animation must win immediately, even
	// though frames are still arriving around their input.
	test("a wheel spin DURING an animation stops following at once", () => {
		const p = makePanel(MID_CONTENT);
		for (let i = 0; i < 10; i++) p.scrolled();
		p.operatorInput();
		for (let i = 0; i < 21; i++) p.scrolled();
		expect(p.following).toBe(false);
	});

	test("and the next reveal does not reclaim the view", () => {
		const p = makePanel(MID_CONTENT);
		p.operatorInput();
		for (let i = 0; i < SMOOTH_FRAMES; i++) p.scrolled();
		expect(p.following).toBe(false);
	});

	test("parking at the bottom resumes following", () => {
		let parked = false;
		const p = makePanel(() => parked);
		p.operatorInput();
		expect(p.following).toBe(false);
		parked = true;
		p.scrolled();
		expect(p.following).toBe(true);
	});
});
