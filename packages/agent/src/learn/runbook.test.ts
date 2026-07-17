// agent/src/learn/runbook.test.ts
import { describe, expect, test } from "bun:test";
import { parseRunbookFrontmatter } from "@devops-agent/gitagent-bridge/src/manifest-loader.ts";
import { draftRunbookFilename, renderRunbookMarkdown } from "./runbook.ts";
import type { RootCauseCorrection } from "./schema.ts";

function rc(overrides: Partial<RootCauseCorrection> = {}): RootCauseCorrection {
	return {
		id: "rc-1",
		kind: "root-cause",
		causeClass: "route53-resolver-rule-vpc-association-missing",
		description: "The VPC has no resolver rule; the hostname resolves to non-routable IPs.",
		resolution: "Associate the resolver rule via the infrastructure repo.",
		invalidatedHypotheses: [{ hypothesis: "SASL credential invalid", reason: "the client never connects" }],
		evidence: ["Root cause found: it's a DNS/network gap, not credentials."],
		...overrides,
	};
}

describe("SIO-1127 draftRunbookFilename", () => {
	test("derives <causeClass>.md", () => {
		expect(draftRunbookFilename("route53-resolver-rule-vpc-association-missing")).toBe(
			"route53-resolver-rule-vpc-association-missing.md",
		);
	});
});

describe("SIO-1127 renderRunbookMarkdown", () => {
	test("emits valid triggers frontmatter + H1 + DRAFT banner + sections", () => {
		const md = renderRunbookMarkdown(rc(), "DEVOPS-1355", "high");
		// frontmatter is a --- delimited block at the very top (loadKnowledge parses it).
		expect(md.startsWith("---\n")).toBe(true);
		expect(md).toContain("triggers:");
		expect(md).toContain("  metrics:");
		expect(md).toContain("  severity:\n    - high");
		expect(md).toContain("  match: any");
		// exactly one closing frontmatter fence before the body.
		const fenceCount = (md.match(/^---$/gm) ?? []).length;
		expect(fenceCount).toBe(2);
		// H1 title (DRAFT) + banner + the cause/resolution/ruled-out sections.
		expect(md).toContain("# Route53 Resolver Rule Vpc Association Missing (DRAFT)");
		expect(md).toContain("> DRAFT runbook auto-distilled from the human resolution of DEVOPS-1355");
		expect(md).toContain("## Root Cause");
		expect(md).toContain("## Resolution");
		expect(md).toContain("Associate the resolver rule via the infrastructure repo.");
		expect(md).toContain("## Ruled Out");
		expect(md).toContain("SASL credential invalid -- ruled out: the client never connects");
	});

	test("defaults severity to high and handles no ruled-out hypotheses", () => {
		const md = renderRunbookMarkdown(rc({ invalidatedHypotheses: [] }), "DEVOPS-9");
		expect(md).toContain("  severity:\n    - high");
		expect(md).toContain("(none recorded)");
	});

	// CRITICAL: the real manifest loader throws on malformed runbook frontmatter, which would
	// break the WHOLE agent manifest load on merge. The rendered draft MUST parse cleanly.
	test("the rendered frontmatter parses through the real manifest loader (no throw)", () => {
		const md = renderRunbookMarkdown(rc(), "DEVOPS-1355", "critical");
		const parsed = parseRunbookFrontmatter(md);
		expect(parsed.triggers).toBeDefined();
		expect(parsed.body).toContain("Route53 Resolver Rule");
		// severity round-trips through the parsed triggers.
		expect(JSON.stringify(parsed.triggers)).toContain("critical");
	});
});
