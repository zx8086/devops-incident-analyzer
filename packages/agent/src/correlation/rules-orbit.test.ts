// packages/agent/src/correlation/rules-orbit.test.ts
// SIO-1076: unit tests for the Orbit cross-project correlation rules. Timestamps
// are RELATIVE to Date.now() (reference_time_bomb_correlation_tests) so a fixed
// deploy window never ages out and turns the suite red on a future run date.
import { describe, expect, test } from "bun:test";
import type { ElasticFindings, OrbitFindings } from "@devops-agent/shared";
import type { AgentStateType } from "../state.ts";
import { correlationRules } from "./rules.ts";

function findRule(name: string) {
	const rule = correlationRules.find((r) => r.name === name);
	if (!rule) throw new Error(`Rule ${name} not found`);
	return rule;
}

const DAY = 24 * 60 * 60 * 1000;
function daysAgo(n: number): string {
	return new Date(Date.now() - n * DAY).toISOString();
}

function makeState(opts: { orbit?: OrbitFindings; elastic?: ElasticFindings; focus?: string[] }) {
	const dataSourceResults: unknown[] = [];
	if (opts.orbit) {
		dataSourceResults.push({ dataSourceId: "gitlab", status: "success", data: "", orbitFindings: opts.orbit });
	}
	if (opts.elastic) {
		dataSourceResults.push({ dataSourceId: "elastic", status: "success", data: "", elasticFindings: opts.elastic });
	}
	return {
		dataSourceResults,
		...(opts.focus
			? { investigationFocus: { services: opts.focus, datasources: [], summary: "", establishedAtTurn: 1 } }
			: {}),
	} as unknown as AgentStateType;
}

describe("orbit-deploy-needs-blast-radius (cost gate)", () => {
	const rule = findRule("orbit-deploy-needs-blast-radius");

	test("fires only when a recent deploy AND an elastic error coincide", () => {
		const state = makeState({
			orbit: { recentDeploys: [{ mrId: "10", project: "pvhcorp/checkout", mergedAt: daysAgo(2) }] },
			elastic: { apmServices: [{ serviceName: "checkout", errorRate: 0.3, observedAt: daysAgo(1) }] },
		});
		const match = rule.trigger(state);
		expect(match).not.toBeNull();
		expect(match?.context.requestBlastRadius).toBe(true);
		expect(match?.context.services).toContain("checkout");
	});

	test("does NOT fire without an elastic error signal", () => {
		const state = makeState({
			orbit: { recentDeploys: [{ mrId: "10", project: "pvhcorp/checkout", mergedAt: daysAgo(2) }] },
			elastic: { apmServices: [{ serviceName: "checkout", errorRate: 0, observedAt: daysAgo(1) }] },
		});
		expect(rule.trigger(state)).toBeNull();
	});

	test("does NOT fire once blast radius has already been fetched (idempotent)", () => {
		const state = makeState({
			orbit: {
				recentDeploys: [{ mrId: "10", project: "pvhcorp/checkout", mergedAt: daysAgo(2) }],
				blastRadius: [{ definitionName: "x", importedByProjects: [], importedByFiles: [], importSiteCount: 0 }],
			},
			elastic: {
				logClusters: [{ signature: "s", sampleMessage: "boom", count: 5, level: "error", service: "checkout" }],
			},
		});
		expect(rule.trigger(state)).toBeNull();
	});

	test("does NOT fire when the deploy is outside the 30-day window", () => {
		const state = makeState({
			orbit: { recentDeploys: [{ mrId: "10", project: "pvhcorp/checkout", mergedAt: daysAgo(45) }] },
			elastic: { apmServices: [{ serviceName: "checkout", errorRate: 0.3, observedAt: daysAgo(1) }] },
		});
		expect(rule.trigger(state)).toBeNull();
	});
});

