// agent/src/iac/deployment-topology.test.ts
import { describe, expect, mock, test } from "bun:test";
import {
	branchSlug,
	parseIntentJson,
	reviewPlan,
	setComponentSize,
	setDeploymentTopology,
	setDeploymentUserSettings,
} from "./nodes.ts";
import type { IacRequest, IacStateType } from "./state.ts";

const asIacState = (partial: Partial<IacStateType>): IacStateType => partial as unknown as IacStateType;

// A real-shaped _deployments/<cluster>.json (mirrors the live eu-onboarding.json): global autoscale +
// per-tier zone_count; SSO user_settings_yaml lives under elasticsearch_config AND kibana (raw YAML
// inside a JSON string); integrations_server/kibana are sizable. All of this must survive byte-for-byte
// except the requested edit.
const ES_SSO =
	'xpack.security.authc.realms.saml.kibana-realm:\n  order: 2\n  idp.metadata.path: "https://idp/secret-md"\n';
const KB_SSO = "xpack.security.authc.providers:\n  saml.kibana-realm:\n    order: 0\n    realm: kibana-realm\n";
const DEPLOYMENT = JSON.stringify(
	{
		name: "eu-b2b",
		region: "eu-central-1",
		version: "8.15.0",
		elasticsearch: {
			autoscale: false,
			hot: { size: "4g", max_size: "64g", instance_configuration_id: "aws.es.datahot", zone_count: 2 },
			warm: { size: "2g", max_size: "32g", instance_configuration_id: "aws.es.datawarm", zone_count: 1 },
		},
		elasticsearch_config: { plugins: [], user_settings_yaml: ES_SSO },
		integrations_server: { size: "1g", instance_configuration_id: "aws.integrationsserver.c5d", zone_count: 1 },
		kibana: { size: "1g", instance_configuration_id: "aws.kibana.c5d", zone_count: 1, user_settings_yaml: KB_SSO },
	},
	null,
	2,
);

describe("setDeploymentTopology", () => {
	test("toggles global autoscale, captures previous, preserves tiers + SSO user_settings_yaml", () => {
		const { content, previousAutoscale, changed } = setDeploymentTopology(DEPLOYMENT, { autoscale: true });
		const parsed = JSON.parse(content) as {
			elasticsearch: { autoscale: boolean; hot: { zone_count: number } };
			elasticsearch_config: { user_settings_yaml: string };
		};
		expect(changed).toBe(true);
		expect(previousAutoscale).toBe(false);
		expect(parsed.elasticsearch.autoscale).toBe(true);
		// every other field untouched, including the SSO YAML under elasticsearch_config
		expect(parsed.elasticsearch.hot.zone_count).toBe(2);
		expect(parsed.elasticsearch_config.user_settings_yaml).toBe(ES_SSO);
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
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		expect(result.proposedFilePath).toBe("environments/_deployments/eu-b2b.json");
		// diff shows only the changed scalars
		expect(result.proposedDiff).toContain('"autoscale": true');
		expect(result.proposedDiff).toContain('"zone_count": 3');
		// committed body kept SSO user_settings_yaml + sizing intact
		const written = JSON.parse(String(committed.content)) as {
			elasticsearch: { hot: { size: string; zone_count: number } };
			elasticsearch_config: { user_settings_yaml: string };
			kibana: { user_settings_yaml: string };
		};
		expect(written.elasticsearch.hot.zone_count).toBe(3);
		expect(written.elasticsearch.hot.size).toBe("4g");
		expect(written.elasticsearch_config.user_settings_yaml).toBe(ES_SSO);
		expect(written.kibana.user_settings_yaml).toBe(KB_SSO);
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
		const result = await draftChange(asIacState(state));
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
		const result = await draftChange(asIacState(state));
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
		const result = await draftChange(asIacState(state));
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
		const result = await draftChange(asIacState(state));
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
		const result = await reviewPlan(asIacState(state));
		expect(result.planReview?.kind).toBe("config-edit");
		expect(result.planReview?.title).toContain("eu-b2b");
		// the shared-state warning must lead the risk list (highest blast radius in the repo)
		expect(result.risks?.[0]).toContain("SINGLE shared Terraform state");
	});
});

