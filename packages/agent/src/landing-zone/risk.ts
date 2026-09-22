// packages/agent/src/landing-zone/risk.ts

import type {
	EvidenceItem,
	EvidenceReconciliation,
	EvidenceSource,
	LandingZoneRiskAssessment,
} from "@devops-agent/shared";
import type { LandingZoneIntent } from "./types.ts";

export interface LandingZoneRiskContext {
	intent?: LandingZoneIntent;
	requestText?: string;
	currentEvidenceSources?: EvidenceSource[];
	repositories?: string[];
	evidence?: EvidenceItem[];
}

interface StopRule {
	pattern: RegExp;
	reason: string;
}

const STOP_RULES: StopRule[] = [
	{
		pattern:
			/\b(backend|state bucket|lockfile|dynamodb lock)\b.*\b(change|migrat\w*|contract|locking|replace|remove)\b|\b(change|migrat)\w*\b.*\bbackend\b/i,
		reason: "Backend and locking contracts require an explicit platform decision before a change is proposed.",
	},
	{
		pattern:
			/\b(shared[- ]module|module ref|module version)\b.*\b(unverified|without|unknown|latest|main|head|branch)\b/i,
		reason: "A shared-module change requires a verified released version and live contract.",
	},
	{
		pattern:
			/\b(destroy|delete|replace|recreate)\w*\b.*\b(plan|account|kms|network|resource|state)\b|\bplan\b.*\b(destroy|delete|replace|recreate)\w*\b/i,
		reason: "A destructive plan requires explicit human review and recovery ownership.",
	},
	{
		pattern: /\bterraform state (?:rm|mv|push|pull)|\bforce-unlock\b|\bstate operation\b/i,
		reason: "Terraform state operations are outside the read-only planning boundary.",
	},
	{
		pattern: /\b0\.0\.0\.0\/0\b|\bpublic (?:access|ingress|exposure|subnet)\b/i,
		reason: "Public access requires a documented and approved security exception.",
	},
	{
		pattern:
			/\biam\b.*(?:\baction\s*\*|\bresource\s*\*|\bwildcard\b|\bbroad\b)|(?:\baction\s*\*|\bresource\s*\*).*\biam\b/i,
		reason: "Broad IAM expansion requires an approved least-privilege design.",
	},
	{
		pattern: /\b(plaintext secret|commit\w* (?:a )?(?:secret|credential)|secret in tfvars|static credential)\b/i,
		reason: "Secrets and credentials must not be placed in Terraform configuration or state.",
	},
];

function hasCurrentSource(
	reconciliation: EvidenceReconciliation,
	source: EvidenceSource,
	context: LandingZoneRiskContext,
): boolean {
	if (context.currentEvidenceSources?.includes(source)) return true;
	return reconciliation.comparisons.some((comparison) => {
		const candidates = [
			comparison.pvhStandard,
			comparison.liveImplementation,
			comparison.terraformContract,
			comparison.awsRecommendation,
		];
		return candidates.some(
			(item) => item?.source === source && item.status === "observed" && item.freshness.status === "current",
		);
	});
}

export function assessRisk(
	reconciliation: EvidenceReconciliation,
	context: LandingZoneRiskContext = {},
): LandingZoneRiskAssessment {
	const intent = context.intent ?? "understand";
	const requestText = context.requestText ?? "";
	const proposesChange = intent === "propose-change";
	const topologyRequested =
		/\b(live|deployed|actual|drift|topology|resource state)\b.*\b(vpc|subnet|network|dns|route)|\b(vpc|subnet|network|dns|route)\b.*\b(live|deployed|actual|drift|topology|resource state)\b/i.test(
			requestText,
		);
	const requiredEvidenceSources: EvidenceSource[] = proposesChange ? ["gitlab"] : [];
	if (proposesChange && topologyRequested) requiredEvidenceSources.push("aws-api");

	const missingRequired = requiredEvidenceSources.filter(
		(source) =>
			reconciliation.unavailableSources.includes(source) || !hasCurrentSource(reconciliation, source, context),
	);
	const missingRepositories = (context.repositories ?? []).filter(
		(repository) =>
			!context.evidence?.some(
				(item) =>
					item.source === "gitlab" &&
					item.status === "observed" &&
					item.freshness.status === "current" &&
					item.provenance.repository === repository,
			),
	);
	const stopConditions = proposesChange
		? STOP_RULES.filter((rule) => rule.pattern.test(requestText)).map((rule) => rule.reason)
		: [];
	if (missingRequired.includes("gitlab")) {
		stopConditions.unshift("Current live gitlab repository evidence is required before proposing a repository change.");
	} else if (proposesChange && missingRepositories.length > 0) {
		stopConditions.unshift(
			`Current live gitlab evidence is missing for required repositories: ${missingRepositories.join(", ")}.`,
		);
	}
	if (missingRequired.includes("aws-api")) {
		stopConditions.push("Current AWS live-state evidence is required before proposing a topology change.");
	}
	if (proposesChange && reconciliation.comparisons.some((comparison) => comparison.action === "escalate")) {
		stopConditions.push(
			"Conflicting authoritative evidence requires a platform decision; do not rewrite production automatically.",
		);
	}

	const reasons: string[] = [];
	if (!proposesChange && reconciliation.unavailableSources.includes("gitlab")) {
		reasons.push(
			"GitLab is unavailable; provide general guidance only and label repository-specific claims unverified.",
		);
	}
	if (topologyRequested && !hasCurrentSource(reconciliation, "aws-api", context)) {
		reasons.push("AWS live-state evidence is unavailable, so the requested topology remains unverified.");
	}
	reasons.push(...stopConditions);

	const blocked = stopConditions.length > 0;
	const constrained = reasons.length > 0 || reconciliation.status === "conflicting-evidence";
	return {
		level: blocked ? "blocked" : proposesChange ? "high" : constrained ? "medium" : "low",
		reasons,
		requiresHumanDecision: proposesChange || reconciliation.status === "conflicting-evidence",
		blocked,
		stopConditions,
		requiredEvidenceSources,
	};
}
