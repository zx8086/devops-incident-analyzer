// agent/src/iac/deployment-topology.test.ts
import { describe, expect, mock, test } from "bun:test";
import { branchSlug, parseIntentJson, reviewPlan, setDeploymentTopology } from "./nodes.ts";
import type { IacRequest } from "./state.ts";

// A real-shaped _deployments/<cluster>.json: global autoscale + per-tier zone_count, plus a raw
// user_settings_yaml string and sibling blocks that must survive byte-for-byte.
const DEPLOYMENT = JSON.stringify(
	{
		name: "eu-b2b",
		region: "eu-central-1",
		version: "8.15.0",
		elasticsearch: {
			autoscale: false,
			hot: { size: "4g", max_size: "64g", instance_configuration_id: "aws.es.datahot", zone_count: 2 },
			warm: { size: "2g", max_size: "32g", instance_configuration_id: "aws.es.datawarm", zone_count: 1 },
			user_settings_yaml: "xpack.security.authc.realms.saml.saml1:\n  order: 2\n  idp.metadata.path: x\n",
		},
		kibana: { size: "1g", zone_count: 1 },
		integrations_server: { size: "1g", zone_count: 1 },
	},
	null,
	2,
);

describe("setDeploymentTopology", () => {
	test("toggles global autoscale, captures previous, preserves tiers + user_settings_yaml", () => {
		const { content, previousAutoscale, changed } = setDeploymentTopology(DEPLOYMENT, { autoscale: true });
		const parsed = JSON.parse(content) as {
			elasticsearch: { autoscale: boolean; hot: { zone_count: number }; user_settings_yaml: string };
		};
		expect(changed).toBe(true);
		expect(previousAutoscale).toBe(false);
		expect(parsed.elasticsearch.autoscale).toBe(true);
		// every other field untouched
		expect(parsed.elasticsearch.hot.zone_count).toBe(2);
		expect(parsed.elasticsearch.user_settings_yaml).toBe(JSON.parse(DEPLOYMENT).elasticsearch.user_settings_yaml);
	});

	test("sets a tier's zone_count + autoscale, captures previous, leaves other tiers identical", () => {
		const { content, previousZoneCount, previousTierAutoscale, changed } = setDeploymentTopology(DEPLOYMENT, {
			tier: "hot",
			zoneCount: 3,
			tierAutoscale: true,
		});
		const parsed = JSON.parse(content) as {
			elasticsearch: { hot: { zone_count: number; autoscale: boolean; size: string }; warm: { zone_count: number } };
		};
		expect(changed).toBe(true);
		expect(previousZoneCount).toBe(2);
		expect(previousTierAutoscale).toBeUndefined(); // hot had no autoscale flag before
		expect(parsed.elasticsearch.hot.zone_count).toBe(3);
		expect(parsed.elasticsearch.hot.autoscale).toBe(true);
		expect(parsed.elasticsearch.hot.size).toBe("4g"); // sizing untouched
		expect(parsed.elasticsearch.warm.zone_count).toBe(1); // other tier untouched
	});

	test("changed=false when nothing requested + preserves trailing newline", () => {
		expect(setDeploymentTopology(DEPLOYMENT, {}).changed).toBe(false);
		expect(setDeploymentTopology(DEPLOYMENT, { autoscale: true }).content.endsWith("}\n")).toBe(true);
	});

	test("throws on an unknown tier", () => {
		expect(() => setDeploymentTopology(DEPLOYMENT, { tier: "ghost", zoneCount: 2 })).toThrow("unknown or unsized tier");
	});

	test("throws on a deployment JSON with no elasticsearch block", () => {
		expect(() => setDeploymentTopology(JSON.stringify({ name: "x" }), { autoscale: true })).toThrow(
			"no elasticsearch block",
		);
	});
});

describe("parseIntentJson — topology-edit", () => {
	test("maps autoscale + tier zone_count/autoscale fields", () => {
		const req = parseIntentJson(
			JSON.stringify({
				workflow: "topology-edit",
				cluster: "eu-b2b",
				autoscaleEnabled: true,
				topologyTier: "hot",
				tierZoneCount: 3,
				tierAutoscale: false,
			}),
		);
		expect(req?.workflow).toBe("topology-edit");
		expect(req?.cluster).toBe("eu-b2b");
		expect(req?.autoscaleEnabled).toBe(true);
		expect(req?.topologyTier).toBe("hot");
		expect(req?.tierZoneCount).toBe(3);
		expect(req?.tierAutoscale).toBe(false);
	});
});

