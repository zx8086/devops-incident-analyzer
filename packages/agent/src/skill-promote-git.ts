// agent/src/skill-promote-git.ts
//
// SIO-1345: git/gh mechanics for the --pr promotion flow. Pure builders are unit-
// tested with a fake runner; spawnRunner is the only real-process seam. The git/gh
// orchestration (runPromotion/spawnRunner) is imported LAZILY by
// skill-promote-cli.ts main() only -- never from graph/runtime code. The pure PR-
// text builders (buildPrTitle/buildPrBody) are side-effect-free and also feed the
// runtime memory-PR promotion path (SIO-1346, learn/skill-pr.ts).

export interface GitRunner {
	run(argv: string[]): { ok: boolean; stdout: string; stderr: string };
}

export function spawnRunner(cwd: string): GitRunner {
	return {
		run(argv) {
			const proc = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
			return {
				ok: proc.exitCode === 0,
				stdout: proc.stdout.toString(),
				stderr: proc.stderr.toString(),
			};
		},
	};
}

export function promotionBranchName(agent: string, skill: string): string {
	return `skill/${agent}/${skill}`;
}

export function promotionCommitMessage(input: { agent: string; skill: string; ticket?: string }): string {
	const prefix = input.ticket ? `${input.ticket}: ` : "";
	return `${prefix}promote learned skill ${input.skill} (${input.agent})`;
}

export function buildPrTitle(agent: string, skill: string): string {
	return `Promote learned skill: ${skill} (${agent})`;
}

export function buildPrBody(input: {
	agent: string;
	skill: string;
	annotations: Record<string, string | undefined>;
}): string {
	const a = input.annotations;
	return [
		`Promotes the learned kind:skill proposal \`${input.skill}\` for \`${input.agent}\` (SIO-1345 git-native promotion; merge = approval).`,
		"",
		`- learned_from: ${a.learned_from ?? "unknown"}`,
		`- learned_at: ${a.learned_at ?? "unknown"}`,
		`- task_category: ${a.task_category ?? "unknown"}`,
		"",
		"Review checklist:",
		"- [ ] Procedure is correct and generalizable (not incident-specific)",
		"- [ ] Tool names referenced by the skill exist for this agent (see docs/development/action-tool-maps.md)",
		"- [ ] Frontmatter counters look sane (fresh promotion seeds confidence 0.5, counts 0)",
		"- [ ] agent.yaml gained exactly one skills entry",
		"",
		"Merging this PR activates the skill in the agent prompt. Closing it declines the proposal (the durable fact remains for future reference).",
	].join("\n");
}

export interface PromotionInput {
	agent: string;
	skill: string;
	skillFile: string;
	manifestFile: string;
	ticket?: string;
	annotations: Record<string, string | undefined>;
}

export interface PromotionResult {
	branch: string;
	prUrl?: string;
	manualSteps: string[];
}

function must(runner: GitRunner, argv: string[]): string {
	const r = runner.run(argv);
	if (!r.ok) throw new Error(`${argv.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`);
	return r.stdout;
}

// Orchestrate one promotion: clean-tree check, branch off, let the caller write the
// files, then add/commit/push and open the PR. A gh failure after a successful push
// degrades to a manual step (the branch is already up); a git failure throws with the
// failing argv and leaves the tree as-is for the human to inspect -- no auto-rollback.
export function runPromotion(runner: GitRunner, input: PromotionInput, writeFiles: () => void): PromotionResult {
	const status = must(runner, ["git", "status", "--porcelain"]);
	if (status.trim() !== "") throw new Error("working tree not clean; commit or stash first");

	const original = must(runner, ["git", "rev-parse", "--abbrev-ref", "HEAD"]).trim();
	const branch = promotionBranchName(input.agent, input.skill);
	must(runner, ["git", "checkout", "-b", branch]);

	try {
		writeFiles();
	} catch (error) {
		// Mirror the graceful-degradation posture below: explain the branch state and how
		// to recover instead of surfacing a raw error from a half-done promotion.
		const back = runner.run(["git", "checkout", original]);
		const hint = back.ok
			? `returned to ${original}; remove the branch with: git branch -D ${branch}`
			: `still on ${branch} (checkout back failed; inspect git status); recover with: git checkout ${original} && git branch -D ${branch}`;
		throw new Error(
			`writing skill files failed after creating branch ${branch}; ${hint}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	must(runner, ["git", "add", input.skillFile, input.manifestFile]);
	must(runner, ["git", "commit", "-m", promotionCommitMessage(input)]);
	must(runner, ["git", "push", "-u", "origin", branch]);

	const manualSteps: string[] = [];
	const title = buildPrTitle(input.agent, input.skill);
	const body = buildPrBody(input);
	const pr = runner.run(["gh", "pr", "create", "--title", title, "--body", body, "--head", branch]);
	let prUrl: string | undefined;
	if (pr.ok) {
		prUrl = pr.stdout.trim().split("\n").at(-1);
	} else {
		manualSteps.push(`gh pr create --title ${JSON.stringify(title)} --head ${branch} --body-file <body.md>`);
	}

	const back = runner.run(["git", "checkout", original]);
	if (!back.ok) manualSteps.push(`git checkout ${original}`);

	return { branch, ...(prUrl ? { prUrl } : {}), manualSteps };
}
