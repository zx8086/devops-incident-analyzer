// packages/agent/src/resolve-identifiers-workflow-handlers.ts
//
// SIO-1353: preset-workflow execution path for the resolveIdentifiers node --
// the FIRST production wiring of the skillflow executor. A sub-agent's
// workflows/resolve-identifiers.yaml declares WHICH discovery tools run in
// WHAT order; this module runs that plan through runWorkflow. Parsing,
// matching, bounding, and dynamic second hops stay in resolve-identifiers.ts:
// the datasource's assemble function (and the tool/timeout primitives) are
// injected via PresetProbeDeps, so this module never imports from
// resolve-identifiers.ts (no cycle) and stays generic for Phase 3 (SIO-1354).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadWorkflows, type WorkflowDef } from "@devops-agent/gitagent-bridge";
import { getLogger } from "@devops-agent/observability";
import { runWorkflow } from "@devops-agent/skillflow";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { getAgentsDir } from "./paths.ts";
import { normalizeToolContent } from "./sub-agent.ts";

const logger = getLogger("agent:resolveIdentifiersPresets");

// Default OFF (inverse idiom of RESOLVE_IDENTIFIERS_ENABLED): the preset path
// is the new-behavior opt-in until SIO-1355 flips it after live parity
// verification. When OFF -- or when a datasource ships no preset -- the legacy
// probe runs unchanged.
export function isResolvePresetsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.RESOLVE_IDENTIFIERS_PRESETS_ENABLED;
	return v === "true" || v === "1";
}

export interface PresetProbeDeps {
	toolFor: (dataSourceId: string, name: string) => StructuredToolInterface | undefined;
	withTimeout: <T>(p: Promise<T>, ms: number) => Promise<T>;
	timeoutMs: number;
	// Datasource assembly: receives the assemble node-step's template-resolved
	// inputs (raw tool text keyed per the YAML `with:` map; "" marks a failed or
	// absent branch per SIO-1356 placeholder seeding) and returns the
	// ResolvedIdentifiers fragment to merge.
	assemble: (raws: Record<string, string>) => Promise<unknown>;
}

// Preset defs are re-read per call: a cheap YAML parse of one small file, and
// git-versioned workflow edits take effect without threading LoadedAgent
// through the graph node (plan decision, SIO-1353). A load failure never
// fails the turn -- it falls back to the legacy probe.
function loadPresetDef(subAgentDirName: string, presetName: string): WorkflowDef | undefined {
	const dir = join(getAgentsDir("incident-analyzer"), "agents", subAgentDirName);
	if (!existsSync(join(dir, "workflows"))) return undefined;
	try {
		return loadWorkflows(dir).get(presetName);
	} catch (err) {
		logger.warn(
			{ subAgentDirName, presetName, error: err instanceof Error ? err.message : String(err) },
			"preset workflow load failed; falling back to legacy probe",
		);
		return undefined;
	}
}

// Runs the named preset for one datasource and returns the assemble step's
// fragment. Returns undefined when the preset is absent/unloadable so the
// caller can fall back to the legacy probe; returns {} when the preset ran but
// its load-bearing branch failed (matching the legacy probe's early-return).
// Throwing is fine -- the caller wraps this in catchOnlyProbe.
export async function runResolvePreset(
	dataSourceId: string,
	subAgentDirName: string,
	presetName: string,
	deps: PresetProbeDeps,
): Promise<unknown | undefined> {
	const def = loadPresetDef(subAgentDirName, presetName);
	if (!def) return undefined;

	let fragment: unknown = {};
	const result = await runWorkflow(def, {
		handlers: {
			// A tool step is one discovery invocation: bind the named MCP tool for
			// this datasource, give it its own probe-timeout budget (SIO-1332 idiom:
			// per-branch, never one clock across the whole run), and expose the
			// normalized text as the step's single `raw` output.
			tool: async (resolved) => {
				const tool = deps.toolFor(dataSourceId, resolved.target);
				if (!tool) throw new Error(`preset tool "${resolved.target}" not bound for ${dataSourceId}`);
				const raw = await deps.withTimeout(Promise.resolve(tool.invoke(resolved.inputs)), deps.timeoutMs);
				return { raw: normalizeToolContent(raw) };
			},
			// The single node step is the datasource's assemble function: parsing,
			// bounding, guards, and any dynamic second hop -- code, not YAML.
			node: async (resolved) => {
				fragment = await deps.assemble(resolved.inputs);
				return { result: JSON.stringify(fragment) };
			},
		},
	});

	const assembleRan = result.steps.some((s) => s.kind === "node" && s.status === "ok");
	if (!assembleRan) {
		// The load-bearing branch failed (fail-fast broke the run before assemble)
		// or the assemble handler itself threw: degrade exactly like the legacy
		// probe's "scopes probe failed" early-return.
		logger.warn(
			{ dataSourceId, workflow: def.name, ok: result.ok },
			"preset assemble step did not complete; omitting this datasource",
		);
		return {};
	}
	return fragment;
}
