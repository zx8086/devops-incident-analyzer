// apps/web/src/lib/components/chat-follow.ts
// Whether the chat column keeps its newest content in view. Kept apart from +page.svelte
// for the same reason as pi-fleet-scroll.ts: the scroll is browser-only, the rule is not.
import { isAtBottom } from "./pi-fleet-scroll.ts";

// The rule this replaces asked "is the reader within 100px of the end?" AFTER the DOM had
// grown. Any single growth over 100px -- the streaming bubble appearing (232px, measured),
// a rendered table, the findings cards -- read as "scrolled away" and following never came
// back: one 74px scroll, then a 4443px gap for the rest of the turn.
//
// Growth must never look like the reader leaving. Only the reader MOVING UP does, and only
// a scroll event can report that, so the decision is made from the direction of travel:
//   - moved up and off the end: they are reading, stop following
//   - at the end (scrolled back down, or clamped there by shrinking content): follow
//   - moved down or stood still while content grew underneath: no change
// Our own scroll-to-end only ever moves down, so it can never switch following off, even
// when more content lands between the scroll and its event.
export function followAfterScroll(
	following: boolean,
	lastTop: number,
	el: { scrollTop: number; clientHeight: number; scrollHeight: number },
): boolean {
	const gap = el.scrollHeight - el.clientHeight - el.scrollTop;
	// gap > 1 separates a reader from a clamp: shrinking content (message_final replacing
	// the streamed text) lowers scrollTop too, but leaves the view exactly at the end.
	if (el.scrollTop < lastTop && gap > 1) return false;
	return isAtBottom(el) ? true : following;
}
