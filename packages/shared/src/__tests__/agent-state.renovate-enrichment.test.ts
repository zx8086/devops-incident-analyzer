// packages/shared/src/__tests__/agent-state.renovate-enrichment.test.ts
import { describe, expect, test } from "bun:test";
import { StreamEventSchema } from "../agent-state.ts";

describe("StreamEventSchema renovate_trigger_choice enrichment fields", () => {
	test("accepts the event with all 4 enrichment fields present", () => {
		const parsed = StreamEventSchema.safeParse({
			type: "renovate_trigger_choice",
			threadId: "t1",
			marker: "renovate/eu-onboarding-elastic_agent",
			line: "chore(deps): [eu-onboarding] elastic_agent to v2.9.4",
			message: "This will tick...",
			installedVersion: "2.8.0",
			targetVersion: "2.9.4",
			policyCount: 24,
			changelog: [{ version: "2.9.4", changes: [{ description: "Add X", type: "enhancement", link: "https://x" }] }],
		});
		expect(parsed.success).toBe(true);
		if (parsed.success && parsed.data.type === "renovate_trigger_choice") {
			expect(parsed.data.installedVersion).toBe("2.8.0");
		}
	});

	test("accepts the event with all 4 enrichment fields absent (older/degraded payload)", () => {
		const parsed = StreamEventSchema.safeParse({
			type: "renovate_trigger_choice",
			threadId: "t1",
			marker: "x",
			line: "y",
			message: "z",
		});
		expect(parsed.success).toBe(true);
	});

	test("accepts null for installedVersion/targetVersion/policyCount (Kibana lookup unavailable)", () => {
		const parsed = StreamEventSchema.safeParse({
			type: "renovate_trigger_choice",
			threadId: "t1",
			marker: "x",
			line: "y",
			message: "z",
			installedVersion: null,
			targetVersion: null,
			policyCount: null,
		});
		expect(parsed.success).toBe(true);
	});

	test("rejects a changelog entry missing the required description field", () => {
		const parsed = StreamEventSchema.safeParse({
			type: "renovate_trigger_choice",
			threadId: "t1",
			marker: "x",
			line: "y",
			message: "z",
			changelog: [{ version: "2.9.4", changes: [{ type: "enhancement" }] }],
		});
		expect(parsed.success).toBe(false);
	});

	test("accepts recentChanges and priorTriggers when present", () => {
		const parsed = StreamEventSchema.safeParse({
			type: "renovate_trigger_choice",
			threadId: "t1",
			marker: "x",
			line: "y",
			message: "z",
			recentChanges: "- [eu-onboarding] elastic_agent changed on 2026-08-01 (applied)",
			priorTriggers: "- Renovate update triggered on eu-onboarding for 'renovate/eu-onboarding-elastic_agent'.",
		});
		expect(parsed.success).toBe(true);
		if (parsed.success && parsed.data.type === "renovate_trigger_choice") {
			expect(parsed.data.recentChanges).toContain("elastic_agent changed");
			expect(parsed.data.priorTriggers).toContain("Renovate update triggered");
		}
	});

	test("still accepts the event when recentChanges/priorTriggers are absent (older/degraded payload)", () => {
		const parsed = StreamEventSchema.safeParse({
			type: "renovate_trigger_choice",
			threadId: "t1",
			marker: "x",
			line: "y",
			message: "z",
		});
		expect(parsed.success).toBe(true);
	});
});
