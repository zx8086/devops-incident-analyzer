// agent/src/iac/response-classification.test.ts
// SIO-921: every config-edit proposer must classify GitLab callTool results. A read that is
// neither 2xx nor 404 (token/timeout/5xx/error placeholder) must BLOCK rather than be treated as
// "file exists", and a non-2xx commit must BLOCK rather than reach the review gate as committed.
// Parametrized across all 11 proposers; the happy-path fixtures come from each workflow's own test.
import { describe, expect, mock, test } from "bun:test";
import { isGitlabNotFound, isGitlabSuccess } from "./nodes.ts";
import type { IacRequest, IacStateType } from "./state.ts";

const asIacState = (partial: Partial<IacStateType>): IacStateType => partial as unknown as IacStateType;

const b64 = (json: string): string =>
	`[200] ${JSON.stringify({ content: Buffer.from(json).toString("base64"), encoding: "base64" })}`;

// callTool error placeholders (none start with "[2"/"[4"/"[5"): the false-positive the old idiom
// `!commit.startsWith("[4") && !commit.startsWith("[5")` treated as success.
const TOOL_ERROR = "[gitlab_commit_file error: ETIMEDOUT]";
const READ_ERROR = "[gitlab_get_file_content error: ECONNRESET]";
const SERVER_ERROR = '[500] {"message":"Internal Server Error"}';

interface Case {
	workflow: string;
	req: IacRequest;
	file: string; // resolved repo path the proposer reads/commits
	content: string; // valid file body (base64-wrapped [200] envelope)
}

const CASES: Case[] = [
	{
		workflow: "version-upgrade",
		req: { workflow: "version-upgrade", isProd: false, cluster: "eu-b2b", version: "9.4.2" },
		file: "environments/_deployments/eu-b2b.json",
		content: b64('{"name":"eu-b2b","version":"9.4.1"}'),
	},
	{
		workflow: "tier-resize",
		req: { workflow: "tier-resize", isProd: false, cluster: "eu-b2b", tier: "warm", newSizeGb: 4, newMaxGb: 8 },
		file: "environments/_deployments/eu-b2b.json",
		content: b64('{"name":"eu-b2b","elasticsearch":{"warm":{"size":"8g","max_size":"15g","zone_count":2}}}'),
	},
	{
		workflow: "ilm-rollout",
		req: {
			workflow: "ilm-rollout",
			isProd: false,
			cluster: "eu-b2b",
			policyName: "30-days@lifecycle",
			phasesPatch: { delete: { min_age: "60d" } },
		},
		file: "environments/eu-b2b/lifecycle-policies/30-days@lifecycle.json",
		content: b64('{"name":"30-days@lifecycle","delete":{"min_age":"30d"}}'),
	},
	{
		workflow: "fleet-integration",
		req: {
			workflow: "fleet-integration",
			isProd: false,
			cluster: "eu-b2b",
			integration: "aws",
			integrationVersion: "6.15.0",
		},
		file: "environments/eu-b2b/fleet-integrations/integrations.json",
		content: b64('{"aws":{"name":"aws","version":"6.14.2","force":false}}'),
	},
	{
		workflow: "slo-edit",
		req: { workflow: "slo-edit", isProd: false, cluster: "eu-b2b", sloName: "ds-authentication", sloTarget: 99.5 },
		file: "environments/eu-b2b/slos/ds-authentication.json",
		content: b64(
			'{"name":"SLO for DS","space_id":"developer-experience","tags":[],"indicator":{"type":"synthetics_availability"}}',
		),
	},
	{
		workflow: "alerting-edit",
		req: {
			workflow: "alerting-edit",
			isProd: false,
			cluster: "eu-b2b",
			ruleName: "default__martech_add_to_wallet_transactions_failed_status_prd",
			alertThreshold: 5,
		},
		file: "environments/eu-b2b/alerting/default__martech_add_to_wallet_transactions_failed_status_prd.json",
		content: b64(
			'{"name":"MarTech","rule_type_id":"apm.transaction_error_rate","enabled":true,"interval":"5m","space_id":"default","params":{"threshold":1},"actions":[]}',
		),
	},
	{
		workflow: "dataview-edit",
		req: {
			workflow: "dataview-edit",
			isProd: false,
			cluster: "eu-b2b",
			dataviewName: "logs",
			runtimeFieldName: "host",
			runtimeFieldType: "keyword",
			runtimeFieldScript: "emit('h')",
		},
		file: "environments/eu-b2b/dataviews/logs.json",
		content: b64('{"id":"dv-1","title":"logs-*","name":"Logs","time_field_name":"@timestamp","runtime_field_map":{}}'),
	},
	{
		workflow: "cluster-default-edit",
		req: {
			workflow: "cluster-default-edit",
			isProd: false,
			cluster: "eu-b2b",
			templateName: "logs",
			totalShardsPerNode: 3,
		},
		file: "environments/eu-b2b/cluster-defaults/logs.json",
		content: b64('{"name":"logs@custom","settings":{"index":{"routing":{"allocation":{"total_shards_per_node":2}}}}}'),
	},
	{
		workflow: "space-edit",
		req: {
			workflow: "space-edit",
			isProd: false,
			cluster: "eu-b2b",
			spaceName: "developer-experience",
			spaceDescription: "new",
		},
		file: "environments/eu-b2b/spaces/developer-experience.json",
		content: b64('{"name":"Developer eXperience","description":"old desc","color":"#9170B8","disabled_features":[]}'),
	},
	{
		workflow: "security-edit",
		req: {
			workflow: "security-edit",
			isProd: false,
			cluster: "eu-b2b",
			roleName: "developer",
			grantIndexNames: ["logs-*"],
			grantIndexPrivileges: ["read"],
		},
		file: "environments/eu-b2b/security/security.json",
		content: b64(
			'{"roles":{"developer":{"name":"developer","cluster":[],"indices":[],"applications":[]}},"role_mappings":{},"api_keys":{}}',
		),
	},
	{
		workflow: "topology-edit",
		req: {
			workflow: "topology-edit",
			isProd: false,
			cluster: "eu-b2b",
			autoscaleEnabled: true,
			topologyTier: "hot",
			tierZoneCount: 3,
		},
		file: "environments/_deployments/eu-b2b.json",
		content: b64(
			'{"name":"eu-b2b","version":"8.15.0","elasticsearch":{"autoscale":false,"hot":{"size":"4g","max_size":"64g","zone_count":2},"warm":{"size":"2g","max_size":"32g","zone_count":1}}}',
		),
	},
];

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

