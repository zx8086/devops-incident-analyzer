// memory-pr/src/index.ts
//
// SIO-849: PR-based human-in-the-loop for durable agent learnings. A proposal
// (wiki page, promoted key-decision, or new skill) is staged on a fresh
// agent/learn/* branch and opened as a draft PR for human review. Never merges,
// never commits secrets, no-op when disabled or the kill switch is active.

import { getLogger } from "@devops-agent/observability";
import { isKillSwitchActive } from "@devops-agent/shared";
import { createFetchGitHubClient, type GitHubClient } from "./github-client.ts";
import { scanFiles } from "./secret-scan.ts";
import { type MemoryPrProposal, MemoryPrProposalSchema, type OpenMemoryPrResult } from "./types.ts";

export { createFetchGitHubClient, type GitHubClient } from "./github-client.ts";
export { type SecretFinding, scanContent, scanFiles } from "./secret-scan.ts";
export {
	type MemoryPrFile,
	MemoryPrFileSchema,
	type MemoryPrProposal,
	MemoryPrProposalSchema,
	type OpenMemoryPrResult,
} from "./types.ts";

const logger = getLogger("memory-pr");

interface MemoryPrConfig {
	enabled: boolean;
	token?: string;
	repo?: string;
	base: string;
}

export function resolveMemoryPrConfig(env: NodeJS.ProcessEnv = process.env): MemoryPrConfig {
	const flag = env.MEMORY_PR_ENABLED;
	return {
		enabled: flag === "true" || flag === "1",
		token: env.GITHUB_TOKEN,
		repo: env.MEMORY_PR_REPO,
		base: env.MEMORY_PR_BASE && env.MEMORY_PR_BASE !== "" ? env.MEMORY_PR_BASE : "main",
	};
}

export interface OpenMemoryPrOptions {
	// Injectable for tests; defaults to the fetch client built from env config.
	client?: GitHubClient;
	env?: NodeJS.ProcessEnv;
}

// Stages the proposal's files on a fresh branch and opens a draft PR. Returns a
// structured result rather than throwing for the expected "off" paths
// (disabled, kill switch, secret hit) so callers (lifecycle teardown) can treat
// them as soft outcomes.
export async function openMemoryPr(
	proposal: MemoryPrProposal,
	options: OpenMemoryPrOptions = {},
): Promise<OpenMemoryPrResult> {
	const parsed = MemoryPrProposalSchema.parse(proposal);
	const config = resolveMemoryPrConfig(options.env);

	if (!config.enabled) {
		return { status: "skipped", reason: "MEMORY_PR_ENABLED is not set" };
	}
	if (isKillSwitchActive()) {
		return { status: "skipped", reason: "kill switch active" };
	}
	// Refuse to ever write directly to the base branch.
	if (parsed.branch === config.base) {
		return { status: "blocked", reason: `refusing to write to base branch "${config.base}"` };
	}

	// Hard stop: a credential in any file aborts before any GitHub write.
	const secrets = scanFiles(parsed.files);
	if (secrets.length > 0) {
		logger.error(
			{ kinds: secrets.map((s) => s.kind), paths: secrets.map((s) => s.path) },
			"secret scan blocked memory PR",
		);
		return { status: "blocked", reason: `secret scan found ${secrets.length} potential secret(s)` };
	}

	if (!config.token || !config.repo) {
		return { status: "skipped", reason: "GITHUB_TOKEN or MEMORY_PR_REPO not configured" };
	}

	const client = options.client ?? createFetchGitHubClient({ token: config.token, repo: config.repo });

	const baseSha = await client.getBaseSha(config.base);
	const commitSha = await client.createCommitWithFiles({
		baseSha,
		files: parsed.files,
		message: `${proposal.title}\n\nAutomated durable-memory proposal (${proposal.kind}). Review before merge.`,
	});
	await client.createBranch(parsed.branch, commitSha);
	const pr = await client.createPullRequest({
		title: proposal.title,
		head: parsed.branch,
		base: config.base,
		body: proposal.body,
	});

	logger.info({ url: pr.url, number: pr.number, kind: proposal.kind }, "opened memory review PR");
	return { status: "opened", url: pr.url, number: pr.number };
}
