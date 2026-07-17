// agent/src/learn/runbook.ts
//
// SIO-1127: render a PR-gated DRAFT runbook from a HIL-corrected root cause. The file is
// NEVER written into agents/incident-analyzer/knowledge/runbooks/ directly -- the manifest
// loader auto-catalogs every *.md there on the next load, so the merge of the memory PR is
// the ONLY control. The frontmatter MUST be valid (loadKnowledge throws on malformed
// runbook frontmatter, which would break the whole manifest load), so the shape here mirrors
// the existing catalog runbooks: a `triggers:` block + an H1 title + prose sections.

import type { RootCauseCorrection } from "./schema.ts";

export const RUNBOOK_DIR = "agents/incident-analyzer/knowledge/runbooks";

// Derive the draft filename from the (already kebab-case, schema-validated) cause class.
export function draftRunbookFilename(causeClass: string): string {
	return `${causeClass}.md`;
}

// Turn a kebab-case class into a Title Case heading ("route53-resolver-rule" -> "Route53 Resolver Rule").
function titleCase(causeClass: string): string {
	return causeClass
		.split("-")
		.filter((w) => w.length > 0)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

// Render the DRAFT runbook markdown. severity feeds the triggers block; the H1 becomes the
// catalog title and the first paragraph its summary (prompt-context.ts parseRunbookCatalogEntry).
export function renderRunbookMarkdown(rc: RootCauseCorrection, ticketKey: string, severity?: string): string {
	const title = `${titleCase(rc.causeClass)} (DRAFT)`;
	const sev = severity && severity.length > 0 ? severity : "high";
	const ruledOut =
		rc.invalidatedHypotheses.length > 0
			? rc.invalidatedHypotheses.map((h) => `- ${h.hypothesis} -- ruled out: ${h.reason}`).join("\n")
			: "- (none recorded)";
	// Frontmatter mirrors the catalog shape: triggers.metrics from the cause class tokens,
	// triggers.severity from the incident severity, match: any. CodeRabbit PR #406: a
	// short-token causeClass (e.g. "db-io") filters to an empty list, which would render
	// `metrics:` as null and fail RunbookFrontmatterSchema -- fall back to the whole class.
	const tokens = rc.causeClass
		.split("-")
		.filter((w) => w.length > 2)
		.slice(0, 6);
	const metrics = tokens.length > 0 ? tokens : [rc.causeClass];
	return `---
triggers:
  metrics:
${metrics.map((m) => `    - ${m}`).join("\n")}
  severity:
    - ${sev}
  match: any
---
# ${title}

> DRAFT runbook auto-distilled from the human resolution of ${ticketKey}. Review and edit before relying on it.

${rc.description}

## Root Cause
${rc.description}

## Resolution
${rc.resolution}

## Ruled Out
${ruledOut}

## Provenance
Distilled by HIL learning from ${ticketKey}. Cause class: \`${rc.causeClass}\`.
`;
}
