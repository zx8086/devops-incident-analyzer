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

// SIO-1758: the pair diff cannot absorb churn. A Karpenter consolidation in
// eu-mendix-platform-prd (2026-09-16 09:07) launched nodes whose instances,
// ENIs and volumes were 84 NEW pairs under two rules and retired 30 old ones:
// one report of 51 findings for one event. A rule moving this many resources
// in one run is one cause, reported once (the drift check's ec2:batch idea); a
// lone flip (the restricted-rdp case this check exists for) keeps its own line.
const COLLAPSE_AT = 4;
const SUMMARY_TYPES = 4;
// A collapsed finding is investigated, and the prompt embeds its evidence: 281
// identities (the live mendix required-tags set) is ~30 KB per turn. A sample
// plus the per-type counts is enough to diagnose a rule; the snapshot keeps
// every pair.
const SAMPLE_RESOURCES = 25;

export type CheckComplianceOpts = { now?: number; warnCap?: number; collapseAt?: number };

type PairEvidence = { rule: string; resourceType: string; resourceId: string };

function typeBreakdown(pairs: PairEvidence[]): { byType: Record<string, number>; text: string } {
	const counts = new Map<string, number>();
	for (const p of pairs) counts.set(p.resourceType, (counts.get(p.resourceType) ?? 0) + 1);
	const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
	const shown = ranked.slice(0, SUMMARY_TYPES).map(([t, n]) => `${n} ${t}`);
	if (ranked.length > SUMMARY_TYPES) shown.push(`${ranked.length - SUMMARY_TYPES} more type(s)`);
	return { byType: Object.fromEntries(ranked), text: shown.join(", ") };
}

// Per-pair findings in, the same findings out except that a rule with
// collapseAt or more new (warn) or cleared (info) pairs becomes one finding for
// that rule, with per-type counts and a sample of identities. The new-pairs key is stable per
// rule on purpose: the next churn on the same rule inside the diagnosis
// cooldown reuses the last diagnosis instead of buying another turn, and a
// ledger pattern like `compliance:<rule>:%` still matches it.
export function collapseByRule(findings: Finding[], at: string, collapseAt = COLLAPSE_AT): Finding[] {
	const out: Finding[] = [];
	const groups = new Map<string, Finding[]>();
	for (const f of findings) {
		const rule = (f.evidence as Partial<PairEvidence>).rule;
		if (!rule || (f.severity !== "warn" && f.severity !== "info")) {
			out.push(f);
			continue;
		}
		const k = `${f.severity}${SEP}${rule}`;
		const group = groups.get(k) ?? [];
		group.push(f);
		groups.set(k, group);
	}
	for (const group of groups.values()) {
		const first = group[0] as Finding;
		if (group.length < collapseAt) {
			out.push(...group);
			continue;
		}
		const pairs = group.map((f) => f.evidence as PairEvidence);
		const rule = (first.evidence as PairEvidence).rule;
		const { byType, text } = typeBreakdown(pairs);
		const resources = pairs
			.slice(0, SAMPLE_RESOURCES)
			.map((p) => ({ resourceType: p.resourceType, resourceId: p.resourceId }));
		const omitted = Math.max(0, pairs.length - SAMPLE_RESOURCES);
		const added = first.severity === "warn";
		out.push({
			family: "compliance",
			severity: first.severity,
			resource: `config-rule/${rule}`,
			summary: added
				? `Config rule ${rule} NON_COMPLIANT for ${pairs.length} newly reported resource(s): ${text}`
				: `Config rule ${rule} no longer reports ${pairs.length} resource(s) NON_COMPLIANT (${text}; resources fixed or deleted, or rule changed)`,
			dedup_key: added ? `compliance:${rule}:batch` : `compliance:${rule}:cleared-batch:${at}`,
			evidence: added
				? { rule, count: pairs.length, byType, resources, omitted }
				: { rule, count: pairs.length, byType, resources, omitted, verified: false },
			at,
		});
	}
	return out;
}

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
			// Silent only after a sentinel: a rule seen NON_COMPLIANT for the first
			// time because a resource just broke is the finding this check exists
			// for (the restricted-rdp flip), not a baseline.
			if (prev[unreadKey] !== undefined) baselineOnly.add(rule);
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
	const collapsed = collapseByRule(diffed, at, opts.collapseAt ?? COLLAPSE_AT);
	const warns = collapsed.filter((f) => f.severity === "warn");
	const rest = collapsed.filter((f) => f.severity !== "warn");
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
