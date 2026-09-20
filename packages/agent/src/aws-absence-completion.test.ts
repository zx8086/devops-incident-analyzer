// agent/src/aws-absence-completion.test.ts
// SIO-1784. These drive the REAL ledger (createLoopGuardState + observeEcsListResult +
// awsEcsAbsenceBlocker), not a stand-in for it: the whole point of the ticket is what the ledger
// concludes after the completion runs, so a fake ledger would only assert that this file agrees
// with itself. Only the TRANSPORT is faked -- `invoke` returns page payloads shaped exactly as
// observeEcsListResult parses them (serviceArns / clusterArns, nextToken, _truncated, the AWS
// error envelope).
import { describe, expect, test } from "bun:test";
import {
	completeEcsEnumeration,
	MAX_COMPLETION_CLUSTERS,
	MAX_COMPLETION_PAGES_PER_CLUSTER,
	unwalkedClustersFrom,
} from "./aws-absence-completion.ts";
import {
	awsEcsAbsenceBlocker,
	awsEcsAbsenceProven,
	createLoopGuardState,
	type LoopGuardState,
	observeEcsListResult,
} from "./sub-agent-loop-guard.ts";

const FOCUS = ["prana-import-export-service"];

// A ledger that has listed `clusters` (final page) and fully walked `walked`, i.e. the state the
// ReAct loop leaves behind when the model lists clusters but only some of their services.
function ledgerWith(clusters: string[], walked: string[] = []): LoopGuardState {
	const state = createLoopGuardState({ awsAbsenceEarlyExit: true, focusServices: FOCUS });
	observeEcsListResult(
		state,
		"aws_ecs_list_clusters",
		JSON.stringify({ clusterArns: clusters.map((c) => `arn:aws:ecs:eu-west-1:1:cluster/${c}`) }),
		{},
	);
	for (const c of walked) {
		observeEcsListResult(state, "aws_ecs_list_services", JSON.stringify({ serviceArns: [] }), { cluster: c });
	}
	return state;
}

// Wires the real ledger to the completion exactly as sub-agent.ts does through runSignals.
function depsFor(state: LoopGuardState, pages: Map<string, unknown[]>) {
	const calls: Array<Record<string, unknown>> = [];
	return {
		calls,
		deps: {
			invoke: async (_tool: string, args: Record<string, unknown>) => {
				calls.push(args);
				const queue = pages.get(String(args.cluster)) ?? [];
				const next = queue.shift();
				return next ?? JSON.stringify({ serviceArns: [] });
			},
			observe: (tool: string, content: unknown, arg: unknown) => observeEcsListResult(state, tool, content, arg),
			blocker: () => awsEcsAbsenceBlocker(state),
		},
	};
}

describe("unwalkedClustersFrom (SIO-1784)", () => {
	test("parses the cluster list out of the services-incomplete blocker", () => {
		expect(unwalkedClustersFrom("services-incomplete:a,b,c")).toEqual(["a", "b", "c"]);
	});

	// Running on any other blocker would either waste calls on a settled question (matched,
	// failed) or chase a gap this cannot close (the cluster list itself being unfinished).
	test.each([["matched"], ["failed"], ["zero-clusters"], ["cluster-pages-incomplete"], [null], [undefined]])(
		"refuses to run for blocker %p",
		(blocker) => {
			expect(unwalkedClustersFrom(blocker as string | null | undefined)).toBeNull();
		},
	);
});

