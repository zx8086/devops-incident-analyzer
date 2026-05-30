// src/tools/guardduty/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { withEstate } from "../estate-schema.ts";
import { toMcp } from "../wrap.ts";
import { type GetDetectorParams, getDetector, getDetectorSchema } from "./get-detector.ts";
import { type GetFindingsParams, getFindings, getFindingsSchema } from "./get-findings.ts";
import { type ListDetectorsParams, listDetectors, listDetectorsSchema } from "./list-detectors.ts";
import { type ListFindingsParams, listFindings, listFindingsSchema } from "./list-findings.ts";

export function registerGuardDutyTools(server: McpServer, config: AwsConfig): void {
	const detectors = listDetectors(config);
	server.tool(
		"aws_guardduty_list_detectors",
		"List GuardDuty detector IDs. CALL THIS FIRST: every other GuardDuty tool requires a DetectorId. A region has at most one detector.",
		withEstate(config, listDetectorsSchema.shape),
		async (params) => toMcp(await detectors(params as ListDetectorsParams)),
	);

	const detector = getDetector(config);
	server.tool(
		"aws_guardduty_get_detector",
		"Get a detector's status (enabled?), finding-publishing frequency, and enabled data sources/features. Use to confirm GuardDuty is active in this estate.",
		withEstate(config, getDetectorSchema.shape),
		async (params) => toMcp(await detector(params as GetDetectorParams)),
	);

	const findingIds = listFindings(config);
	server.tool(
		"aws_guardduty_list_findings",
		"List GuardDuty finding IDs for a detector, optionally filtered by minSeverity. Returns IDs only -- pass them to aws_guardduty_get_findings to hydrate.",
		withEstate(config, listFindingsSchema.shape),
		async (params) => toMcp(await findingIds(params as ListFindingsParams)),
	);

	const findings = getFindings(config);
	server.tool(
		"aws_guardduty_get_findings",
		"Hydrate GuardDuty finding IDs (from aws_guardduty_list_findings) into full detail: type, severity, resource, actor. REQUIRES FindingIds -- never guess them.",
		withEstate(config, getFindingsSchema.shape),
		async (params) => toMcp(await findings(params as GetFindingsParams)),
	);
}
