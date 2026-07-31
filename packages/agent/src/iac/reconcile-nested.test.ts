// agent/src/iac/reconcile-nested.test.ts
// SIO-1315: nested-layout reconcile-to-live (security / fleet-integrations / agent-policies).
// Fixtures mirror the REAL eu-b2b repo layouts fetched live 2026-07-31.
import { describe, expect, mock, test } from "bun:test";
import type { StackDrift, StackDriftResource } from "./state.ts";

function mockTools(handlers: Record<string, (args: Record<string, unknown>) => string>): { calls: string[] } {
	const sink = { calls: [] as string[] };
	const tools = Object.entries(handlers).map(([name, fn]) => ({
		name,
		invoke: async (args: Record<string, unknown>) => {
			sink.calls.push(name);
			return fn(args);
		},
	}));
	mock.module("../mcp-bridge.ts", () => ({
		getToolsForDataSource: () => tools,
		getConnectedServers: () => ["elastic-iac-mcp"],
	}));
	return sink;
}

const b64 = (s: string) =>
	`[200] ${JSON.stringify({ content: Buffer.from(s).toString("base64"), encoding: "base64" })}`;

function drift(stack: string, resources: StackDriftResource[]): StackDrift {
	return {
		stack,
		drifted: true,
		kind: "config-json",
		create: 0,
		update: resources.length,
		delete: 0,
		liveReconcilable: true,
		resources,
	};
}

// Real eu-b2b security.json shape: roles map + sibling role_mappings/api_keys containers.
const SECURITY_JSON = `${JSON.stringify(
	{
		roles: {
			"SLO All": {
				cluster: [],
				indices: [{ names: ["*"], privileges: ["read"] }],
				applications: [],
				metadata_version: 1,
			},
			developer: { cluster: ["monitor"], indices: [], applications: [], metadata_version: 1 },
		},
		role_mappings: { developer: { enabled: true } },
		api_keys: {},
	},
	null,
	2,
)}\n`;

// Real eu-b2b integrations.json shape: TOP-LEVEL map keyed by integration alias.
const INTEGRATIONS_JSON = `${JSON.stringify(
	{
		"cloud-security-posture": { name: "cloud_security_posture", version: "3.4.0", force: false },
		"elastic-defend": { name: "endpoint", version: "9.4.0", force: false },
	},
	null,
	2,
)}\n`;

// Real eu-b2b agent-policies per-policy file shape: integrations nest INSIDE the policy file.
const POLICY_JSON = `${JSON.stringify(
	{
		name: "eu-mendix-platform.dev - SM",
		namespace: "default",
		integrations: {
			system: { integration_version: "2.17.0" },
			cloud_security_posture: { integration_version: "3.4.0", vars: { posture: "kspm" } },
		},
	},
	null,
	2,
)}\n`;

const TREE_AGENT_POLICIES = `[200] ${JSON.stringify([
	{ name: "eu-mendix-platform-dev.json", type: "blob" },
	{ name: "eu-mendix-platform-prd.json", type: "blob" },
	{ name: "eu-mendix.json", type: "blob" },
	{ name: "terraform.tfvars", type: "blob" },
	{ name: "_pending-regen-from-live", type: "tree" },
])}`;

describe("nested family classification (SIO-1315)", () => {
	test("security / fleet-integrations / agent-policies are config-json + liveReconcilable", async () => {
		mockTools({});
		const { classifyStackByName, configStackFamily } = await import("./nodes.ts");
		for (const stack of ["security", "fleet-integrations", "agent-policies"]) {
			expect(configStackFamily(stack)).toBe(stack);
			const c = classifyStackByName(stack, "eu-b2b");
			expect(c.kind).toBe("config-json");
			expect(c.liveReconcilable).toBe(true);
		}
		expect(classifyStackByName("security", "eu-b2b").configPath).toBe("environments/eu-b2b/security/security.json");
		expect(classifyStackByName("fleet-integrations", "eu-b2b").configPath).toBe(
			"environments/eu-b2b/fleet-integrations/integrations.json",
		);
		expect(classifyStackByName("agent-policies", "eu-b2b").configPath).toBe("environments/eu-b2b/agent-policies");
	});
});

