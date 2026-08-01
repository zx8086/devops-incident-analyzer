// gitagent-bridge/src/subagent-workflows.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgent } from "./manifest-loader.ts";

// SIO-1352: workflows/ loads for every agent tier so sub-agents can ship preset
// workflows (e.g. resolve-identifiers presets). hooks/memory stay root-only;
// that split is covered in shared-merge.test.ts.

const WORKFLOW_YAML = `name: sub-preset
version: 0.1.0
description: sub-agent preset workflow
steps:
  - name: probe
    tool: some_tool
    outputs:
      - raw
`;

function writeManifest(dir: string, name: string, extra = ""): void {
	writeFileSync(join(dir, "agent.yaml"), `name: ${name}\nversion: 0.1.0\ndescription: test agent\n${extra}`);
}

describe("sub-agent workflows loading (SIO-1352)", () => {
	const roots: string[] = [];
	afterAll(() => {
		for (const r of roots) rmSync(r, { recursive: true, force: true });
	});

	function makeTree(): string {
		const root = mkdtempSync(join(tmpdir(), "gitagent-subwf-"));
		roots.push(root);
		writeManifest(root, "root-agent", "agents:\n  subby: {}\n");
		const subDir = join(root, "agents", "subby");
		mkdirSync(join(subDir, "workflows"), { recursive: true });
		writeManifest(subDir, "subby-agent");
		return root;
	}

	test("a sub-agent's workflows/*.yaml loads into its LoadedAgent", () => {
		const root = makeTree();
		writeFileSync(join(root, "agents", "subby", "workflows", "preset.yaml"), WORKFLOW_YAML);
		const agent = loadAgent(root);
		const sub = agent.subAgents.get("subby");
		expect(sub).toBeDefined();
		expect(sub?.workflows.has("sub-preset")).toBe(true);
		expect(sub?.workflows.get("sub-preset")?.steps[0]?.tool).toBe("some_tool");
		// hooks/memory stay root-only
		expect(sub?.hooks).toBeUndefined();
		expect(sub?.memory).toBeUndefined();
	});

	test("a sub-agent without workflows/ loads an empty map", () => {
		const root = makeTree();
		const agent = loadAgent(root);
		expect(agent.subAgents.get("subby")?.workflows.size).toBe(0);
	});

	test("a malformed sub-agent workflow fails agent load loudly", () => {
		const root = makeTree();
		// steps: [] violates WorkflowSchema's .min(1)
		writeFileSync(
			join(root, "agents", "subby", "workflows", "broken.yaml"),
			"name: broken\nversion: 0.1.0\ndescription: no steps\nsteps: []\n",
		);
		expect(() => loadAgent(root)).toThrow(/broken\.yaml/);
	});
});
