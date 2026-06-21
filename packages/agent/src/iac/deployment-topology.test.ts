// agent/src/iac/deployment-topology.test.ts
import { describe, expect, mock, test } from "bun:test";
import { parse } from "yaml";
import {
	branchSlug,
	mergeDeploymentUserSettingsKey,
	mergeUserSettingsKey,
	parseIntentJson,
	readDeploymentUserSettings,
	removeDeploymentUserSettingsKeys,
	removeUserSettingsKeys,
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

	// SIO-997: a non-SSO user_settings_yaml setting maps to the surgical merge fields, NOT "other".
	test("maps the user_settings_yaml single-key merge fields", () => {
		const req = parseIntentJson(
			JSON.stringify({
				workflow: "topology-edit",
				cluster: "eu-b2b",
				userSettingsMergeTarget: "elasticsearch_config",
				userSettingsMergeKey: "xpack.monitoring.collection.interval",
				userSettingsMergeValue: "60s",
			}),
		);
		expect(req?.workflow).toBe("topology-edit");
		expect(req?.userSettingsMergeTarget).toBe("elasticsearch_config");
		expect(req?.userSettingsMergeKey).toBe("xpack.monitoring.collection.interval");
		expect(req?.userSettingsMergeValue).toBe("60s");
		// the whole-block replace fields stay empty (this is the merge path, not a swap)
		expect(req?.userSettingsYaml).toBeUndefined();
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
		// SIO-997: the cluster appears ONCE (the [<cluster>] wrapper), not doubled by the descriptor.
		expect(result.planReview?.title).not.toContain("eu-b2b] eu-b2b");
		// the shared-state warning must lead the risk list (highest blast radius in the repo)
		expect(result.risks?.[0]).toContain("SINGLE shared Terraform state");
	});

	// SIO-997: the user_settings_yaml merge title names the key+value and is not cluster-doubled.
	test("user_settings_yaml merge title names the key=value, cluster once", async () => {
		const state = {
			iacRequest: {
				workflow: "topology-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				userSettingsMergeTarget: "elasticsearch_config" as const,
				userSettingsMergeKey: "xpack.monitoring.collection.interval",
				userSettingsMergeValue: "60s",
			},
			branch: "b",
			proposedDiff: "(diff)",
			precheckPassed: true,
		};
		const result = await reviewPlan(asIacState(state));
		expect(result.planReview?.title).toBe("[eu-b2b] xpack.monitoring.collection.interval=60s: topology-edit");
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

// SIO-997: surgical dotted-key merge into an existing user_settings_yaml -- the non-SSO common case
// (xpack.monitoring) must add ONE leaf and leave the xpack.security/OIDC subtree byte-for-byte.
describe("mergeUserSettingsKey (SIO-997)", () => {
	// The real eu-b2b nested-map OIDC block (abbreviated but structurally faithful to MR !199).
	const OIDC = [
		"xpack:",
		"  security:",
		"    authc:",
		"      realms:",
		"        oidc:",
		"          oidc-pvh-sso:",
		"            order: 2",
		'            rp.client_id: "86997c24-1ea8-4e05-af01-603fb3fe85bb"',
		"            claims.principal: email",
		"",
	].join("\n");

	test("adds the monitoring subtree under the SAME xpack key, leaving security byte-for-byte", () => {
		const { yaml, changed, touchesSecurity } = mergeUserSettingsKey(
			OIDC,
			"xpack.monitoring.collection.interval",
			"60s",
		);
		expect(changed).toBe(true);
		expect(touchesSecurity).toBe(false);
		// the entire original security subtree survives verbatim, including indentation
		expect(yaml).toContain("        oidc:\n          oidc-pvh-sso:\n            order: 2");
		expect(yaml).toContain('            rp.client_id: "86997c24-1ea8-4e05-af01-603fb3fe85bb"');
		// the new leaf is added under xpack, and re-parses to the right value
		const reparsed = parse(yaml) as { xpack: { monitoring: { collection: { interval: string } } } };
		expect(reparsed.xpack.monitoring.collection.interval).toBe("60s");
		// and security is still present + unchanged after a round-trip
		const sec = parse(yaml) as { xpack: { security: { authc: { realms: { oidc: Record<string, unknown> } } } } };
		expect(sec.xpack.security.authc.realms.oidc).toBeDefined();
	});

	test("changed=false when the key already holds the requested value", () => {
		const withKey = mergeUserSettingsKey(OIDC, "xpack.monitoring.collection.interval", "60s").yaml;
		const again = mergeUserSettingsKey(withKey, "xpack.monitoring.collection.interval", "60s");
		expect(again.changed).toBe(false);
	});

	test("captures the previous value when overwriting an existing key", () => {
		const withKey = mergeUserSettingsKey(OIDC, "xpack.monitoring.collection.interval", "10s").yaml;
		const over = mergeUserSettingsKey(withKey, "xpack.monitoring.collection.interval", "60s");
		expect(over.previousValue).toBe("10s");
		expect(over.changed).toBe(true);
	});

	test("flags touchesSecurity when the dotted key lands inside xpack.security", () => {
		const res = mergeUserSettingsKey(OIDC, "xpack.security.authc.realms.oidc.oidc-pvh-sso.order", "5");
		expect(res.touchesSecurity).toBe(true);
	});

	test("merges into an empty user_settings_yaml (no existing block)", () => {
		const { yaml, changed } = mergeUserSettingsKey("", "xpack.monitoring.collection.interval", "60s");
		expect(changed).toBe(true);
		expect(
			(parse(yaml) as { xpack: { monitoring: { collection: { interval: string } } } }).xpack.monitoring.collection
				.interval,
		).toBe("60s");
	});
});

describe("mergeDeploymentUserSettingsKey (SIO-997)", () => {
	test("merges the dotted key into elasticsearch_config, preserving every sibling + kibana SSO", () => {
		const { content, changed, touchesSecurity } = mergeDeploymentUserSettingsKey(
			DEPLOYMENT,
			"elasticsearch_config",
			"xpack.monitoring.collection.interval",
			"60s",
		);
		expect(changed).toBe(true);
		expect(touchesSecurity).toBe(false);
		const parsed = JSON.parse(content) as {
			elasticsearch_config: { user_settings_yaml: string; plugins: unknown[] };
			kibana: { user_settings_yaml: string };
		};
		// the ES_SSO realm line survives inside the merged YAML; kibana block untouched
		expect(parsed.elasticsearch_config.user_settings_yaml).toContain("xpack.security.authc.realms.saml.kibana-realm");
		expect(parsed.elasticsearch_config.plugins).toEqual([]);
		expect(parsed.kibana.user_settings_yaml).toBe(KB_SSO);
		const merged = parse(parsed.elasticsearch_config.user_settings_yaml) as {
			xpack: { monitoring: { collection: { interval: string } } };
		};
		expect(merged.xpack.monitoring.collection.interval).toBe("60s");
	});

	test("throws when the target block is missing", () => {
		expect(() => mergeDeploymentUserSettingsKey(JSON.stringify({ name: "x" }), "kibana", "a.b", "c")).toThrow(
			"no kibana block",
		);
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

	// SIO-997: the surgical merge commits the file with ONLY the new key added; the existing SSO line
	// survives byte-for-byte, and a non-security key is safe to show in the diff.
	test("user_settings_yaml key merge commits; adds the key, preserves SSO, shows the value", async () => {
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
				userSettingsMergeTarget: "elasticsearch_config" as const,
				userSettingsMergeKey: "xpack.monitoring.collection.interval",
				userSettingsMergeValue: "60s",
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		// a non-security key IS shown in the diff (it is an operational setting, not a secret)
		expect(result.proposedDiff).toContain("xpack.monitoring.collection.interval");
		expect(result.proposedDiff).toContain("60s");
		const written = JSON.parse(String(committed.content)) as { elasticsearch_config: { user_settings_yaml: string } };
		const yaml = written.elasticsearch_config.user_settings_yaml;
		// the existing ES SSO realm line is preserved byte-for-byte
		expect(yaml).toContain("xpack.security.authc.realms.saml.kibana-realm");
		// the new key re-parses to the right value
		const reparsed = parse(yaml) as { xpack: { monitoring: { collection: { interval: string } } } };
		expect(reparsed.xpack.monitoring.collection.interval).toBe("60s");
	});

	// SIO-997: a merge INSIDE xpack.security withholds the value (could be a secret / lock-out).
	test("a merge into xpack.security withholds the value in the diff", async () => {
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
				userSettingsMergeTarget: "elasticsearch_config" as const,
				userSettingsMergeKey: "xpack.security.authc.realms.oidc.oidc1.rp.client_id",
				userSettingsMergeValue: "super-secret-client-id",
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		expect(result.proposedDiff).toContain("value withheld (xpack.security)");
		expect(result.proposedDiff).not.toContain("super-secret-client-id");
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

// SIO-999: surgical key REMOVAL from user_settings_yaml -- mirrors the SIO-997 merge suite. Drops the
// named dotted leaf (+ now-empty parents) while preserving every sibling subtree byte-for-byte.
describe("removeUserSettingsKeys (SIO-999)", () => {
	// The inert appended monitoring subtree alongside the real OIDC SSO realm (the eu-b2b repro).
	const WITH_MONITORING = [
		"xpack:",
		"  security:",
		"    authc:",
		"      realms:",
		"        oidc:",
		"          oidc-pvh-sso:",
		"            order: 2",
		'            rp.client_id: "86997c24-1ea8-4e05-af01-603fb3fe85bb"',
		"monitoring:",
		"  collection:",
		'    interval: "60s"',
		"",
	].join("\n");

	test("removes the leaf AND prunes empty parents, leaving the OIDC realm byte-for-byte", () => {
		const { yaml, removed, changed, touchesSecurity } = removeUserSettingsKeys(WITH_MONITORING, [
			"monitoring.collection.interval",
		]);
		expect(changed).toBe(true);
		expect(touchesSecurity).toBe(false);
		expect(removed).toEqual(["monitoring.collection.interval"]);
		// the whole inert monitoring subtree is gone (no `collection: {}` / `monitoring: {}` residue)
		expect(yaml).not.toContain("monitoring");
		// the OIDC security subtree survives verbatim, including indentation
		expect(yaml).toContain("        oidc:\n          oidc-pvh-sso:\n            order: 2");
		expect(yaml).toContain('            rp.client_id: "86997c24-1ea8-4e05-af01-603fb3fe85bb"');
	});

	test("removing the whole named subtree key drops it entirely", () => {
		const { yaml, removed, changed } = removeUserSettingsKeys(WITH_MONITORING, ["monitoring"]);
		expect(changed).toBe(true);
		expect(removed).toEqual(["monitoring"]);
		expect(yaml).not.toContain("monitoring");
		expect(yaml).toContain("oidc-pvh-sso");
	});

	test("absent key is a no-op: changed=false, removed empty, yaml unchanged", () => {
		const { yaml, removed, changed } = removeUserSettingsKeys(WITH_MONITORING, ["does.not.exist"]);
		expect(changed).toBe(false);
		expect(removed).toEqual([]);
		expect(yaml).toBe(WITH_MONITORING);
	});

	test("stops pruning at an ancestor that still holds a sibling", () => {
		const withSibling = ["monitoring:", "  collection:", '    interval: "60s"', "    enabled: true", ""].join("\n");
		const { yaml } = removeUserSettingsKeys(withSibling, ["monitoring.collection.interval"]);
		// collection survives (enabled remains); only interval is gone
		expect(yaml).not.toContain("interval");
		expect(yaml).toContain("enabled: true");
		expect(yaml).toContain("collection:");
	});

	test("flags touchesSecurity when a removed key lands inside xpack.security", () => {
		const res = removeUserSettingsKeys(WITH_MONITORING, ["xpack.security.authc.realms.oidc.oidc-pvh-sso.order"]);
		expect(res.touchesSecurity).toBe(true);
		expect(res.changed).toBe(true);
	});

	test("removes multiple keys in one pass", () => {
		const res = removeUserSettingsKeys(WITH_MONITORING, [
			"monitoring.collection.interval",
			"xpack.security.authc.realms.oidc.oidc-pvh-sso.rp.client_id",
		]);
		expect(res.removed.length).toBe(2);
		expect(res.touchesSecurity).toBe(true);
		expect(res.yaml).not.toContain("monitoring");
		expect(res.yaml).not.toContain("rp.client_id");
		// the surviving realm scaffolding is still there
		expect(res.yaml).toContain("oidc-pvh-sso");
	});
});

describe("removeDeploymentUserSettingsKeys (SIO-999)", () => {
	// A deployment whose elasticsearch_config user_settings_yaml carries SSO + the inert monitoring block.
	const ES_WITH_MON = `${ES_SSO}monitoring:\n  collection:\n    interval: "60s"\n`;
	const DEPLOYMENT_WITH_MON = JSON.stringify(
		{
			name: "eu-b2b",
			elasticsearch: { autoscale: false, hot: { size: "4g", zone_count: 2 } },
			elasticsearch_config: { plugins: [], user_settings_yaml: ES_WITH_MON },
			kibana: { size: "1g", user_settings_yaml: KB_SSO },
		},
		null,
		2,
	);

	test("removes the monitoring key from elasticsearch_config, preserving SSO + kibana block", () => {
		const { content, removed, changed, touchesSecurity } = removeDeploymentUserSettingsKeys(
			DEPLOYMENT_WITH_MON,
			"elasticsearch_config",
			["monitoring.collection.interval"],
		);
		expect(changed).toBe(true);
		expect(touchesSecurity).toBe(false);
		expect(removed).toEqual(["monitoring.collection.interval"]);
		const parsed = JSON.parse(content) as {
			elasticsearch_config: { user_settings_yaml: string; plugins: unknown[] };
			kibana: { user_settings_yaml: string };
		};
		// SSO realm survives, monitoring gone, kibana untouched, plugins untouched
		expect(parsed.elasticsearch_config.user_settings_yaml).toContain("xpack.security.authc.realms.saml.kibana-realm");
		expect(parsed.elasticsearch_config.user_settings_yaml).not.toContain("monitoring");
		expect(parsed.elasticsearch_config.plugins).toEqual([]);
		expect(parsed.kibana.user_settings_yaml).toBe(KB_SSO);
	});

	test("absent key is a no-op (changed=false)", () => {
		const { changed, removed } = removeDeploymentUserSettingsKeys(DEPLOYMENT_WITH_MON, "elasticsearch_config", [
			"nope.not.here",
		]);
		expect(changed).toBe(false);
		expect(removed).toEqual([]);
	});

	test("throws when the target block is missing", () => {
		expect(() => removeDeploymentUserSettingsKeys(JSON.stringify({ name: "x" }), "kibana", ["a.b"])).toThrow(
			"no kibana block",
		);
	});
});

describe("parseIntentJson — topology-edit removal (SIO-999)", () => {
	test("maps the user_settings_yaml removal fields", () => {
		const req = parseIntentJson(
			JSON.stringify({
				workflow: "topology-edit",
				cluster: "eu-b2b",
				userSettingsMergeTarget: "elasticsearch_config",
				userSettingsRemoveKeys: ["monitoring.collection.interval"],
			}),
		);
		expect(req?.workflow).toBe("topology-edit");
		expect(req?.userSettingsMergeTarget).toBe("elasticsearch_config");
		expect(req?.userSettingsRemoveKeys).toEqual(["monitoring.collection.interval"]);
		// no value supplied -- this is the removal path, not a merge
		expect(req?.userSettingsMergeValue).toBeUndefined();
	});
});

describe("draftChange -> proposeTopologyChange removal (SIO-999)", () => {
	const ES_WITH_MON = `${ES_SSO}monitoring:\n  collection:\n    interval: "60s"\n`;
	const DEPLOYMENT_WITH_MON = JSON.stringify(
		{
			name: "eu-b2b",
			region: "eu-central-1",
			version: "8.15.0",
			elasticsearch: { autoscale: false, hot: { size: "4g", max_size: "64g", zone_count: 2 } },
			elasticsearch_config: { plugins: [], user_settings_yaml: ES_WITH_MON },
			kibana: { size: "1g", zone_count: 1, user_settings_yaml: KB_SSO },
		},
		null,
		2,
	);
	const fileResult = `[200] ${JSON.stringify({ content: Buffer.from(DEPLOYMENT_WITH_MON).toString("base64"), encoding: "base64" })}`;

	test("removal commits; drops the key, preserves SSO, lists the removed key in the diff", async () => {
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
				userSettingsMergeTarget: "elasticsearch_config" as const,
				userSettingsRemoveKeys: ["monitoring.collection.interval"],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		// the diff names the removed operational key
		expect(result.proposedDiff).toContain("removed");
		expect(result.proposedDiff).toContain("monitoring.collection.interval");
		const written = JSON.parse(String(committed.content)) as { elasticsearch_config: { user_settings_yaml: string } };
		const yaml = written.elasticsearch_config.user_settings_yaml;
		expect(yaml).toContain("xpack.security.authc.realms.saml.kibana-realm");
		expect(yaml).not.toContain("monitoring");
	});

	test("removal under xpack.security WITHHOLDS the key name in the diff", async () => {
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
				userSettingsMergeTarget: "elasticsearch_config" as const,
				userSettingsRemoveKeys: ["xpack.security.authc.realms.saml.kibana-realm.order"],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		expect(result.proposedDiff).toContain("names withheld: xpack.security");
		expect(result.proposedDiff).not.toContain("kibana-realm.order");
	});

	test("removing an absent key is a no-op (no MR)", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({ gitlab_get_file_content: () => fileResult });
		const state = {
			iacRequest: {
				workflow: "topology-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				userSettingsMergeTarget: "elasticsearch_config" as const,
				userSettingsRemoveKeys: ["nope.not.here"],
			},
		};
		const result = await draftChange(asIacState(state));
		// no change -> no branch/commit; the empty-diff guard blocks the MR
		expect(result.branch).toBeUndefined();
	});
});

describe("reviewPlan — topology removal (SIO-999)", () => {
	test("operational removal: benign shared-state risk, names the removed key", async () => {
		const state = {
			iacRequest: {
				workflow: "topology-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				userSettingsMergeTarget: "elasticsearch_config" as const,
				userSettingsRemoveKeys: ["monitoring.collection.interval"],
			},
			branch: "b",
			proposedDiff: "(diff)",
			precheckPassed: true,
		};
		const result = await reviewPlan(asIacState(state));
		expect(result.risks?.some((r) => r.includes("removes") && r.includes("monitoring.collection.interval"))).toBe(true);
		expect(result.risks?.some((r) => r.includes("COULD LOCK OUT LOGIN"))).toBe(false);
	});

	test("security-key removal leads with COULD LOCK OUT LOGIN", async () => {
		const state = {
			iacRequest: {
				workflow: "topology-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				userSettingsMergeTarget: "elasticsearch_config" as const,
				userSettingsRemoveKeys: ["xpack.security.authc.realms.oidc.oidc1.order"],
			},
			branch: "b",
			proposedDiff: "(diff)",
			precheckPassed: true,
		};
		const result = await reviewPlan(asIacState(state));
		expect(result.risks?.[0]).toContain("COULD LOCK OUT LOGIN");
		expect(result.risks?.[0]).toContain("REMOVES a key INSIDE xpack.security");
	});
});

// SIO-999: readDeploymentUserSettings + the idempotent no-op confirmation (show the current YAML when
// a removal found nothing to remove, instead of a terse "no change").
describe("readDeploymentUserSettings (SIO-999)", () => {
	test("returns the target block's user_settings_yaml", () => {
		expect(readDeploymentUserSettings(DEPLOYMENT, "elasticsearch_config")).toBe(ES_SSO);
		expect(readDeploymentUserSettings(DEPLOYMENT, "kibana")).toBe(KB_SSO);
	});

	test("returns empty string when the block or field is absent", () => {
		expect(readDeploymentUserSettings(JSON.stringify({ name: "x" }), "elasticsearch_config")).toBe("");
		expect(readDeploymentUserSettings(JSON.stringify({ kibana: {} }), "kibana")).toBe("");
	});

	test("throws on non-object JSON", () => {
		expect(() => readDeploymentUserSettings("[]", "kibana")).toThrow("not an object");
	});
});

describe("draftChange -> proposeTopologyChange removal no-op (SIO-999)", () => {
	// A deployment whose user_settings_yaml has the OIDC SSO realm but NO monitoring subtree -- removing
	// monitoring is an idempotent no-op against the repo.
	const DEPLOYMENT_NO_MON = JSON.stringify(
		{
			name: "eu-b2b",
			elasticsearch: { autoscale: false, hot: { size: "4g", zone_count: 2 } },
			elasticsearch_config: { plugins: [], user_settings_yaml: ES_SSO },
			kibana: { size: "1g", user_settings_yaml: KB_SSO },
		},
		null,
		2,
	);
	const fileResult = `[200] ${JSON.stringify({ content: Buffer.from(DEPLOYMENT_NO_MON).toString("base64"), encoding: "base64" })}`;

	test("absent key: no MR, but the message shows the current YAML + confirms it is already absent", async () => {
		const { draftChange } = await import("./nodes.ts");
		let committed = false;
		mockTools({
			gitlab_get_file_content: () => fileResult,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => {
				committed = true;
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "topology-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				userSettingsMergeTarget: "elasticsearch_config" as const,
				userSettingsRemoveKeys: ["monitoring.collection.interval"],
			},
		};
		const result = await draftChange(asIacState(state));
		// no commit was attempted (idempotent no-op)
		expect(committed).toBe(false);
		const text = String(result.messages?.[0]?.content ?? "");
		expect(text).toContain("found no key matching");
		expect(text).toContain("monitoring.collection.interval");
		// the current YAML is shown (as a fenced code block) so the user can confirm
		expect(text).toContain("```yaml");
		expect(text).toContain("xpack.security.authc.realms.saml.kibana-realm");
		// honest about not checking live
		expect(text).toContain("did NOT check the live cluster");
	});

	test("absent key under xpack.security: WITHHOLDS the current YAML body", async () => {
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
				userSettingsMergeTarget: "elasticsearch_config" as const,
				userSettingsRemoveKeys: ["xpack.security.authc.realms.oidc.ghost.order"],
			},
		};
		const result = await draftChange(asIacState(state));
		const text = String(result.messages?.[0]?.content ?? "");
		expect(text).toContain("found no key matching");
		expect(text).toContain("withheld: the removal targeted xpack.security");
		// the real SSO body is NOT echoed
		expect(text).not.toContain("idp.metadata.path");
	});
});

// SIO-999: suffix-match resolution -- the real eu-b2b bug. The user types "monitoring.collection.interval"
// but the repo nests it under xpack (xpack.monitoring.collection.interval). A unique suffix match must
// resolve + remove it; >1 match is ambiguous (never guess); 0 is absent.
describe("removeUserSettingsKeys suffix-match (SIO-999)", () => {
	// The exact live eu-b2b shape: flat OIDC leaf keys + monitoring NESTED under xpack (not top-level).
	const REAL = [
		"xpack:",
		"  security:",
		"    authc:",
		"      realms:",
		"        oidc:",
		"          oidc-pvh-sso:",
		"            order: 2",
		'            rp.client_id: "abc"',
		'            claims.groups: "groups"',
		"  monitoring:",
		"    collection:",
		'      interval: "60s"',
		"",
	].join("\n");

	test("a top-level-looking key resolves to its nested xpack.* location and is removed", () => {
		const res = removeUserSettingsKeys(REAL, ["monitoring.collection.interval"]);
		expect(res.changed).toBe(true);
		// removed reports the FULL resolved path, not the user's shorthand
		expect(res.removed).toEqual(["xpack.monitoring.collection.interval"]);
		expect(res.absent).toEqual([]);
		expect(res.ambiguous).toEqual([]);
		// the whole inert monitoring subtree is pruned; the OIDC realm survives byte-for-byte
		expect(res.yaml).not.toContain("monitoring");
		expect(res.yaml).toContain("oidc-pvh-sso");
		expect(res.yaml).toContain('rp.client_id: "abc"');
	});

	test("the user can also remove the whole 'monitoring' subtree by its short name", () => {
		const res = removeUserSettingsKeys(REAL, ["monitoring"]);
		expect(res.changed).toBe(true);
		expect(res.removed).toEqual(["xpack.monitoring"]);
		expect(res.yaml).not.toContain("monitoring");
	});

	test("exact path still wins and is reported verbatim", () => {
		const res = removeUserSettingsKeys(REAL, ["xpack.monitoring.collection.interval"]);
		expect(res.removed).toEqual(["xpack.monitoring.collection.interval"]);
		expect(res.changed).toBe(true);
	});

	test("a suffix match landing inside xpack.security flags touchesSecurity", () => {
		const res = removeUserSettingsKeys(REAL, ["oidc-pvh-sso.rp.client_id"]);
		expect(res.changed).toBe(true);
		expect(res.removed).toEqual(["xpack.security.authc.realms.oidc.oidc-pvh-sso.rp.client_id"]);
		expect(res.touchesSecurity).toBe(true);
	});

	test("ambiguous key (matches >1 subtree) is NOT removed; candidates are reported", () => {
		const twoIntervals = [
			"a:",
			"  collection:",
			'    interval: "1s"',
			"b:",
			"  collection:",
			'    interval: "2s"',
			"",
		].join("\n");
		const res = removeUserSettingsKeys(twoIntervals, ["collection.interval"]);
		expect(res.changed).toBe(false);
		expect(res.removed).toEqual([]);
		expect(res.ambiguous.length).toBe(1);
		expect(res.ambiguous[0]?.candidates.sort()).toEqual(["a.collection.interval", "b.collection.interval"]);
	});

	test("genuinely absent key reports absent (no match anywhere)", () => {
		const res = removeUserSettingsKeys(REAL, ["nope.not.here"]);
		expect(res.changed).toBe(false);
		expect(res.absent).toEqual(["nope.not.here"]);
		expect(res.ambiguous).toEqual([]);
		expect(res.removed).toEqual([]);
	});
});

describe("draftChange -> proposeTopologyChange suffix-match + ambiguity (SIO-999)", () => {
	// eu-b2b-shaped: monitoring nested under xpack (the live repro).
	const ES_NESTED_MON = `xpack:\n  security:\n    authc:\n      realms:\n        oidc:\n          oidc-pvh-sso:\n            order: 2\n  monitoring:\n    collection:\n      interval: "60s"\n`;
	const DEPLOYMENT_NESTED = JSON.stringify(
		{
			name: "eu-b2b",
			elasticsearch: { autoscale: false, hot: { size: "4g", zone_count: 2 } },
			elasticsearch_config: { plugins: [], user_settings_yaml: ES_NESTED_MON },
			kibana: { size: "1g", user_settings_yaml: KB_SSO },
		},
		null,
		2,
	);
	const fileResult = `[200] ${JSON.stringify({ content: Buffer.from(DEPLOYMENT_NESTED).toString("base64"), encoding: "base64" })}`;

	test("shorthand 'monitoring.collection.interval' resolves to xpack.* and commits an MR", async () => {
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
				userSettingsMergeTarget: "elasticsearch_config" as const,
				userSettingsRemoveKeys: ["monitoring.collection.interval"],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		// the diff names the FULL resolved path
		expect(result.proposedDiff).toContain("xpack.monitoring.collection.interval");
		const written = JSON.parse(String(committed.content)) as { elasticsearch_config: { user_settings_yaml: string } };
		expect(written.elasticsearch_config.user_settings_yaml).not.toContain("monitoring");
		expect(written.elasticsearch_config.user_settings_yaml).toContain("oidc-pvh-sso");
	});

	test("ambiguous key blocks with the candidate list (no MR)", async () => {
		const ambJson = JSON.stringify(
			{
				name: "eu-b2b",
				elasticsearch_config: {
					user_settings_yaml: 'a:\n  collection:\n    interval: "1s"\nb:\n  collection:\n    interval: "2s"\n',
				},
			},
			null,
			2,
		);
		const ambFile = `[200] ${JSON.stringify({ content: Buffer.from(ambJson).toString("base64"), encoding: "base64" })}`;
		const { draftChange } = await import("./nodes.ts");
		let committed = false;
		mockTools({
			gitlab_get_file_content: () => ambFile,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => {
				committed = true;
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "topology-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				userSettingsMergeTarget: "elasticsearch_config" as const,
				userSettingsRemoveKeys: ["collection.interval"],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(committed).toBe(false);
		const text = String(result.messages?.[0]?.content ?? "");
		expect(text).toContain("match more than one place");
		expect(text).toContain("a.collection.interval");
		expect(text).toContain("b.collection.interval");
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
