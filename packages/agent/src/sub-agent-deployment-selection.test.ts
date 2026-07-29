// agent/src/sub-agent-deployment-selection.test.ts
//
// SIO-1279: an unscoped incident about a service living in eu-b2b was answered from
// eu-cld. probeElastic now fans out across every configured deployment and records WHERE
// each candidate was found, but that discovery only matters if it reaches execution --
// queryDataSource picks the fan-out list, and its final branch used to be
// `state.targetDeployments` alone. Empty on an unscoped turn => the sub-agent took the
// non-fan-out path and queried whichever cluster the MCP defaults to.
//
// The query the sub-agent built was well-formed (all 12 candidates, service.environment
// filtered to production, proper aggs) and returned real buckets when run against eu-b2b
// by hand. It was simply pointed at the wrong cluster -- which is why elasticFindings came
// back empty on a run that otherwise looked healthy.

import { describe, expect, test } from "bun:test";
import { selectElasticDeployments } from "./sub-agent.ts";

const base = {
	dataSourceId: "elastic",
	isRetry: false,
	retryDeployments: [] as string[],
	targetDeployments: [] as string[],
};

describe("selectElasticDeployments (SIO-1279)", () => {
	test("falls back to the deployments the probe FOUND the service in", () => {
		expect(
			selectElasticDeployments({
				...base,
				placements: [{ deployment: "eu-b2b" }, { deployment: "eu-b2b" }, { deployment: "us-cld" }],
			}),
			"an unscoped turn must fan out to the clusters discovery located, not fall through to the MCP default",
		).toEqual(["eu-b2b", "us-cld"]);
	});

	test("an explicit caller selection still wins over the probe", () => {
		expect(
			selectElasticDeployments({
				...base,
				targetDeployments: ["eu-cld"],
				placements: [{ deployment: "eu-b2b" }],
			}),
		).toEqual(["eu-cld"]);
	});

	test("a retry uses only the deployments that failed (SIO-697 precedence preserved)", () => {
		expect(
			selectElasticDeployments({
				...base,
				isRetry: true,
				retryDeployments: ["ap-cld"],
				targetDeployments: ["eu-cld", "ap-cld"],
				placements: [{ deployment: "eu-b2b" }],
			}),
		).toEqual(["ap-cld"]);
	});

	// "(default)" is the probe's label for an unset ELASTIC_DEPLOYMENTS. Passing it as a
	// deployment header would 404 as an unknown deployment id, which is strictly worse
	// than the pre-SIO-1279 behaviour of simply not scoping.
	test("the synthetic (default) label never becomes a deployment header", () => {
		expect(selectElasticDeployments({ ...base, placements: [{ deployment: "(default)" }] })).toEqual([]);
		expect(selectElasticDeployments({ ...base, placements: [{ deployment: "" }] })).toEqual([]);
	});

	test("no placements and no selection stays empty (pre-SIO-649 non-fan-out path)", () => {
		expect(selectElasticDeployments({ ...base })).toEqual([]);
	});

	// Only elastic fans out; every other datasource ignores deployments entirely.
	test.each(["kafka", "aws", "gitlab", "couchbase"])("%s never fans out across deployments", (dataSourceId) => {
		expect(
			selectElasticDeployments({
				...base,
				dataSourceId,
				targetDeployments: ["eu-b2b"],
				placements: [{ deployment: "eu-b2b" }],
			}),
		).toEqual([]);
	});
});
