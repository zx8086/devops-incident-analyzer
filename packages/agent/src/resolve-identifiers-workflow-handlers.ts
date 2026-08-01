// packages/agent/src/resolve-identifiers-workflow-handlers.ts
//
// SIO-1353/SIO-1354: preset-workflow execution path for the resolveIdentifiers
// node -- the first production wiring of the skillflow executor. A sub-agent's
// workflows/resolve-identifiers.yaml declares WHICH discovery tools run in
// WHAT order; this module runs that plan through runWorkflow. Parsing,
// matching, bounding, and dynamic second hops stay in resolve-identifiers.ts:
// the datasource's node functions (and the tool/timeout primitives) are
// injected via PresetProbeDeps, so this module never imports from
// resolve-identifiers.ts (no cycle) and stays datasource-generic.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadWorkflows, type WorkflowDef } from "@devops-agent/gitagent-bridge";
import { getLogger } from "@devops-agent/observability";
import { runWorkflow } from "@devops-agent/skillflow";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { getAgentsDir } from "./paths.ts";
import { normalizeToolContent } from "./sub-agent.ts";

const logger = getLogger("agent:resolveIdentifiersPresets");

// SIO-1355: default ON for every preset-eligible datasource, after live parity
// verification (elastic/couchbase/gitlab/aws: healthy-run + soft-fail proof
// this session; kafka/konnect: covered by the SIO-1354 parity suite, live
// verification is a fast-follow). List-valued, mirroring bindingsReadDatasources
// (resolve-identifiers.ts): "true"/"1"/"all" opts every datasource in; a
// comma-separated list opts only the named datasources in; "false"/"0" opts
// none in (the escape hatch for a wholesale regression). Unset uses the
// default below rather than off, so removing the env var is a no-op, not a
// silent revert to the legacy probe. When OFF for a datasource -- or when
// that datasource ships no preset -- the legacy probe runs unchanged.
//
// Zod normalizes case/whitespace once, up front (no .default(): an unset var
// and an explicitly blank one both fall through to DEFAULT_PRESET_DATASOURCES
// via the same empty-string check, matching the pre-Zod behavior exactly --
// including case-insensitive "TRUE"/"All"/etc, which the raw string-literal
// comparisons before this change missed).
const DEFAULT_PRESET_DATASOURCES = "all";
const presetFlagSchema = z
	.string()
	.optional()
	.transform((raw) => {
		const trimmed = raw?.trim().toLowerCase();
		return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_PRESET_DATASOURCES;
	});

export function isResolvePresetsEnabled(dataSourceId: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const value = presetFlagSchema.parse(env.RESOLVE_IDENTIFIERS_PRESETS_ENABLED);
	if (value === "false" || value === "0") return false;
	if (value === "true" || value === "1" || value === "all") return true;
	return value
		.split(",")
		.map((s) => s.trim())
		.includes(dataSourceId.toLowerCase());
}

// A node step either exposes outputs for downstream templating (mid-flow
// selection, e.g. konnect's control-plane pick) or terminates the flow with
// the ResolvedIdentifiers fragment (the final assemble step).
export type PresetNodeResult = { outputs: Record<string, string> } | { fragment: unknown };
export type PresetNodeFn = (inputs: Record<string, string>) => Promise<PresetNodeResult>;

export interface PresetProbeDeps {
	toolFor: (dataSourceId: string, name: string) => StructuredToolInterface | undefined;
	withTimeout: <T>(p: Promise<T>, ms: number) => Promise<T>;
	timeoutMs: number;
	// Node-step functions keyed by the YAML `node:` target. Inputs are the
	// step's template-resolved strings ("" marks a failed/absent upstream branch
	// per SIO-1356 placeholder seeding).
	nodes: Record<string, PresetNodeFn>;
	// Optional ${{ trigger.* }} payload for runtime parameters the YAML cannot
	// know (focus-derived search terms etc.). "" values are legitimate: the
	// tool-arg conversion below omits empty args.
	trigger?: Record<string, string>;
	// SIO-1354 "multiplied step": when set, every tool step's single declared
	// invocation runs once per target (elastic deployment / aws estate) -- in
	// PARALLEL, each branch in its own timeout and context wrapper, mirroring
	// the legacy probes' per-branch SIO-1326 semantics. The step's raw output
	// becomes a JSON branch envelope { branches: [{ target, ok, raw?, error? }] }
	// that the assemble node unpacks. The target list is runtime env config and
	// deliberately cannot live in the YAML.
	multiply?: {
		targets: string[];
		wrap: (target: string, fn: () => Promise<unknown>) => Promise<unknown>;
	};
}

export interface MultipliedBranch {
	target: string;
	ok: boolean;
	raw?: string;
	error?: string;
}

