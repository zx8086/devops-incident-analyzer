// agent/src/pi-fleet/state.ts
//
// SIO-1655 (Phase 2c): state for the fleet console graph. The operator asks one
// question, the model picks spokes, each spoke answers, and the answers are
// composed into one attributed reply.
//
// Spoke replies are held here as DATA with provenance -- which estate, which
// message id, whether it actually arrived. They reach the model only through
// the synthesis step's untrusted-content wrapper (see tools.ts), never as bare
// conversation text, so the provenance can never be separated from the claim.

import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

// One spoke's contribution to the answer. `status` distinguishes the three
// outcomes the operator must be able to tell apart: it answered, it was asked
// and did not answer in time, or the send was parked because it was offline.
export interface SpokeReply {
	estate: string;
	target: string;
	msgId: string;
	status: "answered" | "no-reply" | "queued" | "failed";
	// The spoke's own words. Untrusted third-party text: summarized, never obeyed.
	text?: string;
	error?: string;
}

export const PiFleetState = Annotation.Root({
	...MessagesAnnotation.spec,

	// The operator's question for this turn, kept separate from the message list
	// so the synthesis step can restate it without walking the transcript.
	question: Annotation<string>({
		reducer: (_, next) => next,
		default: () => "",
	}),

	// Estates the model decided to ask. Replace-on-write: one round of asking
	// per turn (DUTIES step 6), so a second write is a correction, not an append.
	targets: Annotation<string[]>({
		reducer: (_, next) => next ?? [],
		default: () => [],
	}),

	// Accumulates across the turn: each spoke's reply lands as it is awaited.
	// Appends rather than replaces so a partial gather is still reportable.
	replies: Annotation<SpokeReply[]>({
		reducer: (prev, next) => [...prev, ...(next ?? [])],
		default: () => [],
	}),

	// True once the graph has registered with a hub, so teardown knows whether
	// a deregister is owed even if the run failed midway.
	registered: Annotation<boolean>({
		reducer: (_, next) => next,
		default: () => false,
	}),
});

export type PiFleetStateType = typeof PiFleetState.State;