describe("orbit-deploy-blast-radius-vs-elastic (flagship)", () => {
	const rule = findRule("orbit-deploy-blast-radius-vs-elastic");

	test("fires when a downstream importer shows a POST-merge error spike", () => {
		const merged = daysAgo(3);
		const state = makeState({
			orbit: {
				blastRadius: [
					{
						definitionName: "Auth::verify",
						sourceProject: "pvhcorp/auth-lib",
						mrId: "10",
						mrMergedAt: merged,
						importedByProjects: ["pvhcorp/checkout"],
						importedByFiles: [{ project: "pvhcorp/checkout", file: "app.rb" }],
						importSiteCount: 1,
					},
				],
			},
			elastic: { apmServices: [{ serviceName: "checkout", errorRate: 0.5, observedAt: daysAgo(1) }] },
		});
		const match = rule.trigger(state);
		expect(match).not.toBeNull();
		expect(match?.context.services).toContain("pvhcorp/checkout");
		expect(rule.requiredAgent).toBe("elastic-agent");
	});

	test("does NOT fire when the elastic error is BEFORE the merge", () => {
		const merged = daysAgo(1);
		const state = makeState({
			orbit: {
				blastRadius: [
					{
						definitionName: "Auth::verify",
						mrId: "10",
						mrMergedAt: merged,
						importedByProjects: ["pvhcorp/checkout"],
						importedByFiles: [{ project: "pvhcorp/checkout", file: "app.rb" }],
						importSiteCount: 1,
					},
				],
			},
			// observed 3 days ago = before a merge 1 day ago
			elastic: { apmServices: [{ serviceName: "checkout", errorRate: 0.5, observedAt: daysAgo(3) }] },
		});
		expect(rule.trigger(state)).toBeNull();
	});

	test("does NOT fire when no downstream service matches an elastic error", () => {
		const state = makeState({
			orbit: {
				blastRadius: [
					{
						definitionName: "Auth::verify",
						mrId: "10",
						mrMergedAt: daysAgo(3),
						importedByProjects: ["pvhcorp/orders"],
						importedByFiles: [{ project: "pvhcorp/orders", file: "h.rb" }],
						importSiteCount: 1,
					},
				],
			},
			elastic: { apmServices: [{ serviceName: "payments", errorRate: 0.5, observedAt: daysAgo(1) }] },
		});
		expect(rule.trigger(state)).toBeNull();
	});
});

describe("orbit-pipeline-failure-vs-incident", () => {
	const rule = findRule("orbit-pipeline-failure-vs-incident");

	test("fires on a focus project with repeated failures", () => {
		const state = makeState({
			orbit: { pipelineFailures: [{ project: "pvhcorp/checkout", failureCount: 5 }] },
			focus: ["checkout"],
		});
		const match = rule.trigger(state);
		expect(match).not.toBeNull();
		expect(match?.context.services).toContain("pvhcorp/checkout");
	});

	test("does NOT fire below the failure threshold", () => {
		const state = makeState({
			orbit: { pipelineFailures: [{ project: "pvhcorp/checkout", failureCount: 1 }] },
			focus: ["checkout"],
		});
		expect(rule.trigger(state)).toBeNull();
	});
});

describe("orbit-vuln-introduced-by-recent-mr (self-signalling)", () => {
	const rule = findRule("orbit-vuln-introduced-by-recent-mr");

	test("is self-signalling (skipCoverageCheck)", () => {
		expect(rule.skipCoverageCheck).toBe(true);
	});

	test("fires on a critical vuln for a focus project", () => {
		const state = makeState({
			orbit: { vulnerabilities: [{ severity: "critical", project: "pvhcorp/checkout", title: "SQLi" }] },
			focus: ["checkout"],
		});
		expect(rule.trigger(state)).not.toBeNull();
	});

	test("does NOT fire on a medium-severity vuln", () => {
		const state = makeState({
			orbit: { vulnerabilities: [{ severity: "medium", project: "pvhcorp/checkout", title: "x" }] },
			focus: ["checkout"],
		});
		expect(rule.trigger(state)).toBeNull();
	});
});
