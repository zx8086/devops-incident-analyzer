// gitagent-bridge/src/model-registry.test.ts

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadAgent } from "./manifest-loader.ts";
import { getModelCapabilities, isKnownModel, MODEL_REGISTRY } from "./model-registry.ts";

const REPO_ROOT = join(import.meta.dir, "../../..");
const AGENTS_DIR = join(REPO_ROOT, "agents/incident-analyzer");
const ELASTIC_IAC_DIR = join(REPO_ROOT, "agents/elastic-iac");
const SUB_AGENT_IDS = ["elastic", "kafka", "capella", "konnect", "gitlab", "atlassian", "aws"];

describe("MODEL_REGISTRY", () => {
	// THE divergence detector, and the reason this file exists. SIO-1213 added two
	// new-generation models to MODEL_MAP without touching llm.ts's separate
	// NO_TEMPERATURE_MODEL_MARKERS list; every sub-agent invocation then failed in production
	// with "`temperature` is deprecated for this model" and SIO-1214 retrofitted the second
	// list after the fact.
	//
	// The marker list survives HERE ONLY, as an independent oracle. Production reads
	// MODEL_REGISTRY.acceptsTemperature; this asserts the declaration agrees with the known
	// generation rule, so declaring a new-generation model `true` fails on the pull request
	// instead of on the first live call.
	const NEW_GENERATION_MARKERS = [
		"claude-sonnet-5",
		"claude-opus-4-7",
		"claude-opus-4-8",
		"claude-opus-5",
		"claude-fable-5",
		"claude-mythos-5",
	];

	test("acceptsTemperature agrees with the 4.7+/5-generation rule for every entry", () => {
		for (const [name, caps] of Object.entries(MODEL_REGISTRY)) {
			const looksNewGeneration = NEW_GENERATION_MARKERS.some((m) => caps.bedrockId.includes(m));
			expect(caps.acceptsTemperature, `${name} (${caps.bedrockId})`).toBe(!looksNewGeneration);
		}
	});

	// Turns "bump the YAML, forget the registry" from a first-invoke production throw into a
	// PR failure. Covers all nine manifests: two orchestrators plus the seven sub-agents whose
	// model blocks the light tier borrows.
	test("every model referenced by an agent.yaml is a registry key", () => {
		const manifests = [loadAgent(AGENTS_DIR), loadAgent(ELASTIC_IAC_DIR)];
		const referenced: Array<{ where: string; name: string }> = [];

		for (const agent of manifests) {
			const model = agent.manifest.model;
			if (model?.preferred) referenced.push({ where: `${agent.manifest.name}.preferred`, name: model.preferred });
			for (const fb of model?.fallback ?? []) {
				referenced.push({ where: `${agent.manifest.name}.fallback`, name: fb });
			}
		}

		const orchestrator = manifests[0];
		for (const id of SUB_AGENT_IDS) {
			const sub = orchestrator?.subAgents.get(`${id}-agent`);
			if (!sub) continue;
			const model = sub.manifest.model;
			if (model?.preferred) referenced.push({ where: `${id}-agent.preferred`, name: model.preferred });
			for (const fb of model?.fallback ?? []) referenced.push({ where: `${id}-agent.fallback`, name: fb });
		}

		expect(referenced.length).toBeGreaterThan(2);
		for (const { where, name } of referenced) {
			expect(isKnownModel(name), `${where} references unknown model "${name}"`).toBe(true);
		}
	});

	// The mechanical link to SIO-1224: a capability claim must be backed by a committed probe.
	test("a declared probe report exists on disk", () => {
		for (const [name, caps] of Object.entries(MODEL_REGISTRY)) {
			if (caps.probeReport === null) continue;
			expect(caps.verifiedAt, `${name}.verifiedAt`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(caps.verifiedRegion.length, `${name}.verifiedRegion`).toBeGreaterThan(0);
			expect(existsSync(join(REPO_ROOT, caps.probeReport)), `${name}: missing ${caps.probeReport}`).toBe(true);
		}
	});

	// The other half of provenance: an unprobed entry may exist for rollback, but nothing may
	// POINT at it. This is what stops a manifest being bumped to a model no one has measured.
	test("every model an agent.yaml uses has been probed", () => {
		const inUse = new Set<string>();
		for (const dir of [AGENTS_DIR, ELASTIC_IAC_DIR]) {
			const agent = loadAgent(dir);
			if (agent.manifest.model?.preferred) inUse.add(agent.manifest.model.preferred);
			for (const fb of agent.manifest.model?.fallback ?? []) inUse.add(fb);
			// SIO-1235: sub-agent manifests are LIVE as of this ticket -- createLlm("subAgent", ...)
			// resolves each specialist's own model.preferred instead of the root's. Before that they
			// were dead config (since the 125b3f9e scaffold), so this loop covered root manifests
			// only and a specialist could have been pointed at an unmeasured model with nothing to
			// catch it. claude-haiku-4-5 has a probe report so this passes today; the point is to
			// guard the NEXT per-specialist bump, which this ticket makes a one-line yaml edit.
			for (const sub of agent.subAgents.values()) {
				if (sub.manifest.model?.preferred) inUse.add(sub.manifest.model.preferred);
				for (const fb of sub.manifest.model?.fallback ?? []) inUse.add(fb);
			}
		}
		for (const name of inUse) {
			const caps = getModelCapabilities(name);
			expect(caps.probeReport, `${name} is referenced by a manifest but has no probe report`).not.toBeNull();
		}
	});

	test("getModelCapabilities throws with the available list for an unknown model", () => {
		expect(() => getModelCapabilities("claude-nonexistent-9")).toThrow(/Unknown model "claude-nonexistent-9"/);
		expect(() => getModelCapabilities("claude-nonexistent-9")).toThrow(/claude-sonnet-5/);
	});

	test("isKnownModel narrows only real keys", () => {
		expect(isKnownModel("claude-sonnet-5")).toBe(true);
		expect(isKnownModel("claude-nonexistent-9")).toBe(false);
		// Must not be fooled by inherited Object.prototype members.
		expect(isKnownModel("toString")).toBe(false);
		expect(isKnownModel("constructor")).toBe(false);
	});
});