describe("buildLiveReconcile — security aggregate (SIO-1315)", () => {
	test("projects live role values into roles.<key> and preserves siblings", async () => {
		mockTools({ gitlab_get_file_content: () => b64(SECURITY_JSON) });
		const { buildLiveReconcile } = await import("./nodes.ts");
		const built = await buildLiveReconcile(
			"eu-b2b",
			drift("security", [
				{
					address: 'module.security.elasticstack_elasticsearch_security_role.this["SLO All"]',
					actions: ["update"],
					category: "update",
					changedKeys: ["indices"],
					values: {
						indices: {
							before: [{ names: ["*"], privileges: ["read"], field_security: { except: [], grant: ["*"] } }],
							after: [{ names: ["*"], privileges: ["read"] }],
						},
					},
				},
			]),
		);
		if ("blocked" in built) throw new Error(`unexpected block: ${built.blocked}`);
		expect(built.files).toHaveLength(1);
		expect(built.files[0]?.path).toBe("environments/eu-b2b/security/security.json");
		const doc = JSON.parse(built.files[0]?.content ?? "{}");
		expect(doc.roles["SLO All"].indices[0].field_security).toEqual({ except: [], grant: ["*"] });
		// Sibling role + containers preserved byte-for-byte in structure.
		expect(doc.roles.developer).toEqual({ cluster: ["monitor"], indices: [], applications: [], metadata_version: 1 });
		expect(doc.role_mappings).toEqual({ developer: { enabled: true } });
		expect(doc.api_keys).toEqual({});
		expect(built.summary).toContain("SLO All: indices");
	});

	test("unstable numeric-index leaf paths fall back to attribute-grain values", async () => {
		mockTools({ gitlab_get_file_content: () => b64(SECURITY_JSON) });
		const { buildLiveReconcile } = await import("./nodes.ts");
		const built = await buildLiveReconcile(
			"eu-b2b",
			drift("security", [
				{
					address: 'module.security.elasticstack_elasticsearch_security_role.this["SLO All"]',
					actions: ["update"],
					category: "update",
					changedKeys: ["indices"],
					changes: [{ path: "indices[0].field_security", op: "update", before: { grant: ["*"] }, unstableIndex: true }],
					values: { indices: { before: [{ names: ["*"], privileges: ["read"], field_security: { grant: ["*"] } }] } },
				},
			]),
		);
		if ("blocked" in built) throw new Error(`unexpected block: ${built.blocked}`);
		const doc = JSON.parse(built.files[0]?.content ?? "{}");
		expect(doc.roles["SLO All"].indices[0].field_security).toEqual({ grant: ["*"] });
	});

	test("unknown role key skips with a note and blocks when nothing else applied", async () => {
		mockTools({ gitlab_get_file_content: () => b64(SECURITY_JSON) });
		const { buildLiveReconcile } = await import("./nodes.ts");
		const built = await buildLiveReconcile(
			"eu-b2b",
			drift("security", [
				{
					address: 'module.security.elasticstack_elasticsearch_security_role.this["ghost-role"]',
					actions: ["update"],
					category: "update",
					values: { cluster: { before: ["all"] } },
				},
			]),
		);
		if (!("blocked" in built)) throw new Error("expected block");
		expect(built.blocked).toContain("No reconcilable live values");
		expect(built.blocked).toContain("ghost-role (no entry in environments/eu-b2b/security/security.json)");
	});

	test("unreadable aggregate file blocks with the SIO-901 message", async () => {
		mockTools({ gitlab_get_file_content: () => "[404] not found" });
		const { buildLiveReconcile } = await import("./nodes.ts");
		const built = await buildLiveReconcile(
			"eu-b2b",
			drift("security", [
				{
					address: 'module.security.elasticstack_elasticsearch_security_role.this["SLO All"]',
					actions: ["update"],
					category: "update",
					values: { cluster: { before: ["all"] } },
				},
			]),
		);
		if (!("blocked" in built)) throw new Error("expected block");
		expect(built.blocked).toContain("Could not read any config file for this stack");
	});
});

describe("buildLiveReconcile — fleet-integrations aggregate, top-level map (SIO-1315)", () => {
	test("bumps the drifted integration's version in place", async () => {
		mockTools({ gitlab_get_file_content: () => b64(INTEGRATIONS_JSON) });
		const { buildLiveReconcile } = await import("./nodes.ts");
		const built = await buildLiveReconcile(
			"eu-b2b",
			drift("fleet-integrations", [
				{
					address: 'module.fleet_integrations.elasticstack_fleet_integration.this["cloud-security-posture"]',
					actions: ["update"],
					category: "update",
					changedKeys: ["version"],
					changes: [{ path: "version", op: "update", before: "3.5.0", after: "3.4.0" }],
				},
				{
					address: 'module.fleet_integrations.elasticstack_fleet_integration.this["elastic-defend"]',
					actions: ["replace"],
					category: "replace",
					changedKeys: ["version"],
					values: { version: { before: "9.4.1", after: "9.4.0" } },
				},
			]),
		);
		if ("blocked" in built) throw new Error(`unexpected block: ${built.blocked}`);
		expect(built.files).toHaveLength(1);
		const doc = JSON.parse(built.files[0]?.content ?? "{}");
		expect(doc["cloud-security-posture"].version).toBe("3.5.0");
		expect(doc["cloud-security-posture"].name).toBe("cloud_security_posture");
		expect(doc["elastic-defend"].version).toBe("9.4.1");
		expect(built.summary).toContain("cloud-security-posture: version");
		expect(built.summary).toContain("elastic-defend: version");
	});
});

