// agent/src/evidence-exec.ts
// SIO-1776: the two ways a sub-agent reaches the sandbox in @devops-agent/shared.
//
//   1. `_transform` on ANY bound tool: the model passes a function body WITH the tool call.
//      The full result is captured exactly as before (typed-finding extractors, persisted
//      state and search_evidence keep full fidelity); only the derived output enters the
//      model's context, and no extra ReAct turn is spent.
//   2. `run_js_on_evidence`: the same engine over results the run already captured, for
//      counts, group-bys and joins across several results.
//
// Applied at the agent's instrumentation boundary rather than inside each MCP server: the
// extractors need the raw result, it covers the proxied GitLab and Atlassian tools whose
// upstream code is not ours, it is one implementation instead of seven, and model-authored
// code stays out of the processes that hold datasource credentials.
import { createHash } from "node:crypto";
import { tool as createTool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

// SIO-1775: defaults ON, kill-switch semantics like every other capability flag
// (CLAUDE.md). Shipped opt-in in SIO-1776; flipped once verified against live Bedrock.
export function isEvidenceExecEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.EVIDENCE_EXEC_ENABLED?.toLowerCase();
	return v !== "false" && v !== "0";
}

// Structural, so this module and the instrumentation carry no static dependency on the
// QuickJS engine: runInSandbox from @devops-agent/shared/src/sandbox-exec.ts satisfies it.
export interface SandboxRunResult {
	stdout: string;
	truncated: boolean;
	error?: string;
	interrupted?: boolean;
	outOfMemory?: boolean;
	hostFailure?: boolean;
	durationMs: number;
	mode: string;
}
export type SandboxRunner = (
	code: string,
	evidence: Array<{ id: string; tool: string; json: string }>,
) => Promise<SandboxRunResult>;

export const TRANSFORM_PARAM = "_transform";
export const RUN_JS_TOOL_NAME = "run_js_on_evidence";

const TRANSFORM_DESCRIPTION =
	"Optional. JavaScript function body run over THIS call's full result in a sandbox; it receives `result`, parsed from the same JSON this tool would otherwise show you, and you see only what it returns, e.g. `return result.hits.hits.length`. Use it when you need a count, a filter or a few fields rather than the whole payload.";

// The model-facing schema gains the parameter; the underlying tool never sees it (it is
// stripped before invoke), so an MCP tool's own `additionalProperties: false` is unaffected.
export function withTransformParam(schema: unknown): unknown {
	if (!schema || typeof schema !== "object") return schema;
	const zodLike = schema as { extend?: (shape: Record<string, z.ZodTypeAny>) => unknown };
	if (typeof zodLike.extend === "function") {
		return zodLike.extend({ [TRANSFORM_PARAM]: z.string().optional().describe(TRANSFORM_DESCRIPTION) });
	}
	const json = schema as { type?: unknown; properties?: Record<string, unknown> };
	if (json.type !== "object") return schema;
	return {
		...json,
		properties: {
			...(json.properties ?? {}),
			[TRANSFORM_PARAM]: { type: "string", description: TRANSFORM_DESCRIPTION },
		},
	};
}

// Handles both shapes a tool is invoked with: LangGraph's { id, name, args, type } tool call
// and a bare args object. Returns the argument WITHOUT the parameter, so the loop-guard
// signature and the real call are identical to a call that never carried a transform.
export function splitTransform(arg: unknown): { arg: unknown; transform?: string } {
	if (!arg || typeof arg !== "object") return { arg };
	const outer = arg as Record<string, unknown>;
	const isToolCall = outer.args !== null && typeof outer.args === "object" && "name" in outer;
	const args = (isToolCall ? outer.args : outer) as Record<string, unknown>;
	const raw = args[TRANSFORM_PARAM];
	if (raw === undefined) return { arg };
	const { [TRANSFORM_PARAM]: _dropped, ...rest } = args;
	const transform = typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
	return { arg: isToolCall ? { ...outer, args: rest } : rest, transform };
}

// Returns the text when `content` is exactly the adapter's text+structuredContent wrapper
// (as an object, or as the JSON string a ToolMessage carries it in); null for anything else,
// including a tool whose own payload merely happens to have a `text` key.
const STRUCTURED_WRAPPER_KEYS = new Set(["type", "text", "structuredContent", "meta"]);
export function dropDuplicateStructuredContent(content: unknown): string | null {
	let candidate: unknown = content;
	if (typeof content === "string") {
		// Cheap reject before parsing what may be hundreds of KB.
		if (!content.startsWith("{") || !content.includes('"structuredContent"')) return null;
		try {
			candidate = JSON.parse(content);
		} catch {
			return null;
		}
	}
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
	const wrapper = candidate as Record<string, unknown>;
	if (wrapper.type !== "text" || typeof wrapper.text !== "string" || !("structuredContent" in wrapper)) return null;
	if (!Object.keys(wrapper).every((k) => STRUCTURED_WRAPPER_KEYS.has(k))) return null;
	return wrapper.text;
}

