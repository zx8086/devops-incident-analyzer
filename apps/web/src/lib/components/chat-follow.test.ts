// apps/web/src/lib/components/chat-follow.test.ts
import { describe, expect, test } from "bun:test";
import { followAfterScroll } from "./chat-follow.ts";

// Mirrors +page.svelte's pair: a ResizeObserver that scrolls to the end while following,
// and an onscroll handler that feeds followAfterScroll. Growth fires NO scroll event.
function makeChat(clientHeight: number) {
	const el = { scrollTop: 0, clientHeight, scrollHeight: clientHeight };
	let following = true;
	let lastTop = 0;
	const scrolled = () => {
		following = followAfterScroll(following, lastTop, el);
		lastTop = el.scrollTop;
	};
	return {
		el,
		grow(px: number) {
			el.scrollHeight += px;
			if (following) {
				el.scrollTop = el.scrollHeight - el.clientHeight;
				scrolled();
			}
		},
		// Content lands between our scroll-to-end and the scroll event it produces.
		growRacingTheScrollEvent(px: number, late: number) {
			el.scrollHeight += px;
			el.scrollTop = el.scrollHeight - el.clientHeight;
			el.scrollHeight += late;
			scrolled();
		},
		shrink(px: number) {
			el.scrollHeight -= px;
			const max = Math.max(0, el.scrollHeight - el.clientHeight);
			if (el.scrollTop > max) {
				el.scrollTop = max;
				scrolled();
			}
		},
		readerScrollsBy(px: number) {
			const max = el.scrollHeight - el.clientHeight;
			el.scrollTop = Math.min(max, Math.max(0, el.scrollTop + px));
			scrolled();
		},
		gap: () => el.scrollHeight - el.clientHeight - el.scrollTop,
		get following() {
			return following;
		},
	};
}

describe("chat follow", () => {
	// The shipped bug, with its measured numbers: the streaming bubble arrived as one
	// 232px growth, the old "within 100px" test read that as scrolled-away, and the gap
	// then ran to 4443px. Growth now never reaches the rule at all (it fires no scroll
	// event); the two tests below are the ones a restored distance test fails.
	test("a single large growth does not end following", () => {
		const chat = makeChat(684);
		chat.grow(232);
		for (let i = 0; i < 40; i++) chat.grow(110);
		chat.grow(900);
		expect(chat.following).toBe(true);
		expect(chat.gap()).toBe(0);
	});

	test("content landing before our own scroll event is not the reader leaving", () => {
		const chat = makeChat(684);
		chat.grow(500);
		chat.growRacingTheScrollEvent(40, 300);
		expect(chat.following).toBe(true);
	});

	// The other direction: a reader must win even on a small trackpad move, which is
	// inside the at-bottom slack and would otherwise be snapped back on the next token.
	test("a reader moving up stops following, even by a few pixels", () => {
		const chat = makeChat(684);
		chat.grow(2000);
		chat.readerScrollsBy(-5);
		expect(chat.following).toBe(false);
		chat.grow(400);
		expect(chat.gap()).toBe(405);
	});

	test("scrolling back down to the end resumes following", () => {
		const chat = makeChat(684);
		chat.grow(2000);
		chat.readerScrollsBy(-600);
		chat.grow(300);
		chat.readerScrollsBy(400);
		expect(chat.following).toBe(false);
		chat.readerScrollsBy(10_000);
		expect(chat.following).toBe(true);
	});

	// message_final can replace the streamed text with something shorter. The browser
	// clamps scrollTop down, which looks like moving up but leaves the view at the end.
	test("shrinking content clamps the view without ending following", () => {
		const chat = makeChat(684);
		chat.grow(2000);
		chat.shrink(700);
		expect(chat.following).toBe(true);
	});
});