describe("buildLiveReconcile — agent-policies composite keys (SIO-1315)", () => {
	test("longest-prefix matches the policy file and writes the nested integration", async () => {
		const sink = mockTools({
			gitlab_get_repository_tree: () => TREE_AGENT_POLICIES,
			gitlab_get_file_content: () => b64(POLICY_JSON),
		});
		const { buildLiveReconcile } = await import("./nodes.ts");
		const built = await buildLiveReconcile(
			"eu-b2b",
			drift("agent-policies", [
				{
					address:
						'module.agent_policies.elasticstack_fleet_integration_policy.this["eu-mendix-platform-dev-cloud_security_posture"]',
					actions: ["update"],
					category: "update",
					changedKeys: ["integration_version"],
					values: { integration_version: { before: "3.5.0", after: "3.4.0" } },
				},
			]),
		);
		if ("blocked" in built) throw new Error(`unexpected block: ${built.blocked}`);
		expect(built.files).toHaveLength(1);
		expect(built.files[0]?.path).toBe("environments/eu-b2b/agent-policies/eu-mendix-platform-dev.json");
		const doc = JSON.parse(built.files[0]?.content ?? "{}");
		expect(doc.integrations.cloud_security_posture.integration_version).toBe("3.5.0");
		// Sibling integration + policy metadata preserved.
		expect(doc.integrations.cloud_security_posture.vars).toEqual({ posture: "kspm" });
		expect(doc.integrations.system).toEqual({ integration_version: "2.17.0" });
		expect(doc.name).toBe("eu-mendix-platform.dev - SM");
		expect(sink.calls).toContain("gitlab_get_repository_tree");
	});

	test("a key with no matching parent file skips with a note and blocks when nothing applied", async () => {
		mockTools({
			gitlab_get_repository_tree: () => TREE_AGENT_POLICIES,
			gitlab_get_file_content: () => b64(POLICY_JSON),
		});
		const { buildLiveReconcile } = await import("./nodes.ts");
		const built = await buildLiveReconcile(
			"eu-b2b",
			drift("agent-policies", [
				{
					address: 'module.agent_policies.elasticstack_fleet_integration_policy.this["unknown-policy-x-system"]',
					actions: ["update"],
					category: "update",
					values: { integration_version: { before: "1.0.0" } },
				},
			]),
		);
		if (!("blocked" in built)) throw new Error("expected block");
		expect(built.blocked).toContain("no matching parent file under environments/eu-b2b/agent-policies");
	});
});

describe("nested family exclusion (SIO-1315)", () => {
	test("ELASTIC_IAC_NESTED_STACKS_EXCLUDE falls back to the per-key report family", async () => {
		const prev = process.env.ELASTIC_IAC_NESTED_STACKS_EXCLUDE;
		process.env.ELASTIC_IAC_NESTED_STACKS_EXCLUDE = "security";
		try {
			mockTools({ gitlab_get_file_content: () => "[404] not found" });
			const { buildLiveReconcile, classifyStackByName } = await import("./nodes.ts");
			// Still config-json (the report family is the default for every stack)...
			expect(classifyStackByName("security", "eu-b2b").configPath).toBe("environments/eu-b2b/security");
			// ...and the per-key template hunts SLO All.json again (pre-SIO-1315 behavior).
			const built = await buildLiveReconcile(
				"eu-b2b",
				drift("security", [
					{
						address: 'module.security.elasticstack_elasticsearch_security_role.this["SLO All"]',
						actions: ["update"],
						category: "update",
						values: { cluster: { before: ["all"] } },
					},
				]),
			);
			if (!("blocked" in built)) throw new Error("expected block");
			expect(built.blocked).toContain("Could not read any config file for this stack");
			expect(built.blocked).toContain("environments/eu-b2b/security/SLO All.json");
		} finally {
			if (prev === undefined) delete process.env.ELASTIC_IAC_NESTED_STACKS_EXCLUDE;
			else process.env.ELASTIC_IAC_NESTED_STACKS_EXCLUDE = prev;
		}
	});
});
