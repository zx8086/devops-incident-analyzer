// src/tools/securityhub/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { AWS_READ_ONLY_ANNOTATIONS } from "../annotations.ts";
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
	server.registerTool(
		"aws_securityhub_get_findings",
		{
			description:
				"Get Security Hub findings, optionally filtered by severity (CRITICAL/HIGH/etc.) and record state. Returns a _summary projection (id, severity, title) when truncated so severity coverage stays complete.",
			inputSchema: withEstate(config, getFindingsSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await findings(params as GetFindingsParams)),
	);

	const hub = describeHub(config);
	server.registerTool(
		"aws_securityhub_describe_hub",
		{
			description:
				"Describe the Security Hub account configuration (enablement, auto-enable controls, finding generator). Use to confirm Security Hub is on in this estate.",
			inputSchema: withEstate(config, describeHubSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await hub(params as DescribeHubParams)),
	);

	const standards = getEnabledStandards(config);
	server.registerTool(
		"aws_securityhub_get_enabled_standards",
		{
			description:
				"List the security standards enabled in this account (e.g. CIS, AWS Foundational, PCI DSS). Use to characterize a governance/baseline account's compliance posture.",
			inputSchema: withEstate(config, getEnabledStandardsSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await standards(params as GetEnabledStandardsParams)),
	);
}
