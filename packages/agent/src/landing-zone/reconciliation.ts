// packages/agent/src/landing-zone/reconciliation.ts

import type { EvidenceItem, StandardsComparison } from "@devops-agent/shared";

const STATUS_RANK: Record<EvidenceItem["status"], number> = {
	observed: 4,
	inferred: 3,
	proposed: 2,
	unverified: 1,
};

const FRESHNESS_RANK: Record<EvidenceItem["freshness"]["status"], number> = {
	current: 3,
	unknown: 2,
	stale: 1,
};

const SOURCE_RANK: Record<EvidenceItem["source"], number> = {
	"aws-api": 7,
	gitlab: 6,
	"pvh-okf": 5,
	"terraform-docs": 4,
	"aws-docs": 3,
	memory: 2,
	"knowledge-graph": 1,
};

function compareEvidence(left: EvidenceItem, right: EvidenceItem): number {
	return (
		FRESHNESS_RANK[right.freshness.status] - FRESHNESS_RANK[left.freshness.status] ||
		STATUS_RANK[right.status] - STATUS_RANK[left.status] ||
		SOURCE_RANK[right.source] - SOURCE_RANK[left.source] ||
		Date.parse(right.retrievedAt) - Date.parse(left.retrievedAt) ||
		left.id.localeCompare(right.id)
	);
}

function strongest(items: EvidenceItem[], sources: EvidenceItem["source"][]): EvidenceItem | undefined {
	return items.filter((item) => sources.includes(item.source)).sort(compareEvidence)[0];
}

function comparableValue(item: EvidenceItem | undefined): string | undefined {
	if (!item || item.status === "unverified" || item.freshness.status !== "current") return undefined;
	return item.claimValue?.trim().toLowerCase().replace(/\s+/g, " ");
}

function differs(
	left: EvidenceItem | undefined,
	right: EvidenceItem | undefined,
	includeStale = false,
	rightMayBeSubset = false,
): boolean {
	const normalize = (item: EvidenceItem | undefined) =>
		includeStale && item?.status !== "unverified"
			? item?.claimValue?.trim().toLowerCase().replace(/\s+/g, " ")
			: comparableValue(item);
	const leftValue = normalize(left);
	const rightValue = normalize(right);
	if (leftValue !== undefined && rightValue !== undefined && rightMayBeSubset) {
		const allowed = new Set(leftValue.split(" | "));
		return rightValue.split(" | ").some((value) => !allowed.has(value));
	}
	return leftValue !== undefined && rightValue !== undefined && leftValue !== rightValue;
}

function comparisonFor(claim: string, items: EvidenceItem[]): StandardsComparison {
	const pvhStandard = strongest(items, ["pvh-okf"]);
	const liveImplementation = strongest(items, ["aws-api", "gitlab"]);
	const terraformContract = strongest(items, ["terraform-docs"]);
	const awsRecommendation = strongest(items, ["aws-docs"]);
	const authoritative = [pvhStandard, liveImplementation, terraformContract].filter(
		(item): item is EvidenceItem => item !== undefined,
	);
	const allCurrent = authoritative.every((item) => item.status === "observed" && item.freshness.status === "current");
	const liveSurfaceMayBeSubset = claim.endsWith(":authoring-surface");
	const pvhLiveConflict = differs(pvhStandard, liveImplementation, true, liveSurfaceMayBeSubset);
	const contractLiveConflict = differs(terraformContract, liveImplementation, true, liveSurfaceMayBeSubset);
	const pvhAwsDifference = differs(pvhStandard, awsRecommendation);
	const authoritativeValuesAvailable = authoritative.every((item) => comparableValue(item) !== undefined);
	const pvhAwsCorroborated =
		comparableValue(pvhStandard) !== undefined && comparableValue(pvhStandard) === comparableValue(awsRecommendation);
	const exceptionRecorded = items.some((item) => /\b(exception|waiver|approved deviation)\b/i.test(item.summary));

	let alignment: StandardsComparison["alignment"] = "unverified";
	let action: StandardsComparison["action"] = "monitor";
	if (authoritative.length > 0 && allCurrent) {
		if (pvhLiveConflict || contractLiveConflict) {
			alignment = exceptionRecorded ? "exception" : "divergent";
			action = "escalate";
		} else if (pvhAwsDifference) {
			alignment = "divergent";
			action = "explain";
		} else if (authoritative.length >= 2 && authoritativeValuesAvailable) {
			alignment = "aligned";
			action = "explain";
		} else if (pvhAwsCorroborated) {
			alignment = "aligned";
			action = "explain";
		} else {
			alignment = "unresolved";
			action = "explain";
		}
	} else if (authoritative.length > 0) {
		alignment = pvhLiveConflict || contractLiveConflict ? "divergent" : "unverified";
		action = pvhLiveConflict || contractLiveConflict ? "explain" : "monitor";
	}

	return {
		claim,
		...(pvhStandard && { pvhStandard }),
		...(liveImplementation && { liveImplementation }),
		...(terraformContract && { terraformContract }),
		...(awsRecommendation && { awsRecommendation }),
		alignment,
		action,
	};
}

export function reconcileEvidence(items: EvidenceItem[]): StandardsComparison[] {
	const byClaim = new Map<string, EvidenceItem[]>();
	for (const item of items) {
		const group = byClaim.get(item.claimKey) ?? [];
		group.push(item);
		byClaim.set(item.claimKey, group);
	}
	return [...byClaim.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([claim, claimItems]) => comparisonFor(claim, claimItems));
}
