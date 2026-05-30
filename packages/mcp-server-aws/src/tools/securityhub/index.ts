// src/tools/securityhub/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { withEstate } from "../estate-schema.ts";
import { toMcp } from "../wrap.ts";
import { type DescribeHubParams, describeHub, describeHubSchema } from "./describe-hub.ts";
import {
	type GetEnabledStandardsParams,
	getEnabledStandards,
	getEnabledStandardsSchema,
} from "./get-enabled-standards.ts";
import { type GetFindingsParams, getFindings, getFindingsSchema } from "./get-findings.ts";

export function registerSecurityHubTools(server: McpServer, config: AwsConfig): void {
	const findings = getFindings(config);
	server.tool(
		"aws_securityhub_get_findings",
		"Get Security Hub findings, optionally filtered by severity (CRITICAL/HIGH/etc.) and record state. Returns a _summary projection (id, severity, title) when truncated so severity coverage stays complete.",
		withEstate(config, getFindingsSchema.shape),
		async (params) => toMcp(await findings(params as GetFindingsParams)),
	);

	const hub = describeHub(config);
	server.tool(
		"aws_securityhub_describe_hub",
		"Describe the Security Hub account configuration (enablement, auto-enable controls, finding generator). Use to confirm Security Hub is on in this estate.",
		withEstate(config, describeHubSchema.shape),
		async (params) => toMcp(await hub(params as DescribeHubParams)),
	);

	const standards = getEnabledStandards(config);
	server.tool(
		"aws_securityhub_get_enabled_standards",
		"List the security standards enabled in this account (e.g. CIS, AWS Foundational, PCI DSS). Use to characterize a governance/baseline account's compliance posture.",
		withEstate(config, getEnabledStandardsSchema.shape),
		async (params) => toMcp(await standards(params as GetEnabledStandardsParams)),
	);
}
