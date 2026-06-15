// agent/src/iac/capability-message.test.ts
import { describe, expect, test } from "bun:test";
import { capabilityMessage, parseIntentJson } from "./nodes.ts";

// SIO-912: a request that resolves to workflow "other" has no proposer and must be
// short-circuited with a capability message instead of falling through to the (removed)
// local-terraform path. These cover the pure pieces of that behavior; the routing itself
// is a parseIntent -> END edge (graph.test.ts asserts the graph compiles).
describe("capabilityMessage", () => {
	const msg = capabilityMessage();

	test("states the propose-only / never-runs-terraform contract", () => {
		expect(msg).toContain("merge request");
		expect(msg.toLowerCase()).toContain("never run terraform");
	});

	test("lists the three live config-edit workflows", () => {
		expect(msg).toContain("Version upgrades");
		expect(msg).toContain("Tier resizes");
		expect(msg).toContain("ILM lifecycle changes");
	});

	test("explains a Fleet agent BINARY upgrade is a different, not-yet-wired path", () => {
		expect(msg).toContain("Fleet");
		// must distinguish the binary upgrade from a Terraform config change
		expect(msg.toLowerCase()).toContain("not a terraform config change");
	});

	test("does not promise to run a plan locally or mention a pre-check", () => {
		expect(msg.toLowerCase()).not.toContain("pre-check");
	});
});

describe("parseIntentJson — the 'other' fall-through that SIO-912 intercepts", () => {
	test("an un-actionable request parses to workflow 'other'", () => {
		// "upgrade all Elastic agents ... to 9.4.2" is a Fleet binary upgrade -> not one of the
		// three config-edit workflows; the planner emits "other".
		const req = parseIntentJson(JSON.stringify({ workflow: "other", cluster: "eu-b2b" }));
		expect(req.workflow).toBe("other");
	});

	test("malformed planner output also lands on 'other' (the safe default)", () => {
		expect(parseIntentJson("not json").workflow).toBe("other");
	});
});