// What the sandbox is given as a result: the SAME shape the model reads.
//
// For a tool with an outputSchema the two copies can differ in shape -- kafka_list_consumer_groups
// returns a bare array as text and { groups: [...] } as structuredContent, because the MCP wire
// format requires structuredContent to be an object. The text is used on purpose (Greptile,
// PR #812, argued for the structured copy): the model never sees a tool's OUTPUT schema -- only
// its name, description and input schema are bound -- so the only shape it knows is the text it
// has read. A transform is written from that observation (`result.length`), and handing the
// sandbox a differently-shaped object would break exactly the code the model is able to write.
//
// Unwraps the adapter's duplicated wrapper FIRST: for a
// tool with an outputSchema the raw content is { type, text, structuredContent }, and a
// transform written against the tool's real payload (`result.MetricAlarms.length`) would
// otherwise see only those three keys. Found by test-merging SIO-1774 with this branch.
export function evidenceText(content: unknown): string {
	const unwrapped = dropDuplicateStructuredContent(content);
	if (unwrapped !== null) return unwrapped;
	if (typeof content === "string") return content;
	// MCP multi-block content: the text blocks ARE the payload.
	if (Array.isArray(content)) {
		const texts = content
			.map((b) => (b && typeof b === "object" && "text" in b && typeof b.text === "string" ? b.text : null))
			.filter((t): t is string => t !== null);
		if (texts.length > 0) return texts.join("");
	}
	// content-ok: a captured MCP tool RESULT body on its way into the sandbox as evidence,
	// not an AIMessage; it is never rendered or sent to a model from here.
	return JSON.stringify(content) ?? "";
}

export function describeRun(toolName: string, code: string, originalBytes: number, run: SandboxRunResult) {
	return {
		event: "subagent.evidence_exec",
		toolName,
		// The code text goes to LangSmith with the tool call; the app log gets its fingerprint.
		codeSha256: createHash("sha256").update(code).digest("hex").slice(0, 16),
		codeBytes: Buffer.byteLength(code, "utf8"),
		originalBytes,
		stdoutBytes: Buffer.byteLength(run.stdout, "utf8"),
		durationMs: run.durationMs,
		mode: run.mode,
		failed: run.error !== undefined,
		interrupted: run.interrupted === true,
		outOfMemory: run.outOfMemory === true,
		hostFailure: run.hostFailure === true,
	};
}

const MAX_CONSECUTIVE_FAILURES = 3;

interface ExecLogger {
	info: (...args: unknown[]) => unknown;
}

// `getEvidence` is read at call time, so the tool sees every result captured so far.
export function buildRunJsOnEvidenceTool(
	getEvidence: () => Array<{ toolName: string; content: unknown }>,
	runner: SandboxRunner,
	log: ExecLogger,
): StructuredToolInterface {
	let consecutiveFailures = 0;
	return createTool(
		async ({ code }: { code: string }) => {
			const evidence = getEvidence().map((o, i) => ({
				id: `e${i + 1}`,
				tool: o.toolName,
				json: evidenceText(o.content),
			}));
			if (evidence.length === 0) {
				return "No tool results have been captured in this run yet, so there is nothing to compute over. Call a datasource tool first.";
			}
			const run = await runner(code, evidence);
			const originalBytes = evidence.reduce((n, e) => n + Buffer.byteLength(e.json, "utf8"), 0);
			log.info(describeRun(RUN_JS_TOOL_NAME, code, originalBytes, run), "Sandboxed code ran over captured evidence");
			if (run.error !== undefined) {
				consecutiveFailures += 1;
				const stop =
					consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
						? ` This is failure ${consecutiveFailures} in a row. Do not call ${RUN_JS_TOOL_NAME} again; write your findings from the results you already have.`
						: " Fix the code and try once more, or answer from the results you already have.";
				return `The code failed: ${run.error}.${stop}${run.stdout ? `\nOutput before the failure:\n${run.stdout}` : ""}`;
			}
			consecutiveFailures = 0;
			return run.stdout === "" ? "(the code returned nothing; `return` a value or call print())" : run.stdout;
		},
		{
			name: RUN_JS_TOOL_NAME,
			description:
				"Run a JavaScript function body in a sandbox over the FULL tool results already captured in this run, including what was truncated out of the conversation. Use it for counts, group-bys, filters and joins across results instead of reading large payloads. Inside: `evidence.list()` gives [{id, tool, bytes}] in call order; `evidence.get(id)` gives that result (parsed JSON, or a string if it was not JSON); `print(...)` writes a line; whatever you `return` is shown to you. No network, files or imports exist there. Captured results are one PAGE of what a datasource holds: for true totals prefer a datasource-side aggregation.",
			schema: z.object({
				code: z.string().describe('Function body, e.g. `const h = evidence.get("e1").hits.hits; return h.length;`'),
			}),
		},
	);
}