describe("setDeploymentUserSettings", () => {
	test("replaces the elasticsearch_config SSO YAML verbatim, captures previous, preserves kibana SSO", () => {
		const next = "xpack.security.authc.realms.oidc.oidc1:\n  order: 3\n";
		const { content, previousYaml, changed } = setDeploymentUserSettings(DEPLOYMENT, "elasticsearch_config", next);
		const parsed = JSON.parse(content) as {
			elasticsearch_config: { user_settings_yaml: string; plugins: unknown[] };
			kibana: { user_settings_yaml: string };
		};
		expect(changed).toBe(true);
		expect(previousYaml).toBe(ES_SSO);
		expect(parsed.elasticsearch_config.user_settings_yaml).toBe(next); // verbatim, not reformatted
		expect(parsed.elasticsearch_config.plugins).toEqual([]); // sibling field intact
		expect(parsed.kibana.user_settings_yaml).toBe(KB_SSO); // the OTHER SSO block untouched
	});

	test("targets the kibana auth-providers block independently", () => {
		const next = "xpack.security.authc.providers:\n  basic.basic-realm:\n    order: 0\n";
		const { content, changed } = setDeploymentUserSettings(DEPLOYMENT, "kibana", next);
		const parsed = JSON.parse(content) as {
			kibana: { user_settings_yaml: string };
			elasticsearch_config: { user_settings_yaml: string };
		};
		expect(changed).toBe(true);
		expect(parsed.kibana.user_settings_yaml).toBe(next);
		expect(parsed.elasticsearch_config.user_settings_yaml).toBe(ES_SSO); // ES realm untouched
	});

	test("changed=false when the YAML already matches + preserves trailing newline", () => {
		const same = setDeploymentUserSettings(DEPLOYMENT, "elasticsearch_config", ES_SSO);
		expect(same.changed).toBe(false);
		expect(same.content.endsWith("}\n")).toBe(true);
	});

	test("throws when the target block is missing", () => {
		expect(() => setDeploymentUserSettings(JSON.stringify({ name: "x" }), "kibana", "y")).toThrow("no kibana block");
	});
});

describe("setComponentSize", () => {
	test("sets integrations_server size + zone_count, captures previous, leaves kibana alone", () => {
		const { content, previousSize, previousZoneCount, changed } = setComponentSize(DEPLOYMENT, "integrations_server", {
			size: "2g",
			zoneCount: 2,
		});
		const parsed = JSON.parse(content) as {
			integrations_server: { size: string; zone_count: number; instance_configuration_id: string };
			kibana: { size: string };
		};
		expect(changed).toBe(true);
		expect(previousSize).toBe("1g");
		expect(previousZoneCount).toBe(1);
		expect(parsed.integrations_server.size).toBe("2g");
		expect(parsed.integrations_server.zone_count).toBe(2);
		expect(parsed.integrations_server.instance_configuration_id).toBe("aws.integrationsserver.c5d"); // intact
		expect(parsed.kibana.size).toBe("1g"); // other component untouched
	});

	test("changed=false when values already match", () => {
		expect(setComponentSize(DEPLOYMENT, "kibana", { size: "1g", zoneCount: 1 }).changed).toBe(false);
	});

	test("throws when the component is missing", () => {
		expect(() => setComponentSize(JSON.stringify({ name: "x" }), "kibana", { size: "1g" })).toThrow("no kibana block");
	});
});

describe("draftChange -> proposeTopologyChange (SSO + sizing)", () => {
	const fileResult = `[200] ${JSON.stringify({ content: Buffer.from(DEPLOYMENT).toString("base64"), encoding: "base64" })}`;

	test("SSO edit commits; the diff WITHHOLDS the YAML value (no idp/sp leak)", async () => {
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
		const newYaml = 'xpack.security.authc.realms.oidc.oidc1:\n  order: 3\n  rp.client_id: "secret-client-id"\n';
		const state = {
			iacRequest: {
				workflow: "topology-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				userSettingsTarget: "elasticsearch_config" as const,
				userSettingsYaml: newYaml,
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		// the diff names the target + a length delta, but NEVER the YAML body
		expect(result.proposedDiff).toContain("elasticsearch_config");
		expect(result.proposedDiff).toContain("value withheld");
		expect(result.proposedDiff).not.toContain("secret-client-id");
		expect(result.proposedDiff).not.toContain("oidc1");
		// the committed file DID write the new YAML verbatim
		const written = JSON.parse(String(committed.content)) as { elasticsearch_config: { user_settings_yaml: string } };
		expect(written.elasticsearch_config.user_settings_yaml).toBe(newYaml);
	});

	test("component sizing commits with a scalar diff", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({
			gitlab_get_file_content: () => fileResult,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const state = {
			iacRequest: {
				workflow: "topology-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				sizeComponent: "kibana" as const,
				componentSize: "2g",
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		expect(result.proposedDiff).toContain('"size": "2g"');
	});

	test("blocks on a component zone_count outside 1-3", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({ gitlab_get_file_content: () => fileResult });
		const state = {
			iacRequest: {
				workflow: "topology-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				sizeComponent: "kibana" as const,
				componentZoneCount: 9,
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("zone_count");
	});
});

describe("reviewPlan — topology SSO", () => {
	test("an SSO edit leads with COULD LOCK OUT LOGIN above the shared-state line", async () => {
		const state = {
			iacRequest: {
				workflow: "topology-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				userSettingsTarget: "kibana" as const,
				userSettingsYaml: "x",
			},
			branch: "b",
			proposedDiff: "(diff)",
			precheckPassed: true,
		};
		const result = await reviewPlan(asIacState(state));
		expect(result.risks?.[0]).toContain("COULD LOCK OUT LOGIN");
		expect(result.risks?.[0]).toContain("HUMAN REVIEW");
		// the shared-state line is still present, just below the login warning
		expect(result.risks?.some((r) => r.includes("SINGLE shared Terraform state"))).toBe(true);
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
