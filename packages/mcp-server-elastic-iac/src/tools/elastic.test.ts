// src/tools/elastic.test.ts
import { describe, expect, test } from "bun:test";
import { asDeploymentRows, extractDeploymentDetail, extractListRow, resolveCluster } from "./elastic.ts";

// Mirrors the real Elastic Cloud GET /api/v1/deployments envelope: deployments[]
// where resources is a flat array tagged with `kind`. The list endpoint carries
// name/id/region but NO version and NO health -- those only appear on the
// per-deployment GET (see GET_BODY below).
const LIST_BODY = {
	deployments: [
		{
			id: "02655c3733ea471999d9cec39a17df32",
			name: "eu-b2b",
			resources: [
				{ ref_id: "main-elasticsearch", kind: "elasticsearch", region: "aws-eu-central-1" },
				{ ref_id: "main-kibana", kind: "kibana", region: "aws-eu-central-1" },
			],
		},
		{ id: "e9187e63042544fbbe5505fec02fc769", name: "eu-onboarding", resources: [] },
	],
};

// Mirrors the per-deployment GET: resources.elasticsearch[].info with health at
// info.healthy and version at info.plan_info.current.plan.elasticsearch.version.
const GET_BODY = {
	resources: {
		elasticsearch: [
			{
				region: "aws-eu-central-1",
				info: {
					healthy: true,
					plan_info: { current: { plan: { elasticsearch: { version: "9.4.1" } } } },
				},
			},
		],
	},
};

describe("asDeploymentRows", () => {
	test("extracts the deployments array from the list envelope", () => {
		expect(asDeploymentRows(LIST_BODY)).toHaveLength(2);
	});

	test("returns [] for non-envelope shapes", () => {
		expect(asDeploymentRows(null)).toEqual([]);
		expect(asDeploymentRows({})).toEqual([]);
		expect(asDeploymentRows({ deployments: "nope" })).toEqual([]);
		expect(asDeploymentRows([])).toEqual([]);
	});
});

describe("extractListRow", () => {
	test("pulls name/id/region from the elasticsearch resource; version/health deferred", () => {
		const [row] = asDeploymentRows(LIST_BODY);
		if (!row) throw new Error("fixture row missing");
		expect(extractListRow(row)).toEqual({
			name: "eu-b2b",
			id: "02655c3733ea471999d9cec39a17df32",
			version: "",
			region: "aws-eu-central-1",
			healthy: null,
		});
	});

	test("handles a row with no elasticsearch resource", () => {
		const row = asDeploymentRows(LIST_BODY)[1];
		if (!row) throw new Error("fixture row missing");
		expect(extractListRow(row)).toEqual({
			name: "eu-onboarding",
			id: "e9187e63042544fbbe5505fec02fc769",
			version: "",
			region: "",
			healthy: null,
		});
	});

	test("defaults name on a fully empty row", () => {
		expect(extractListRow({})).toEqual({ name: "(unnamed)", id: "", version: "", region: "", healthy: null });
	});
});

describe("extractDeploymentDetail", () => {
	test("reads version, health, and region from the per-deployment GET", () => {
		expect(extractDeploymentDetail(GET_BODY)).toEqual({
			version: "9.4.1",
			healthy: true,
			region: "aws-eu-central-1",
		});
	});

	test("degrades to empty/null on a missing or malformed body", () => {
		expect(extractDeploymentDetail(null)).toEqual({ version: "", healthy: null, region: "" });
		expect(extractDeploymentDetail({ resources: {} })).toEqual({ version: "", healthy: null, region: "" });
		expect(extractDeploymentDetail({ resources: { elasticsearch: [{ info: {} }] } })).toEqual({
			version: "",
			healthy: null,
			region: "",
		});
	});
});

// reconcile-to-live cluster auth: the data-plane Authorization header per configured deployment.
describe("resolveCluster", () => {
	const deployments = [
		{ id: "eu-b2b", url: "https://es.example:9243", apiKey: "abc123" },
		{ id: "eu-cld", url: "https://cld.example:9243", username: "u", password: "p" },
		{ id: "eu-bare", url: "https://bare.example:9243" },
	];

	test("builds an ApiKey header when an apiKey is configured", () => {
		expect(resolveCluster(deployments, "eu-b2b")).toEqual({
			url: "https://es.example:9243",
			authHeader: "ApiKey abc123",
		});
	});

	test("builds a Basic header from username + password", () => {
		expect(resolveCluster(deployments, "eu-cld")).toEqual({
			url: "https://cld.example:9243",
			authHeader: `Basic ${Buffer.from("u:p").toString("base64")}`,
		});
	});

	test("no auth header when neither apiKey nor basic creds are set", () => {
		expect(resolveCluster(deployments, "eu-bare")).toEqual({ url: "https://bare.example:9243" });
	});

	test("unknown / unset deployment -> empty url (treated as not configured)", () => {
		expect(resolveCluster(deployments, "nope")).toEqual({ url: "" });
		expect(resolveCluster(deployments, undefined)).toEqual({ url: "" });
	});
});
