// skillflow/src/preset-workflows-gate.test.ts
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: SIO-1352 - tests literal SkillsFlow ${{ }} template tokens, not JS template strings
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflows, type WorkflowDef } from "@devops-agent/gitagent-bridge";
import { runWorkflow } from "./executor.ts";

// SIO-1352 CI gate: every workflow shipped under agents/ (root agents AND
// sub-agents) must load and dry-run cleanly. loadWorkflows throws at agent
// boot on a malformed file, independent of any runtime flag, so this test
// surfaces the failure in CI instead of at first boot in an environment. The
// dry run additionally validates the DAG (cycles, unknown depends_on) and the
// ${{ steps.X.outputs.Y }} template wiring (undeclared references throw).

const AGENTS_ROOT = join(import.meta.dir, "../../../agents");

function isAgentDir(dir: string): boolean {
	return existsSync(join(dir, "agent.yaml"));
}

function listDirs(dir: string): string[] {
	if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
	return readdirSync(dir)
		.map((entry) => join(dir, entry))
		.filter((p) => statSync(p).isDirectory());
}

// Root agents (agents/<name>) plus one nesting level of sub-agents
// (agents/<name>/agents/<sub>) -- the recursion depth in use today.
function allAgentDirs(): string[] {
	const rootAgents = listDirs(AGENTS_ROOT).filter(isAgentDir);
	const subAgents = rootAgents.flatMap((dir) => listDirs(join(dir, "agents")).filter(isAgentDir));
	return [...rootAgents, ...subAgents];
}

// Trigger/inputs payloads are runtime values, definitionally unknowable from
// the YAML alone -- synthesize an empty-string entry for every trigger.X /
// inputs.X the def references so the dry run stays strict about steps.*
// wiring without failing on legitimate runtime parameters.
function syntheticPayloads(def: WorkflowDef): {
	trigger: Record<string, string>;
	inputs: Record<string, string>;
} {
	const trigger: Record<string, string> = {};
	const inputs: Record<string, string> = {};
	for (const step of def.steps) {
		for (const value of Object.values(step.with ?? {})) {
			for (const match of value.matchAll(/\$\{\{\s*(trigger|inputs)\.([^}\s]+?)\s*\}\}/g)) {
				const [, namespace, key] = match;
				if (!key) continue;
				if (namespace === "trigger") trigger[key] = "";
				else inputs[key] = "";
			}
		}
	}
	return { trigger, inputs };
}

describe("preset workflow CI gate (SIO-1352)", () => {
	const defs: Array<{ dir: string; def: WorkflowDef }> = [];
	for (const dir of allAgentDirs()) {
		for (const def of loadWorkflows(dir).values()) defs.push({ dir, def });
	}

	test("repo ships at least the three known root workflows", () => {
		const names = defs.map((d) => d.def.name);
		expect(names).toContain("incident-triage");
		expect(names.length).toBeGreaterThanOrEqual(3);
	});

	for (const { dir, def } of defs) {
		const agentPath = dir.slice(AGENTS_ROOT.length + 1);
		test(`dry-runs cleanly: ${agentPath} / ${def.name}`, async () => {
			const { trigger, inputs } = syntheticPayloads(def);
			const result = await runWorkflow(def, { handlers: {}, trigger, inputs, dryRun: true });
			expect(result.ok).toBe(true);
			expect(result.steps.length).toBe(def.steps.length);
		});
	}
});

describe("the gate catches broken workflows (red fixtures)", () => {
	const roots: string[] = [];
	afterAll(() => {
		for (const r of roots) rmSync(r, { recursive: true, force: true });
	});

	function tempAgentDir(workflowYaml: string): string {
		const root = mkdtempSync(join(tmpdir(), "skillflow-gate-"));
		roots.push(root);
		mkdirSync(join(root, "workflows"), { recursive: true });
		writeFileSync(join(root, "workflows", "fixture.yaml"), workflowYaml);
		return root;
	}

	async function dryRunThrew(def: WorkflowDef): Promise<boolean> {
		// Not expect(...).rejects: bun's rejects matcher can hang on sync-throwing
		// async fns in this suite shape; a plain try/await/catch is unambiguous.
		try {
			await runWorkflow(def, { handlers: {}, dryRun: true });
			return false;
		} catch {
			return true;
		}
	}

	test("malformed YAML throws at load (the agent-boot failure class)", () => {
		const dir = tempAgentDir("name: broken\nversion: 0.1.0\ndescription: no steps\nsteps: []\n");
		expect(() => loadWorkflows(dir)).toThrow(/fixture\.yaml/);
	});

	test("undeclared template reference throws in dry run", async () => {
		const dir = tempAgentDir(
			[
				"name: bad-template",
				"version: 0.1.0",
				"description: references an output step_a never declares",
				"steps:",
				"  - name: step_a",
				"    tool: tool_a",
				"    outputs:",
				"      - declared",
				"  - name: step_b",
				"    tool: tool_b",
				"    depends_on:",
				"      - step_a",
				"    with:",
				"      x: ${{ steps.step_a.outputs.undeclared }}",
				"",
			].join("\n"),
		);
		const def = loadWorkflows(dir).get("bad-template");
		expect(def).toBeDefined();
		expect(await dryRunThrew(def as WorkflowDef)).toBe(true);
	});

	test("dependency cycle throws in dry run", async () => {
		const dir = tempAgentDir(
			[
				"name: cyclic",
				"version: 0.1.0",
				"description: a depends on b depends on a",
				"steps:",
				"  - name: step_a",
				"    tool: tool_a",
				"    depends_on:",
				"      - step_b",
				"  - name: step_b",
				"    tool: tool_b",
				"    depends_on:",
				"      - step_a",
				"",
			].join("\n"),
		);
		const def = loadWorkflows(dir).get("cyclic");
		expect(def).toBeDefined();
		expect(await dryRunThrew(def as WorkflowDef)).toBe(true);
	});
});
