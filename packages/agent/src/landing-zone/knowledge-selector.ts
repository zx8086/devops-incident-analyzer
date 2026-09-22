// packages/agent/src/landing-zone/knowledge-selector.ts

import type { LandingZoneIntent } from "./types.ts";

const BASE_KNOWLEDGE = [
	"conventions/evidence-validation.md",
	"conventions/okf-authoring.md",
	"shared/aws-naming.md",
	"shared/aws-tagging.md",
];

const KNOWN_REPOSITORIES = new Set([
	"aws-lz-account-creator",
	"aws-lz-ami",
	"aws-lz-app-proxy",
	"aws-lz-backup",
	"aws-lz-citrix",
	"aws-lz-dc",
	"aws-lz-dfs",
	"aws-lz-f5-ingress",
	"aws-lz-finops",
	"aws-lz-infra-ss-components",
	"aws-lz-logging",
	"aws-lz-monitoring",
	"aws-lz-network-core",
	"aws-lz-network-workloads",
	"aws-lz-post-vending",
	"aws-lz-security-tools",
	"aws-lz-shared-tools",
	"aws-lz-ssm",
	"aws-lz-storage",
	"aws-lz-vending-orchestrator",
	"dhco-gitlab-terraform",
	"gitlab-k8s-runners-lzv2",
	"gitlab-k8s-runners-terraform",
]);

const REPOSITORY_ROUTES: ReadonlyArray<{ pattern: RegExp; repository: string }> = [
	{ pattern: /\b(account|account vending|vending)\b/, repository: "aws-lz-account-creator" },
	{ pattern: /\b(core network|cloud wan|ipam|transit gateway|direct connect)\b/, repository: "aws-lz-network-core" },
	{ pattern: /\b(workload network|vpc|subnet|endpoint)\b/, repository: "aws-lz-network-workloads" },
	{ pattern: /\b(dns|post[- ]vending|route 53|route53)\b/, repository: "aws-lz-post-vending" },
	{ pattern: /\b(gitlab project|gitlab repository)\b/, repository: "dhco-gitlab-terraform" },
	{ pattern: /\b(runner|runners)\b/, repository: "gitlab-k8s-runners-lzv2" },
];

export interface LandingZoneKnowledgeSelection {
	repositories: string[];
	entries: string[];
}

export function selectLandingZoneKnowledge(
	_intent: LandingZoneIntent,
	repository: string | readonly string[] | null,
	topics: readonly string[],
): LandingZoneKnowledgeSelection {
	const repositories = new Set(
		(typeof repository === "string" ? [repository] : (repository ?? [])).filter((value) => value.trim().length > 0),
	);
	const topicText = topics.join(" ").toLowerCase();
	for (const route of REPOSITORY_ROUTES) {
		if (route.pattern.test(topicText)) repositories.add(route.repository);
	}

	const entries = new Set(BASE_KNOWLEDGE);
	for (const name of repositories) {
		if (KNOWN_REPOSITORIES.has(name)) entries.add(`repos/${name}.md`);
		else entries.add("okr-gaps/08-uncovered-domains.md");
	}
	if (/\b(module|modules|provider|terraform contract)\b/.test(topicText)) entries.add("shared/unpinned-refs.md");
	if (/\b(aws|iam|vpc|subnet|route|dns|kms|s3)\b/.test(topicText)) entries.add("aws-standards/source-catalog.md");
	if (/\b(terraform|module|provider|backend|state|plan|lock|locking|workspace)\b/.test(topicText)) {
		entries.add("terraform-standards/source-catalog.md");
	}

	return { repositories: [...repositories], entries: [...entries] };
}
