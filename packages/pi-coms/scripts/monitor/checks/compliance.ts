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
// A rule whose details could never be read has no baseline yet. The sentinel
// keeps that fact in the snapshot so the first successful read establishes the
// baseline silently instead of reporting every standing violation as new. The
// SEEN marker records that a rule HAS been read completely once, separately
// from its current pairs: a rule whose violations all cleared has no pairs
// but is still initialized, so a later transient read failure must not
// re-arm the silent baseline and swallow the next violation.
const UNREAD = "__unread__";
const SEEN = "__seen__";
const isMarker = (k: string): boolean => k.endsWith(`${SEP}${UNREAD}`) || k.endsWith(`${SEP}${SEEN}`);

export type CheckComplianceOpts = { now?: number; warnCap?: number };

type Pair = { rule: string; type: string; id: string };

function split(k: string): Pair {
	const [rule, type, ...rest] = k.split(SEP);
	return { rule: rule ?? "", type: type ?? "", id: rest.join(SEP) };
}

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
	// Initialization outlives the pairs: carry every SEEN marker forward.
	for (const [k, v] of Object.entries(prev)) if (k.endsWith(`${SEP}${SEEN}`)) current[k] = v;
	// Rules read completely for the first time this run: their pairs are the
	// baseline, not findings.
	const baselineOnly = new Set<string>();
	for (const rule of rules) {
		const prefix = `${rule}${SEP}`;
		const unreadKey = `${prefix}${UNREAD}`;
		const seenKey = `${prefix}${SEEN}`;
		const initialized = prev[seenKey] !== undefined;
		const read: Record<string, string> = {};
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
					read[[rule, q?.ResourceType ?? "unknown", id].join(SEP)] = "non_compliant";
				}
				token = resp.NextToken;
			} while (token);
			Object.assign(current, read);
			current[seenKey] = "seen";
			if (!initialized) baselineOnly.add(rule);
		} catch (e) {
			// One unreadable rule keeps its previous pairs (so they do not read as
			// resolved), or the sentinel when it was never initialized, and says so
			// once a day; the other rules still diff. A partial page never persists.
			if (initialized) {
				for (const [k, v] of Object.entries(prev)) if (k.startsWith(prefix) && !isMarker(k)) current[k] = v;
			} else {
				current[unreadKey] = "unread";
			}
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

	const diffed = diffSnapshot(state, current, {
		snapshot: SNAPSHOT,
		added: (k) => {
			if (isMarker(k)) return null;
			const { rule, type, id } = split(k);
			if (baselineOnly.has(rule)) return null;
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
		// Only NON_COMPLIANT results are ever read, so a pair that disappears is
		// no longer REPORTED non-compliant: the resource may be fixed, the rule
		// changed, or the rule deleted. The wording claims exactly that.
		removed: (k) => {
			if (isMarker(k)) return null;
			const { rule, type, id } = split(k);
			return {
				family: "compliance",
				severity: "info",
				resource: `${type}/${id}`,
				summary: `Config rule ${rule} no longer reports ${type} ${id} NON_COMPLIANT (resource fixed, rule changed, or rule removed)`,
				dedup_key: `compliance:${rule}:${id}:cleared:${at}`,
				evidence: { rule, resourceType: type, resourceId: id, verified: false },
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
	// the report names the first few and the overflow finding carries every
	// omitted pair, so the journal keeps the identities the cap hides.
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
			evidence: { total: warns.length, shown: warnCap, omitted: warns.slice(warnCap).map((f) => f.evidence) },
			at,
		});
	}
	return findings;
}
