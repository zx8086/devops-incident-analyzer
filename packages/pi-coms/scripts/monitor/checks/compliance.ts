// scripts/monitor/checks/compliance.ts
import {
	DescribeComplianceByConfigRuleCommand,
	type DescribeComplianceByConfigRuleCommandOutput,
	GetComplianceDetailsByConfigRuleCommand,
	type GetComplianceDetailsByConfigRuleCommandOutput,
} from "@aws-sdk/client-config-service";
import { errorMessage } from "../errors.ts";
import type { Finding } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";
import { diffSnapshot } from "./resource-drift.ts";

// SIO-1740: a Config rule flipping a resource to NON_COMPLIANT was only visible
// as the burst of Lambda invocations the Control Tower forwarder made for it.
// The compliance reads have been granted since SIO-1674; this reads them. The
// snapshot is the set of (rule, resource) pairs currently NON_COMPLIANT: a new
// pair is the finding, a standing one stays silent, a vanished one is info.
const SNAPSHOT = "config-compliance";
const WARN_CAP = 20;
const ERROR_REALERT_MS = 86_400_000;
const SEP = "|";

export type CheckComplianceOpts = { now?: number; warnCap?: number };

export async function checkCompliance(
	client: AwsClient,
	state: MonitorState,
	opts: CheckComplianceOpts = {},
): Promise<Finding[]> {
	const now = opts.now ?? Date.now();
	const warnCap = opts.warnCap ?? WARN_CAP;
	const at = new Date(now).toISOString();
	const findings: Finding[] = [];

	const rules: string[] = [];
	let nextToken: string | undefined;
	do {
		const resp = (await client.send(
			new DescribeComplianceByConfigRuleCommand({ ComplianceTypes: ["NON_COMPLIANT"], NextToken: nextToken }),
		)) as DescribeComplianceByConfigRuleCommandOutput;
		for (const r of resp.ComplianceByConfigRules ?? []) {
			if (r.ConfigRuleName && r.Compliance?.ComplianceType === "NON_COMPLIANT") rules.push(r.ConfigRuleName);
		}
		nextToken = resp.NextToken;
	} while (nextToken);

	const prev = state.getSnapshot(SNAPSHOT) ?? {};
	const current: Record<string, string> = {};
	for (const rule of rules) {
		try {
			let token: string | undefined;
			do {
				const resp = (await client.send(
					new GetComplianceDetailsByConfigRuleCommand({
						ConfigRuleName: rule,
						ComplianceTypes: ["NON_COMPLIANT"],
						Limit: 100,
						NextToken: token,
					}),
				)) as GetComplianceDetailsByConfigRuleCommandOutput;
				for (const e of resp.EvaluationResults ?? []) {
					const q = e.EvaluationResultIdentifier?.EvaluationResultQualifier;
					const id = q?.ResourceId;
					if (!id) continue;
					// The value is constant per pair on purpose: re-evaluations
					// change the recorded time, and that must not read as drift.
					current[[rule, q?.ResourceType ?? "unknown", id].join(SEP)] = "non_compliant";
				}
				token = resp.NextToken;
			} while (token);
		} catch (e) {
			// One unreadable rule keeps its previous pairs (so they do not read as
			// resolved) and says so once a day; the other rules still diff.
			for (const [k, v] of Object.entries(prev)) if (k.startsWith(`${rule}${SEP}`)) current[k] = v;
			const key = `compliance:error:${rule}`;
			if (state.shouldAlert(key, ERROR_REALERT_MS)) {
				state.markAlerted(key, "compliance");
				findings.push({
					family: "compliance",
					severity: "info",
					resource: rule,
					summary: `Config rule ${rule} details not readable: ${errorMessage(e)}`,
					dedup_key: key,
					evidence: { error: errorMessage(e) },
					at,
				});
			}
		}
	}

	const split = (k: string): { rule: string; type: string; id: string } => {
		const [rule, type, ...rest] = k.split(SEP);
		return { rule: rule ?? "", type: type ?? "", id: rest.join(SEP) };
	};
	const diffed = diffSnapshot(state, current, {
		snapshot: SNAPSHOT,
		added: (k) => {
			const { rule, type, id } = split(k);
			return {
				family: "compliance",
				severity: "warn",
				resource: `${type}/${id}`,
				summary: `Config rule ${rule} NON_COMPLIANT for ${type} ${id}`,
				dedup_key: `compliance:${rule}:${id}`,
				evidence: { rule, resourceType: type, resourceId: id },
				at,
			};
		},
		removed: (k) => {
			const { rule, type, id } = split(k);
			return {
				family: "compliance",
				severity: "info",
				resource: `${type}/${id}`,
				summary: `Config rule ${rule} back in compliance for ${type} ${id}`,
				dedup_key: `compliance:${rule}:${id}:resolved:${at}`,
				evidence: { rule, resourceType: type, resourceId: id },
				at,
			};
		},
		// Values never change (see above), so this branch cannot fire.
		changed: (k) => {
			const { rule, type, id } = split(k);
			return {
				family: "compliance",
				severity: "info",
				resource: `${type}/${id}`,
				summary: `Config rule ${rule} re-evaluated ${type} ${id}`,
				dedup_key: `compliance:${rule}:${id}:changed`,
				evidence: {},
				at,
			};
		},
	});
	// A rule rolled out across an estate flips hundreds of resources at once;
	// the report names the first few and counts the rest, the journal keeps the
	// snapshot so nothing is lost.
	const warns = diffed.filter((f) => f.severity === "warn");
	const rest = diffed.filter((f) => f.severity !== "warn");
	findings.push(...warns.slice(0, warnCap), ...rest);
	if (warns.length > warnCap) {
		findings.push({
			family: "compliance",
			severity: "info",
			resource: "config",
			summary: `${warns.length - warnCap} more resource(s) newly NON_COMPLIANT this run (cap ${warnCap})`,
			dedup_key: `compliance:overflow:${at}`,
			evidence: { total: warns.length, shown: warnCap },
			at,
		});
	}
	return findings;
}