describe("isGitlabSuccess / isGitlabNotFound", () => {
	test("2xx is success; 4xx/5xx and error placeholders are not", () => {
		expect(isGitlabSuccess("[200] {}")).toBe(true);
		expect(isGitlabSuccess("[201] {}")).toBe(true);
		expect(isGitlabSuccess("[404] {}")).toBe(false);
		expect(isGitlabSuccess("[500] {}")).toBe(false);
		expect(isGitlabSuccess("[gitlab_commit_file error: x]")).toBe(false);
		expect(isGitlabSuccess("[gitlab token not configured]")).toBe(false);
	});
	test("404 is not-found; 2xx and placeholders are not", () => {
		expect(isGitlabNotFound("[404] {}")).toBe(true);
		expect(isGitlabNotFound("[200] {}")).toBe(false);
		expect(isGitlabNotFound("[gitlab_get_file_content error: x]")).toBe(false);
	});
});

describe("proposer GitLab response classification (SIO-921)", () => {
	for (const c of CASES) {
		test(`${c.workflow}: a failed commit blocks (not surfaced as committed)`, async () => {
			const { draftChange } = await import("./nodes.ts");
			mockTools({
				gitlab_get_file_content: () => c.content,
				gitlab_create_branch: () => "[201] {}",
				gitlab_commit_file: () => TOOL_ERROR,
			});
			const result = await draftChange(asIacState({ iacRequest: c.req }));
			expect(result.precheckPassed).toBeUndefined();
			expect(result.blockedReason).toContain("Could not commit");
		});

		test(`${c.workflow}: a tool-error read blocks (not treated as file-exists/parse-fail)`, async () => {
			const { draftChange } = await import("./nodes.ts");
			mockTools({
				gitlab_get_file_content: () => READ_ERROR,
				gitlab_create_branch: () => "[201] {}",
				gitlab_commit_file: () => "[201] {}",
			});
			const result = await draftChange(asIacState({ iacRequest: c.req }));
			expect(result.precheckPassed).toBeUndefined();
			expect(result.blockedReason).toContain("Could not read");
		});

		test(`${c.workflow}: a 5xx read blocks`, async () => {
			const { draftChange } = await import("./nodes.ts");
			mockTools({
				gitlab_get_file_content: () => SERVER_ERROR,
				gitlab_create_branch: () => "[201] {}",
				gitlab_commit_file: () => "[201] {}",
			});
			const result = await draftChange(asIacState({ iacRequest: c.req }));
			expect(result.precheckPassed).toBeUndefined();
			expect(result.blockedReason).toContain("Could not read");
		});
	}
});
