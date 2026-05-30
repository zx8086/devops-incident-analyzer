// agent/src/memory-promotion.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MemoryPrProposal } from "@devops-agent/memory-pr";
import { flushMemoryProposals, pendingMemoryProposalCount, queueMemoryProposal } from "./memory-promotion.ts";

const proposal: MemoryPrProposal = {
	kind: "wiki-page",
	branch: "agent/learn/test",
	title: "t",
	body: "b",
	files: [{ path: "memory/wiki/pages/test.md", contents: "# clean" }],
};

const prevEnabled = process.env.MEMORY_PR_ENABLED;

beforeEach(() => {
	// Drain any leftover queue from a prior test (module state is process-scoped).
	void flushMemoryProposals();
	delete process.env.MEMORY_PR_ENABLED;
});

afterEach(() => {
	if (prevEnabled === undefined) delete process.env.MEMORY_PR_ENABLED;
	else process.env.MEMORY_PR_ENABLED = prevEnabled;
});

describe("memory promotion queue", () => {
	test("queues proposals and reports the pending count", () => {
		expect(pendingMemoryProposalCount()).toBe(0);
		queueMemoryProposal(proposal);
		queueMemoryProposal({ ...proposal, branch: "agent/learn/test2" });
		expect(pendingMemoryProposalCount()).toBe(2);
	});

	test("flush drains the queue; disabled proposals come back skipped", async () => {
		queueMemoryProposal(proposal);
		expect(pendingMemoryProposalCount()).toBe(1);
		const results = await flushMemoryProposals();
		expect(pendingMemoryProposalCount()).toBe(0);
		// MEMORY_PR_ENABLED unset -> openMemoryPr returns skipped, no network.
		expect(results).toHaveLength(1);
		expect(results[0]?.status).toBe("skipped");
	});
});
