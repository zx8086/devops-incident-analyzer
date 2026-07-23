// agent/src/iac/commit-style.ts
// SIO-1185: commit-subject guard adapted from gitlab-org/ai/skills commit-messages.
// The house convention ("<cluster>: <verb phrase>") wins over the upstream
// no-prefix rule (their own guide: project convention always wins), but the
// compatible rules apply: a commit subject is a single line and hard-capped at
// 72 characters. Several proposer templates interpolate unbounded lists (ILM
// fields, cluster-defaults template names, reconcile summaries), so the cap is
// enforced here rather than hoped for at each call site.

export const COMMIT_SUBJECT_MAX = 72;

export function formatCommitSubject(subject: string, max: number = COMMIT_SUBJECT_MAX): string {
	const oneLine = subject.replace(/\s*\n[\s\S]*$/, "").trim();
	if (oneLine.length <= max) return oneLine;
	// Truncate on a word boundary where possible; ASCII ellipsis per no-emoji policy.
	const cut = oneLine.slice(0, max - 3);
	const lastSpace = cut.lastIndexOf(" ");
	const base = lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut;
	return `${base}...`;
}
