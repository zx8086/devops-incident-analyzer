// memory-pr/src/types.ts
import { z } from "zod";

export const MemoryPrFileSchema = z
	.object({
		// Repo-relative path, e.g. "agents/incident-analyzer/memory/wiki/pages/x.md".
		path: z.string().min(1),
		contents: z.string(),
	})
	.strict();
export type MemoryPrFile = z.infer<typeof MemoryPrFileSchema>;

export const MemoryPrProposalSchema = z
	.object({
		// SIO-1127: "runbook" = a PR-gated DRAFT runbook distilled from a HIL learning turn.
		kind: z.enum(["wiki-page", "key-decision", "new-skill", "runbook"]),
		// Fresh branch off base; must start with the agent/learn/ namespace.
		branch: z.string().regex(/^agent\/learn\//, "branch must be under agent/learn/"),
		title: z.string().min(1),
		body: z.string(),
		files: z.array(MemoryPrFileSchema).min(1),
		labels: z.array(z.string()).optional(),
	})
	.strict();
export type MemoryPrProposal = z.infer<typeof MemoryPrProposalSchema>;

export interface OpenMemoryPrResult {
	status: "opened" | "skipped" | "blocked";
	reason?: string;
	url?: string;
	number?: number;
}
