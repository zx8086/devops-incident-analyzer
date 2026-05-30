// agent/src/memory-promotion.ts
//
// SIO-849: bridges durable-learning proposals to the PR-based HITL flow. Wiki
// ingests and promoted key-decisions enqueue a proposal during a session; the
// lifecycle teardown's open_memory_pr step flushes the queue into review PRs.
// Direct promotion (the explicit "promote to memory" endpoint) is also exposed.

import { type MemoryPrProposal, type OpenMemoryPrResult, openMemoryPr } from "@devops-agent/memory-pr";
import { getLogger } from "@devops-agent/observability";
import { registerMemoryPrOpener } from "./lifecycle.ts";

const logger = getLogger("agent:memory-promotion");

// Proposals accumulated during a session, flushed at teardown. In-memory and
// process-scoped: durable enough for a single web process's session lifetime,
// and intentionally not routed through the checkpointer (these are learned
// knowledge, not transient graph state).
const pending: MemoryPrProposal[] = [];

export function queueMemoryProposal(proposal: MemoryPrProposal): void {
	pending.push(proposal);
	logger.info({ kind: proposal.kind, branch: proposal.branch, queued: pending.length }, "queued memory proposal");
}

export function pendingMemoryProposalCount(): number {
	return pending.length;
}

// Flushes every queued proposal into a review PR. Best-effort: a failure on one
// proposal is logged and does not abort the rest.
export async function flushMemoryProposals(): Promise<OpenMemoryPrResult[]> {
	const batch = pending.splice(0, pending.length);
	const results: OpenMemoryPrResult[] = [];
	for (const proposal of batch) {
		try {
			results.push(await openMemoryPr(proposal));
		} catch (error) {
			logger.warn(
				{ kind: proposal.kind, error: error instanceof Error ? error.message : String(error) },
				"memory proposal PR failed; continuing",
			);
		}
	}
	return results;
}

// Open a single proposal immediately (explicit "promote to memory" trigger).
export async function promoteToMemory(proposal: MemoryPrProposal): Promise<OpenMemoryPrResult> {
	return openMemoryPr(proposal);
}

// Wire the lifecycle teardown seam so open_memory_pr flushes the queue. Idempotent
// enough to call once at process startup.
export function installMemoryPromotion(): void {
	registerMemoryPrOpener(async () => {
		await flushMemoryProposals();
	});
}