// Per-branch payload bound for the multiplied envelope (CodeRabbit on PR #575).
// Legitimate discovery responses are tiny (size:0 aggs, limit-50 lists); a
// branch beyond this is pathological (e.g. a misrouted full-hits response).
// Truncating the string would silently corrupt the JSON the assemble parsers
// read, so an oversized branch becomes a FAILED branch instead -- it lands in
// unresolvedDeployments/unresolvedEstates as inconclusive coverage (SIO-1328),
// never as silently-partial data.
export const MAX_BRANCH_RAW_BYTES = 1_048_576;

// YAML `with:` values are strings by schema; real tools take typed args. The
// convention (mirror of skillFlowToWorkflowDef's stringifySkillFlowInput):
// each value is JSON-parsed when it parses ("500" -> 500, "true" -> true),
// else kept as the raw string ("pvhcorp", UUIDs). An empty string is OMITTED
// entirely -- that is how an optional arg (e.g. a focus filter with no token
// this turn) declares itself absent, matching the legacy probes' conditional
// arg construction. Caveat: an arg whose LEGITIMATE value is a numeric string
// would coerce to a number -- none of the shipped presets has one; prefer
// renaming/wrapping such an arg over weakening this convention.
export function toToolArgs(inputs: Record<string, string>): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(inputs)) {
		if (value === "") continue;
		try {
			args[key] = JSON.parse(value);
		} catch {
			args[key] = value;
		}
	}
	return args;
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

// Runs the named preset for one datasource and returns the terminal node
// step's fragment. Returns undefined when the preset is absent/unloadable so
// the caller can fall back to the legacy probe; returns {} when the preset ran
// but no node step produced a fragment (a load-bearing branch failed and
// fail-fast broke the run) -- matching the legacy probes' early-returns.
// Throwing is fine: the caller wraps this in catchOnlyProbe.
export async function runResolvePreset(
	dataSourceId: string,
	subAgentDirName: string,
	presetName: string,
	deps: PresetProbeDeps,
): Promise<unknown | undefined> {
	const def = loadPresetDef(subAgentDirName, presetName);
	if (!def) return undefined;

	let fragment: unknown;
	let hasFragment = false;
	const result = await runWorkflow(def, {
		trigger: deps.trigger,
		handlers: {
			// A tool step is one discovery invocation: bind the named MCP tool for
			// this datasource, give it its own probe-timeout budget (SIO-1332 idiom:
			// per-branch, never one clock across the whole run), and expose the
			// normalized text as the step's single `raw` output.
			tool: async (resolved) => {
				const tool = deps.toolFor(dataSourceId, resolved.target);
				if (!tool) throw new Error(`preset tool "${resolved.target}" not bound for ${dataSourceId}`);
				const args = toToolArgs(resolved.inputs);
				if (deps.multiply) {
					const { targets, wrap } = deps.multiply;
					const settled = await Promise.allSettled(
						targets.map((target) =>
							deps.withTimeout(Promise.resolve(wrap(target, () => Promise.resolve(tool.invoke(args)))), deps.timeoutMs),
						),
					);
					const branches: MultipliedBranch[] = settled.map((r, i) => {
						const target = targets[i] ?? "";
						if (r.status !== "fulfilled") {
							return { target, ok: false, error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
						}
						const branchRaw = normalizeToolContent(r.value);
						if (branchRaw.length > MAX_BRANCH_RAW_BYTES) {
							return {
								target,
								ok: false,
								error: `branch payload ${branchRaw.length} bytes exceeds ${MAX_BRANCH_RAW_BYTES}; treating coverage as inconclusive`,
							};
						}
						return { target, ok: true, raw: branchRaw };
					});
					return { raw: JSON.stringify({ branches }) };
				}
				const raw = await deps.withTimeout(Promise.resolve(tool.invoke(args)), deps.timeoutMs);
				return { raw: normalizeToolContent(raw) };
			},
			// Node steps are the datasource's code: selection/assembly functions
			// registered under the YAML `node:` target name.
			node: async (resolved) => {
				const fn = deps.nodes[resolved.target];
				if (!fn) throw new Error(`preset node "${resolved.target}" not bound for ${dataSourceId}`);
				const res = await fn(resolved.inputs);
				if ("fragment" in res) {
					fragment = res.fragment;
					hasFragment = true;
					return { result: JSON.stringify(res.fragment) };
				}
				return res.outputs;
			},
		},
	});

	if (!hasFragment) {
		// A load-bearing branch failed (fail-fast broke the run before the
		// terminal node) or a selection node found nothing and threw: degrade
		// exactly like the legacy probe's early-return.
		logger.warn(
			{ dataSourceId, workflow: def.name, ok: result.ok },
			"preset produced no fragment; omitting this datasource",
		);
		return {};
	}
	return fragment;
}
