// tests/unit/utils/securityEnhancer.test.ts

import { describe, expect, test } from "bun:test";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { SecurityEnhancer } from "../../../src/utils/securityEnhancer.js";

const enhancer = new SecurityEnhancer();

describe("SecurityEnhancer field-path exemptions", () => {
	test("ILM nextStep.phase: 'delete' is allowed (defect 6)", () => {
		const input = {
			index: "partial-.ds-logs-system.syslog-default-2025.07.01-000001",
			currentStep: { phase: "frozen", action: "complete", name: "complete" },
			nextStep: { phase: "delete", action: "complete", name: "complete" },
		};

		const { violations } = enhancer.validateAndSanitizeInput("elasticsearch_ilm_move_to_step", input);
		const blockingPhase = violations.filter((v) => v.field === "nextStep.phase" || v.field === "currentStep.phase");
		expect(blockingPhase).toHaveLength(0);
	});

	test("processor tag with 'drop' word is allowed (defect 8)", () => {
		const input = {
			id: "logs-system.syslog@custom",
			processors: [{ drop: { if: "ctx.year > 2025", ignore_failure: true, tag: "drop-future-dated-syslog" } }],
		};

		const { violations } = enhancer.validateAndSanitizeInput("elasticsearch_put_ingest_pipeline", input);
		const blockingTag = violations.filter((v) => v.field?.endsWith(".tag"));
		expect(blockingTag).toHaveLength(0);
	});

	test("_meta values containing keywords are allowed (defect 9)", () => {
		const input = {
			id: "logs-system.syslog@custom",
			_meta: {
				managed: false,
				purpose: "Drop future-dated syslog docs - year-parser bug at year boundary. Added 2026-04-21.",
			},
			processors: [{ set: { field: "x", value: "y" } }],
		};

		const { violations } = enhancer.validateAndSanitizeInput("elasticsearch_put_ingest_pipeline", input);
		const blockingMeta = violations.filter((v) => v.field?.startsWith("_meta."));
		expect(blockingMeta).toHaveLength(0);
	});

	test("Painless script fields still pass through unchanged", () => {
		const input = {
			id: "p1",
			processors: [{ script: { source: "ctx.field = ctx.field?.toLowerCase() ?: 'unknown'", lang: "painless" } }],
		};

		const { violations } = enhancer.validateAndSanitizeInput("elasticsearch_put_ingest_pipeline", input);
		const blockingScript = violations.filter((v) => v.field?.endsWith(".source") || v.field?.endsWith(".lang"));
		expect(blockingScript).toHaveLength(0);
	});

	test("ILM phase 'frozen' is allowed (legitimate enum value)", () => {
		const input = {
			index: "test-index",
			currentStep: { phase: "hot", action: "rollover", name: "check-rollover-ready" },
			nextStep: { phase: "frozen", action: "complete", name: "complete" },
		};

		const { violations } = enhancer.validateAndSanitizeInput("elasticsearch_ilm_move_to_step", input);
		expect(violations.filter((v) => v.severity === "critical")).toHaveLength(0);
	});

	test("Real injection on a non-exempt field is still blocked", () => {
		const input = {
			id: "p1",
			processors: [{ rename: { field: "old", target_field: "new'; DROP TABLE users; --" } }],
		};

		expect(() => enhancer.validateAndSanitizeInput("elasticsearch_put_ingest_pipeline", input)).toThrow(McpError);
	});

	test("Injection inside a tag value is now allowed (intentional trade-off)", () => {
		const input = {
			id: "p1",
			processors: [{ drop: { if: "true", tag: "DROP TABLE users" } }],
		};

		const { violations } = enhancer.validateAndSanitizeInput("elasticsearch_put_ingest_pipeline", input);
		expect(violations.filter((v) => v.field?.endsWith(".tag"))).toHaveLength(0);
	});
});
