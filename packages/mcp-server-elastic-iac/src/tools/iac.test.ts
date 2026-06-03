// src/tools/iac.test.ts
import { describe, expect, test } from "bun:test";
import { parsePlanTranscript } from "./iac.ts";

// SIO-882: iac_plan returns the tfplan-report shape; parsePlanTranscript must read both
// the repo's machine JSON output and terraform's human plan summary, tolerating run()'s
// trailing "[exit N]".
describe("parsePlanTranscript", () => {
	test("parses the tfplan-report JSON shape (with the exit suffix)", () => {
		const out = `${JSON.stringify({
			create: 1,
			update: 2,
			delete: 0,
			resources: [{ address: "elasticstack_x.y", actions: ["update"] }],
		})}\n[exit 2]`;
		const r = parsePlanTranscript(out);
		expect(r).not.toBeNull();
		expect(r?.create).toBe(1);
		expect(r?.update).toBe(2);
		expect(r?.delete).toBe(0);
		expect(r?.resources).toHaveLength(1);
	});

	test("parses terraform's human plan summary line", () => {
		const out = "Terraform will perform the following actions...\nPlan: 3 to add, 1 to change, 2 to destroy.\n[exit 2]";
		expect(parsePlanTranscript(out)).toEqual({ create: 3, update: 1, delete: 2, resources: [] });
	});

	test("treats no-changes phrasing as zero drift", () => {
		const out = "No changes. Your infrastructure matches the configuration.\n[exit 0]";
		expect(parsePlanTranscript(out)).toEqual({ create: 0, update: 0, delete: 0, resources: [] });
	});

	test("returns null for unrecognized output", () => {
		expect(parsePlanTranscript("task: command not found\n[exit 127]")).toBeNull();
	});
});