describe("completeEcsEnumeration (SIO-1784)", () => {
	// The headline case: the model listed 5 clusters and walked 1. Before the completion the
	// proof is refused; after it, it holds.
	test("walking the unwalked clusters turns an unproven absence into a proof", async () => {
		const state = ledgerWith(["a", "b", "c", "d", "e"], ["a"]);
		expect(awsEcsAbsenceProven(state)).toBe(false);
		expect(awsEcsAbsenceBlocker(state)).toBe("services-incomplete:b,c,d,e");

		const { deps, calls } = depsFor(state, new Map());
		const walked = await completeEcsEnumeration(deps);

		expect(walked).toEqual(["b", "c", "d", "e"]);
		expect(calls).toHaveLength(4);
		expect(awsEcsAbsenceProven(state)).toBe(true);
		expect(awsEcsAbsenceBlocker(state)).toBeNull();
	});

	// Fail-closed: finding the service ends the hunt and the estate keeps its verify card.
	test("a match during completion stops the walk and blocks the proof", async () => {
		const state = ledgerWith(["a", "b", "c"], ["a"]);
		const pages = new Map<string, unknown[]>([
			["b", [JSON.stringify({ serviceArns: ["arn:aws:ecs:eu-west-1:1:service/b/prana-import-export-service"] })]],
		]);
		const { deps, calls } = depsFor(state, pages);

		const walked = await completeEcsEnumeration(deps);

		expect(awsEcsAbsenceBlocker(state)).toBe("matched");
		expect(awsEcsAbsenceProven(state)).toBe(false);
		expect(walked).toEqual(["b"]);
		// c is never listed: the answer is already known.
		expect(calls).toHaveLength(1);
	});

	test("an AWS error during completion blocks the proof", async () => {
		const state = ledgerWith(["a", "b"], ["a"]);
		const pages = new Map<string, unknown[]>([
			["b", [JSON.stringify({ _error: { kind: "auth-denied", message: "denied" } })]],
		]);
		const { deps } = depsFor(state, pages);

		await completeEcsEnumeration(deps);

		expect(awsEcsAbsenceBlocker(state)).toBe("failed");
		expect(awsEcsAbsenceProven(state)).toBe(false);
	});

	// A byte-truncated page dropped items, so the enumeration cannot be called complete.
	test("a truncated page during completion blocks the proof", async () => {
		const state = ledgerWith(["a", "b"], ["a"]);
		const pages = new Map<string, unknown[]>([["b", [JSON.stringify({ serviceArns: [], _truncated: true })]]]);
		const { deps } = depsFor(state, pages);

		await completeEcsEnumeration(deps);

		expect(awsEcsAbsenceBlocker(state)).toBe("failed");
		expect(awsEcsAbsenceProven(state)).toBe(false);
	});

	test("more unwalked clusters than the bound spends no calls at all", async () => {
		const many = Array.from({ length: MAX_COMPLETION_CLUSTERS + 1 }, (_, i) => `c${i}`);
		const state = ledgerWith(many);
		const { deps, calls } = depsFor(state, new Map());

		const walked = await completeEcsEnumeration(deps);

		expect(walked).toEqual([]);
		expect(calls).toHaveLength(0);
		expect(awsEcsAbsenceBlocker(state)?.startsWith("services-incomplete:")).toBe(true);
	});

	// Bounded paging: a cluster that needs more pages than the bound is left unwalked, and the
	// proof correctly does not hold.
	test("a cluster needing more pages than the bound leaves the proof unproven", async () => {
		const state = ledgerWith(["a"]);
		const endless = Array.from({ length: MAX_COMPLETION_PAGES_PER_CLUSTER + 2 }, (_, i) =>
			JSON.stringify({ serviceArns: [], nextToken: `t${i}` }),
		);
		const { deps, calls } = depsFor(state, new Map([["a", endless]]));

		await completeEcsEnumeration(deps);

		expect(calls).toHaveLength(MAX_COMPLETION_PAGES_PER_CLUSTER);
		expect(awsEcsAbsenceProven(state)).toBe(false);
		expect(awsEcsAbsenceBlocker(state)).toBe("services-incomplete:a");
	});

	// THE case the instrumented route could not have handled: the model fetched page 1 of this
	// cluster and never asked for page 2, so the cluster is unwalked AND page 1 is already a seen
	// signature. Re-walking from page 1 through the uninstrumented tool completes it.
	test("a cluster the model paginated only partway is re-walked from page 1", async () => {
		const state = createLoopGuardState({ awsAbsenceEarlyExit: true, focusServices: FOCUS });
		observeEcsListResult(
			state,
			"aws_ecs_list_clusters",
			JSON.stringify({ clusterArns: ["arn:aws:ecs:eu-west-1:1:cluster/a"] }),
			{},
		);
		// The model's page 1: carries a token, so the cluster is NOT complete.
		observeEcsListResult(state, "aws_ecs_list_services", JSON.stringify({ serviceArns: [], nextToken: "t1" }), {
			cluster: "a",
		});
		expect(awsEcsAbsenceBlocker(state)).toBe("services-incomplete:a");

		const pages = new Map<string, unknown[]>([
			["a", [JSON.stringify({ serviceArns: [], nextToken: "t1" }), JSON.stringify({ serviceArns: [] })]],
		]);
		const { deps, calls } = depsFor(state, pages);

		const walked = await completeEcsEnumeration(deps);

		expect(calls).toEqual([{ cluster: "a" }, { cluster: "a", cursor: "t1" }]);
		expect(walked).toEqual(["a"]);
		expect(awsEcsAbsenceProven(state)).toBe(true);
	});

	// The ledger accepts a text-block array as well as a string, so the pager must read a token
	// out of one too, or a paginated cluster would stop at page 1 and stay unwalked.
	test("follows the cursor when pages arrive as text blocks", async () => {
		const state = ledgerWith(["a"]);
		const pages = new Map<string, unknown[]>([
			[
				"a",
				[
					[{ type: "text", text: JSON.stringify({ serviceArns: [], nextToken: "t1" }) }],
					[{ type: "text", text: JSON.stringify({ serviceArns: [] }) }],
				],
			],
		]);
		const { deps, calls } = depsFor(state, pages);

		await completeEcsEnumeration(deps);

		expect(calls).toEqual([{ cluster: "a" }, { cluster: "a", cursor: "t1" }]);
		expect(awsEcsAbsenceProven(state)).toBe(true);
	});

	// Greptile P1 on #855: this loop runs AFTER the ReAct stream's own timeout is spent and can
	// make up to MAX_COMPLETION_CLUSTERS x MAX_COMPLETION_PAGES_PER_CLUSTER sequential calls, so
	// without a deadline a slow estate keeps the sub-agent alive long past its budget and starves
	// downstream aggregation. The bound is checked BETWEEN calls, so it bounds the whole loop.
	test("an already-expired deadline makes no calls at all", async () => {
		const state = ledgerWith(["a", "b"]);
		const { deps, calls } = depsFor(state, new Map());

		const walked = await completeEcsEnumeration({ ...deps, deadlineAt: Date.now() - 1 });

		expect(calls).toEqual([]);
		expect(walked).toEqual([]);
	});

	test("a deadline that expires mid-walk stops early and returns what it walked", async () => {
		const state = ledgerWith(["a", "b", "c"]);
		const pages = new Map<string, unknown[]>([
			["a", [{ serviceArns: [] }]],
			["b", [{ serviceArns: [] }]],
			["c", [{ serviceArns: [] }]],
		]);
		const { deps, calls } = depsFor(state, pages);

		// Expires once the first cluster has been walked.
		let now = Date.now();
		const deadlineAt = now + 5;
		const spy = {
			...deps,
			invoke: async (t: string, a: Record<string, unknown>) => {
				now += 10; // each call consumes more than the remaining budget
				return deps.invoke(t, a);
			},
		};
		const realNow = Date.now;
		Date.now = () => now;
		try {
			const walked = await completeEcsEnumeration({ ...spy, deadlineAt });
			expect(walked.length).toBeLessThan(3);
			expect(calls.length).toBeLessThan(3);
		} finally {
			Date.now = realNow;
		}
	});

	// The bound must not change behaviour when there is budget left, or it would silently
	// disable the completion the ticket exists for.
	test("a deadline far in the future walks everything, unchanged", async () => {
		const state = ledgerWith(["a"]);
		const pages = new Map<string, unknown[]>([["a", [{ serviceArns: [] }]]]);
		const { deps, calls } = depsFor(state, pages);

		const walked = await completeEcsEnumeration({ ...deps, deadlineAt: Date.now() + 60_000 });

		expect(walked).toEqual(["a"]);
		expect(calls).toEqual([{ cluster: "a" }]);
		expect(awsEcsAbsenceProven(state)).toBe(true);
	});
});
