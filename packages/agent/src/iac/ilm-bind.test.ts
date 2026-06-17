// agent/src/iac/ilm-bind.test.ts
// SIO-933: ilm-rollout optional component-template bind. setComponentTemplateLifecycleName is the
// pure read-modify-write helper; proposer-level behavior (bind/404/no-op/multi-file) lives in
// ilm-rollout.test.ts. Mirrors the setClusterDefaultShards unit-test style.
import { describe, expect, test } from "bun:test";
import { setComponentTemplateLifecycleName } from "./nodes.ts";

// Real sparse component-template shape (verified against the live IaC repo):
// environments/<cluster>/cluster-defaults/<name>.json carries `name` + a sparse `settings.index`.
const SPARSE_TEMPLATE = JSON.stringify(
	{ name: "traces-generic.otel@custom", settings: { index: { codec: "best_compression" } } },
	null,
	2,
);

describe("setComponentTemplateLifecycleName (SIO-933)", () => {
	test("adds settings.index.lifecycle.name, preserves other settings", () => {
		const out = setComponentTemplateLifecycleName(SPARSE_TEMPLATE, "eu-otel-logs-lifecycle-prod");
		const obj = JSON.parse(out.content);
		expect(obj.settings.index.lifecycle.name).toBe("eu-otel-logs-lifecycle-prod");
		// existing sibling setting is untouched
		expect(obj.settings.index.codec).toBe("best_compression");
		// the template's own name is NOT the policy name -- only the lifecycle binding changes
		expect(obj.name).toBe("traces-generic.otel@custom");
		expect(out.changed).toBe(true);
		expect(out.previous).toBeUndefined();
	});

	test("captures the previous lifecycle name when rebinding", () => {
		const existing = JSON.stringify({
			name: "logs-generic.otel@custom",
			settings: { index: { lifecycle: { name: "old-policy" } } },
		});
		const out = setComponentTemplateLifecycleName(existing, "new-policy");
		expect(JSON.parse(out.content).settings.index.lifecycle.name).toBe("new-policy");
		expect(out.previous).toBe("old-policy");
		expect(out.changed).toBe(true);
	});

	test("no-op when the template already points at the policy", () => {
		const existing = JSON.stringify({
			name: "logs-generic.otel@custom",
			settings: { index: { lifecycle: { name: "same-policy" } } },
		});
		const out = setComponentTemplateLifecycleName(existing, "same-policy");
		expect(out.changed).toBe(false);
		expect(out.previous).toBe("same-policy");
	});

	test("throws on non-object JSON", () => {
		expect(() => setComponentTemplateLifecycleName("[]", "x")).toThrow("component-template JSON is not an object");
		expect(() => setComponentTemplateLifecycleName("42", "x")).toThrow();
	});

	test("preserves 2-space indent + trailing newline", () => {
		const out = setComponentTemplateLifecycleName(SPARSE_TEMPLATE, "p");
		expect(out.content.endsWith("\n")).toBe(true);
		expect(out.content).toContain('\n  "settings"');
	});
});