describe("branchSlug — topology", () => {
	test("autoscale-only change (no tier) drops the empty descriptor", () => {
		const req: IacRequest = { workflow: "topology-edit", isProd: false, cluster: "eu-b2b", autoscaleEnabled: true };
		expect(branchSlug(req)).toBe("eu-b2b-topology-edit");
	});
	test("tier change uses the tier as the descriptor", () => {
		const req: IacRequest = {
			workflow: "topology-edit",
			isProd: false,
			cluster: "eu-b2b",
			topologyTier: "hot",
			tierZoneCount: 3,
		};
		expect(branchSlug(req)).toBe("eu-b2b-hot-topology-edit");
	});
});

describe("draftChange -> proposeTopologyChange", () => {
	const fileResult = `[200] ${JSON.stringify({ content: Buffer.from(DEPLOYMENT).toString("base64"), encoding: "base64" })}`;

	test("happy path: sets autoscale + hot zone_count, commits; commit body preserves user_settings_yaml", async () => {
		const { draftChange } = await import("./nodes.ts");
		let committed: Record<string, unknown> = {};
		mockTools({
			gitlab_get_file_content: () => fileResult,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: (args) => {
				committed = args;
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "topology-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				autoscaleEnabled: true,
				topologyTier: "hot",
				tierZoneCount: 3,
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-919 - partial IacState test stub
		const result = await draftChange(state as any);
		expect(result.precheckPassed).toBe(true);
		expect(result.proposedFilePath).toBe("environments/_deployments/eu-b2b.json");
		// diff shows only the changed scalars
		expect(result.proposedDiff).toContain('"autoscale": true');
		expect(result.proposedDiff).toContain('"zone_count": 3');
		// committed body kept user_settings_yaml + sizing intact
		const written = JSON.parse(String(committed.content)) as {
			elasticsearch: { hot: { size: string; zone_count: number }; user_settings_yaml: string };
		};
		expect(written.elasticsearch.hot.zone_count).toBe(3);
		expect(written.elasticsearch.hot.size).toBe("4g");
		expect(written.elasticsearch.user_settings_yaml).toBe(JSON.parse(DEPLOYMENT).elasticsearch.user_settings_yaml);
	});

	test("blocks (no MR) on 404", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({ gitlab_get_file_content: () => '[404] {"message":"404 File Not Found"}' });
		const state = {
			iacRequest: {
				workflow: "topology-edit" as const,
				isProd: false,
				cluster: "nope",
				autoscaleEnabled: true,
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-919 - partial IacState test stub
		const result = await draftChange(state as any);
		expect(result.blockedReason).toContain("not found");
	});

	test("blocks on zone_count outside 1-3 before any repo read", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({}); // no gitlab tools -> proves the guard fires before reading
		const state = {
			iacRequest: {
				workflow: "topology-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				topologyTier: "hot",
				tierZoneCount: 5,
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-919 - partial IacState test stub
		const result = await draftChange(state as any);
		expect(result.blockedReason).toContain("zone_count");
	});

	test("clarifies on an unknown tier", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({ gitlab_get_file_content: () => fileResult });
		const state = {
			iacRequest: {
				workflow: "topology-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				topologyTier: "ghost",
				tierZoneCount: 2,
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-919 - partial IacState test stub
		const result = await draftChange(state as any);
		expect(result.blockedReason).toContain("ghost");
	});

	test("no-op when the value already matches", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({ gitlab_get_file_content: () => fileResult });
		const state = {
			iacRequest: {
				workflow: "topology-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				topologyTier: "hot",
				tierZoneCount: 2, // already 2 in DEPLOYMENT
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-919 - partial IacState test stub
		const result = await draftChange(state as any);
		expect(result.blockedReason).toContain("already has the requested topology values");
	});
});

describe("reviewPlan — topology", () => {
	test("config-edit kind + always-HIGH shared-state risk leading", async () => {
		const state = {
			iacRequest: {
				workflow: "topology-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				autoscaleEnabled: true,
				topologyTier: "hot",
				tierZoneCount: 3,
			},
			branch: "b",
			proposedDiff: "(diff)",
			precheckPassed: true,
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-919 - partial IacState test stub
		const result = await reviewPlan(state as any);
		expect(result.planReview?.kind).toBe("config-edit");
		expect(result.planReview?.title).toContain("eu-b2b");
		// the shared-state warning must lead the risk list (highest blast radius in the repo)
		expect(result.risks?.[0]).toContain("SINGLE shared Terraform state");
	});
});

function mockTools(handlers: Record<string, (args: Record<string, unknown>) => string>) {
	const tools = Object.entries(handlers).map(([name, fn]) => ({
		name,
		invoke: async (args: Record<string, unknown>) => fn(args),
	}));
	mock.module("../mcp-bridge.ts", () => ({
		getToolsForDataSource: () => tools,
		getConnectedServers: () => ["elastic-iac-mcp"],
	}));
}
