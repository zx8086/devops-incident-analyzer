// agent/src/iac/nodes.ts

import { createHash } from "node:crypto";
import { buildSystemPrompt } from "@devops-agent/gitagent-bridge";
import { getLogger } from "@devops-agent/observability";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { AIMessage, type BaseMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod";
import { createLlm, createLlmWithTools } from "../llm.ts";
import { getConnectedServers, getToolsForDataSource } from "../mcp-bridge.ts";
import { getAgentByName } from "../prompt-context.ts";
import { evaluateGuards } from "./guards.ts";
import type {
	DriftReport,
	IacApprovalState,
	IacPlanReport,
	IacPlanReview,
	IacRequest,
	IacStateType,
	ReconcileDirection,
	ReconcileResult,
	StackDrift,
} from "./state.ts";

const log = getLogger("agent:iac");
const AGENT = "elastic-iac";
const IAC_SERVER = "elastic-iac-mcp";

function lastHumanText(state: IacStateType): string {
	for (let i = state.messages.length - 1; i >= 0; i--) {
		const m = state.messages[i];
		if (m?.getType() === "human") return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
	}
	return "";
}

function findTool(name: string): StructuredToolInterface | undefined {
	return getToolsForDataSource(AGENT).find((t) => t.name === name);
}

// Best-effort single-tool call. Returns a placeholder when the unified server (and
// therefore the tool) is not connected so the graph degrades instead of throwing.
async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
	const tool = findTool(name);
	if (!tool) return `[${name} unavailable - elastic-iac server not connected]`;
	try {
		const res = await tool.invoke(args);
		return typeof res === "string" ? res : JSON.stringify(res);
	} catch (err) {
		return `[${name} error: ${err instanceof Error ? err.message : String(err)}]`;
	}
}

// The planner commonly emits explicit `null` for absent optional fields; z.optional()
// rejects null and would silently fail the whole parse (-> the clarify fallback), so
// every optional field is .nullish() and nulls are normalized to undefined below.
const IntentSchema = z.object({
	workflow: z.enum(["tier-resize", "ilm-rollout", "version-upgrade", "other"]).default("other"),
	cluster: z.string().nullish(),
	tier: z.string().nullish(),
	resource: z.string().nullish(),
	newSizeGb: z.number().nullish(),
	newMaxGb: z.number().nullish(),
	policyName: z.string().nullish(),
	phasesPatch: z.record(z.string(), z.unknown()).nullish(),
	version: z.string().nullish(),
	reason: z.string().nullish(),
	isProd: z.boolean().default(false),
	clarification: z.string().nullish(),
});

// Extract the planner's JSON object into a validated IacRequest, falling back to a
// safe clarify-default on malformed output. (Exported for unit testing.)
export function parseIntentJson(raw: string): IacRequest {
	const match = raw.match(/\{[\s\S]*\}/);
	if (match) {
		try {
			const parsed = IntentSchema.safeParse(JSON.parse(match[0]));
			if (parsed.success) {
				const p = parsed.data;
				// Normalize the planner's explicit nulls to undefined for the IacRequest shape.
				const nn = <T>(v: T | null | undefined): T | undefined => v ?? undefined;
				return {
					workflow: p.workflow,
					isProd: p.isProd,
					cluster: nn(p.cluster),
					tier: nn(p.tier),
					resource: nn(p.resource),
					newSizeGb: nn(p.newSizeGb),
					newMaxGb: nn(p.newMaxGb),
					policyName: nn(p.policyName),
					phasesPatch: nn(p.phasesPatch),
					version: nn(p.version),
					reason: nn(p.reason),
					clarification: nn(p.clarification),
				};
			}
		} catch {
			// fall through to the safe default below
		}
	}
	return { workflow: "other", isProd: false, clarification: "Which cluster and what change should I make?" };
}

// Map a raw classifier reply to an intent. "gitops", "pipeline-status", and "drift" are
// explicit; anything else defaults to "info". (Pure; unit-tested directly.)
export function intentFromText(raw: string): "info" | "gitops" | "pipeline-status" | "drift" {
	const r = raw.toLowerCase();
	if (r.includes("pipeline-status") || r.includes("pipeline_status")) return "pipeline-status";
	// SIO-882: "drift" enters the drift-detection + per-stack reconcile sub-flow.
	if (r.includes("drift") || r.includes("reconcile")) return "drift";
	if (r.includes("gitops")) return "gitops";
	return "info";
}

// Classify the request: read-only info, a gitops change, or a follow-up about an MR's
// pipeline/plan/approval. Ambiguous "should I…/recommend…" biases to gitops (HITL-gated,
// never applies). pipeline-status only resolves when the thread already opened an MR.
export async function classifyIacIntent(state: IacStateType): Promise<Partial<IacStateType>> {
	const query = lastHumanText(state);
	const llm = createLlm("iacClassifier", AGENT);
	const sys =
		"Classify the user's Elastic Cloud request into exactly one word:\n" +
		"- 'info': a read-only question answerable by reading state (versions, topology, plan history, " +
		"ILM, health, 'what is X running', 'list deployments', 'is X healthy').\n" +
		"- 'gitops': a request to CHANGE one specific thing (resize, downsize, add/modify ILM, upgrade a version, " +
		"open an MR) -- a single targeted Terraform diff.\n" +
		"- 'drift': a request to DETECT or RECONCILE configuration drift for a deployment -- 'check X for drift', " +
		"'what has drifted', 'reconcile X with live', 'compare the repo with the live cluster', 'show drift by stack'. " +
		"This audits ALL stacks of one deployment and offers a per-stack reconcile choice.\n" +
		"- 'pipeline-status': a follow-up about a merge request the agent already opened -- 'did the pipeline " +
		"pass/fail', 'check my MR', 'show me the plan', 'is it approved', 'what's the CI status'.\n" +
		"Reply with ONLY one word: 'info', 'gitops', 'drift', or 'pipeline-status'. " +
		"If the user asks for a recommendation or 'should I…' that implies a single change, answer 'gitops'.";
	const res = await llm.invoke([new SystemMessage(sys), new HumanMessage(query)]);
	const intent = intentFromText(String(res.content));
	// SIO-877: pipeline-status resolves even without a thread-local mrIid -- watchPipeline
	// falls back to the latest open agent MR (so "check my MR" survives a page reload).
	log.info({ intent, query, hasMr: state.mrIid !== null }, "classified IaC intent");
	return { intent };
}

// Verify the unified IaC server is connected before any user-facing action (hooks/bootstrap.md).
export function bootstrapIac(_state: IacStateType): Partial<IacStateType> {
	const connected = getConnectedServers().includes(IAC_SERVER);
	if (!connected) {
		log.warn({ server: IAC_SERVER }, "elastic-iac server not connected");
		return {
			connected: false,
			messages: [
				new AIMessage(
					"The Elastic IaC server is not connected. Start mcp-server-elastic-iac (:9086) and set ELASTIC_IAC_MCP_URL, then retry.",
				),
			],
		};
	}
	return { connected: true };
}

// Translate the plain-English request into a structured IacRequest. Asks one direct
// clarifying question via interrupt when the cluster/change is ambiguous.
export async function parseIntent(state: IacStateType): Promise<Partial<IacStateType>> {
	const query = lastHumanText(state);
	const llm = createLlm("iacPlanner", AGENT);
	const sys = buildSystemPrompt(getAgentByName(AGENT));
	const instruction =
		"Extract the requested Elastic Cloud IaC change as a single strict JSON object with keys: " +
		"workflow ('tier-resize'|'ilm-rollout'|'version-upgrade'|'other'), cluster, tier, resource, newSizeGb, " +
		"newMaxGb, policyName, phasesPatch, version, reason, isProd (true only if the user explicitly named a production " +
		"cluster), and clarification. " +
		"For an Elasticsearch version upgrade ('upgrade X to 9.4.2', 'bump Y to 8.15'), set workflow to " +
		"'version-upgrade', cluster to the named deployment, and version to the explicit target version string. " +
		"For a tier resize ('downsize eu-b2b warm to 8 GB', 'set ap-cld cold max to 8GB'), set workflow to " +
		"'tier-resize', cluster, tier (hot|warm|cold|frozen|...), and newSizeGb and/or newMaxGb as plain GB integers. " +
		"For an ILM lifecycle-policy change ('set eu-b2b 30-days retention to 60 days', 'forcemerge warm to 1 " +
		"segment on eu-cld logs'), set workflow to 'ilm-rollout', cluster to the named deployment, policyName to the " +
		"policy filename VERBATIM (e.g. '30-days@lifecycle', 'logs', 'eu-default-lifecycle-logs-prod'), and phasesPatch " +
		"to a nested object containing ONLY the phase fields to change (top-level keys are phases hot|warm|cold|delete; " +
		"durations are strings like '60d'; retention is delete.min_age). " +
		"Set clarification (a single direct question) ONLY when a required field is genuinely missing -- e.g. no " +
		"cluster named, an upgrade with no concrete target version ('upgrade to latest'), or a resize with no tier or " +
		"no size/max. Do NOT ask for information the user already provided. Respond with ONLY the JSON object.";

	const res = await llm.invoke([new SystemMessage(`${sys}\n\n${instruction}`), new HumanMessage(query)]);
	let request = parseIntentJson(String(res.content));

	if (request.clarification) {
		const answer = interrupt({
			type: "iac_clarify",
			question: request.clarification,
			message: request.clarification,
		}) as { answer?: string };
		const reply = answer?.answer ?? "";
		const res2 = await llm.invoke([
			new SystemMessage(`${sys}\n\n${instruction}`),
			new HumanMessage(query),
			new AIMessage(request.clarification),
			new HumanMessage(reply),
		]);
		request = { ...parseIntentJson(String(res2.content)), clarification: undefined };
		return { iacRequest: request, messages: [new HumanMessage(reply)] };
	}

	return { iacRequest: request };
}

// Read-only tools the info path may call. Binding only this subset means the LLM
// physically cannot reach git_create_branch / gitlab_create_merge_request etc.
const INFO_TOOL_NAMES = [
	"elastic_cloud_list_deployment_versions",
	"elastic_cloud_list_deployments",
	"elastic_cloud_get_deployment",
	"elastic_cloud_get_plan_history",
	"elastic_get_cluster_health",
	"elastic_get_index_template",
	"elastic_ilm_get_lifecycle",
] as const;

function infoTools(): StructuredToolInterface[] {
	const allowed = new Set<string>(INFO_TOOL_NAMES);
	return getToolsForDataSource(AGENT).filter((t) => allowed.has(t.name));
}

// Answer a read-only question via a bounded tool-calling loop over the read subset.
// Never drafts, never opens an MR -- this is the terminal node for info intent.
export async function answerInfo(state: IacStateType): Promise<Partial<IacStateType>> {
	const query = lastHumanText(state);
	const tools = infoTools();
	if (tools.length === 0) {
		return { messages: [new AIMessage("Elastic IaC read tools are unavailable; cannot answer right now.")] };
	}
	const llm = createLlmWithTools("iacReader", tools, AGENT);
	const sys =
		`${buildSystemPrompt(getAgentByName(AGENT))}\n\n` +
		"This is a READ-ONLY question. Use the elastic read tools to answer it precisely. " +
		"Never draft Terraform, never open an MR, never create a branch. Answer concisely with the facts.";
	const toolNames = new Set(tools.map((t) => t.name));
	const convo: BaseMessage[] = [new SystemMessage(sys), new HumanMessage(query)];

	const MAX_STEPS = 5;
	for (let step = 0; step < MAX_STEPS; step++) {
		const ai = (await llm.invoke(convo)) as AIMessage;
		convo.push(ai);
		const calls = ai.tool_calls ?? [];
		if (calls.length === 0) return { messages: [new AIMessage(String(ai.content))] };
		for (const call of calls) {
			const result = toolNames.has(call.name)
				? await callTool(call.name, (call.args ?? {}) as Record<string, unknown>)
				: `[${call.name} is not an allowed read tool]`;
			convo.push(new ToolMessage({ content: result, tool_call_id: call.id ?? call.name }));
		}
	}
	// Step budget exhausted: one final no-tool synthesis of what was gathered.
	const final = await createLlm("iacReader", AGENT).invoke([
		...convo,
		new HumanMessage("Summarize the answer now using what you've gathered."),
	]);
	return { messages: [new AIMessage(String(final.content))] };
}

// Parse the "[status] {json}" body callTool returns from elastic_cloud_list_deployments
// and resolve a human cluster name to its Elastic Cloud deployment id. Exact name match
// wins over case-insensitive; "" when not found / unparseable. (Pure; unit-tested.)
export function parseDeploymentId(listText: string, clusterName: string): string {
	if (!clusterName) return "";
	const jsonStart = listText.indexOf("{");
	if (jsonStart < 0) return "";
	try {
		const parsed: unknown = JSON.parse(listText.slice(jsonStart));
		const rows =
			typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { deployments?: unknown }).deployments)
				? (parsed as { deployments: Array<{ id?: string; name?: string }> }).deployments
				: [];
		const exact = rows.find((r) => r.name === clusterName);
		if (exact?.id) return exact.id;
		const ci = rows.find((r) => (r.name ?? "").toLowerCase() === clusterName.toLowerCase());
		return ci?.id ?? "";
	} catch {
		return "";
	}
}

async function resolveDeploymentId(clusterName: string): Promise<string> {
	if (!clusterName) return "";
	return parseDeploymentId(await callTool("elastic_cloud_list_deployments", {}), clusterName);
}

// Read live cluster state (topology, plan history, ILM, health) before drafting.
export async function readClusterState(state: IacStateType): Promise<Partial<IacStateType>> {
	const req = state.iacRequest;
	const cluster = req?.cluster ?? "";
	const deploymentId = await resolveDeploymentId(cluster);
	const summary = deploymentId
		? await callTool("elastic_cloud_get_deployment", { deploymentId })
		: `[could not resolve an Elastic Cloud deployment id for cluster '${cluster}']`;
	const alerts = await callTool("elastic_ilm_get_lifecycle", { policy: ".alerts" });
	const alertsManaged = !alerts.startsWith("[") && alerts.toLowerCase().includes("alerts");
	return {
		clusterState: { cluster, summary, alertsManaged, raw: summary },
	};
}

// Apply the mechanical safety guards. Blocked requests terminate before any write.
export function guardNode(state: IacStateType): Partial<IacStateType> {
	const req = state.iacRequest;
	if (!req) return { blockedReason: "No request parsed." };
	const result = evaluateGuards(req, state.clusterState);
	if (result.blocked) {
		return {
			blockedReason: result.reason ?? "Blocked by guard.",
			messages: [new AIMessage(`Cannot proceed: ${result.reason}`)],
		};
	}
	return { blockedReason: "" };
}

// Read-modify-write the per-deployment JSON: set the top-level `version` field to
// the target. GitLab's commit "update" action needs the full file body, not a diff.
// Preserves 2-space indent + a trailing newline (repo house style). Throws on
// invalid JSON. (Pure; unit-tested.)
export function setDeploymentVersion(json: string, version: string): { content: string; previous?: string } {
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("deployment JSON is not an object");
	}
	const obj = parsed as Record<string, unknown>;
	const previous = typeof obj.version === "string" ? obj.version : undefined;
	obj.version = version;
	return { content: `${JSON.stringify(obj, null, 2)}\n`, previous };
}

// SIO-879: read-modify-write a tier's size/max_size in the deployment JSON. Tier sizes
// are strings like "8g" (GB); the request carries GB integers. Only sets the fields the
// caller provides (a tier may be autoscaling-only: max_size set, size absent). Preserves
// other tier fields (zone_count, instance_configuration_id) + trailing newline. Throws on
// bad JSON or an unknown/absent tier. (Pure; unit-tested.)
export function setDeploymentTierSize(
	json: string,
	tier: string,
	sizeGb?: number,
	maxGb?: number,
): { content: string; previousSize?: string; previousMax?: string } {
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("deployment JSON is not an object");
	}
	const obj = parsed as { elasticsearch?: Record<string, unknown> };
	const es = obj.elasticsearch;
	if (!es || typeof es !== "object") throw new Error("deployment JSON has no elasticsearch block");
	const t = es[tier];
	if (!t || typeof t !== "object") throw new Error(`unknown or unsized tier '${tier}'`);
	const tierObj = t as Record<string, unknown>;
	const previousSize = typeof tierObj.size === "string" ? tierObj.size : undefined;
	const previousMax = typeof tierObj.max_size === "string" ? tierObj.max_size : undefined;
	if (sizeGb != null) tierObj.size = `${sizeGb}g`;
	if (maxGb != null) tierObj.max_size = `${maxGb}g`;
	return { content: `${JSON.stringify(obj, null, 2)}\n`, previousSize, previousMax };
}

// SIO-880: read-modify-write an ILM lifecycle-policy JSON by deep-merging a nested phase
// patch (top-level keys are phases: hot/warm/cold/delete). Recurses into nested objects
// (e.g. warm.forcemerge), replaces scalars/arrays/null. Captures the pre-merge value of
// every touched leaf into `previous` (a sparse mirror of the patch) for the diff +
// retention check; a leaf the policy lacked records `undefined`. Preserves 2-space indent
// + trailing newline. Throws on non-object JSON. (Pure; unit-tested.)
export function mergeIlmPhases(
	json: string,
	patch: Record<string, unknown>,
): { content: string; previous: Record<string, unknown> } {
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("ILM policy JSON is not an object");
	}
	const isPlainObject = (v: unknown): v is Record<string, unknown> =>
		typeof v === "object" && v !== null && !Array.isArray(v);

	const previous: Record<string, unknown> = {};
	const merge = (target: Record<string, unknown>, p: Record<string, unknown>, prev: Record<string, unknown>): void => {
		for (const [key, value] of Object.entries(p)) {
			const current = target[key];
			if (isPlainObject(value)) {
				// A phase value changing from scalar->object would drop the old scalar from
				// `previous`; ILM phases are always objects, so this clobber path is unreachable.
				if (!isPlainObject(current)) target[key] = {};
				const prevChild: Record<string, unknown> = {};
				prev[key] = prevChild;
				merge(target[key] as Record<string, unknown>, value, prevChild);
			} else {
				prev[key] = current; // may be undefined if the policy lacked this leaf
				target[key] = value;
			}
		}
	};
	merge(parsed as Record<string, unknown>, patch, previous);
	return { content: `${JSON.stringify(parsed, null, 2)}\n`, previous };
}

// SIO-880: parse an Elastic time string ("30d", "48h", "90m", "30s") to seconds. Returns
// null for an unrecognized unit/format. ms/micros/nanos are not ILM min_age units.
function durationToSeconds(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const m = value.match(/^(\d+)\s*(d|h|m|s)$/);
	if (!m) return null;
	const n = Number(m[1]);
	const unit = m[2];
	const mult = unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
	return n * mult;
}

// SIO-880: compare old vs new delete.min_age. Returns the from/to descriptor when the new
// retention is strictly shorter (irreversible data loss = HIGH risk), else null. (Pure.)
export function detectRetentionReduction(
	previous: Record<string, unknown>,
	patch: Record<string, unknown>,
): { from: string; to: string } | null {
	const prevDelete = previous.delete;
	const patchDelete = patch.delete;
	if (typeof prevDelete !== "object" || prevDelete === null) return null;
	if (typeof patchDelete !== "object" || patchDelete === null) return null;
	const from = (prevDelete as { min_age?: unknown }).min_age;
	const to = (patchDelete as { min_age?: unknown }).min_age;
	const fromS = durationToSeconds(from);
	const toS = durationToSeconds(to);
	if (fromS === null || toS === null) return null;
	return toS < fromS ? { from: from as string, to: to as string } : null;
}

// Resolve a per-deployment/per-policy JSON path from a configured template. ${cluster}
// and ${policy} are literal placeholders (config, not JS template literals). The policy
// filename is substituted verbatim (it legitimately contains '@' and '.').
export function deploymentJsonPath(template: string, cluster: string, policy?: string): string {
	let out = template.replace(/\$\{cluster\}/g, cluster);
	if (policy !== undefined) out = out.replace(/\$\{policy\}/g, policy);
	return out;
}

// Pure branch slug from the request descriptor: cluster-<descriptor>-workflow.
// For a version-upgrade the descriptor is the target version (e.g. "9-4-2").
// (Exported for unit testing; branchName appends agent/ + the date.)
export function branchSlug(req: IacRequest): string {
	const descriptor =
		req.workflow === "version-upgrade"
			? req.version
			: req.workflow === "ilm-rollout"
				? req.policyName
				: (req.tier ?? req.resource);
	return [req.cluster, descriptor, req.workflow]
		.filter(Boolean)
		.join("-")
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.slice(0, 40);
}

function branchName(req: IacRequest): string {
	const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
	return `agent/${branchSlug(req)}-${date}`;
}

// SIO-873: the agent owns the per-deployment JSON path -- it knows the cluster and
// passes the resolved filePath to the MCP gitlab_* tools, which only own the repo
// target (base URL + project). Literal "${cluster}" placeholder. The agent edits
// JSON config only; it never runs terraform or git.
// Read lazily via process.env (works under both Bun and the web app's Vite SSR
// runtime, where a top-level `Bun.env` reference throws "Bun is not defined").
function deploymentJsonTemplate(): string {
	return process.env.ELASTIC_IAC_DEPLOYMENT_JSON_TEMPLATE ?? "environments/_deployments/${cluster}.json";
}

// SIO-880: agent-side path template for ILM lifecycle-policy JSON. ${cluster}/${policy}
// are literal placeholders. Lazy process.env read (no module-scope Bun.env; the web app
// runs Vite SSR where a top-level Bun.env reference throws "Bun is not defined").
function ilmPolicyTemplate(): string {
	return process.env.ELASTIC_IAC_ILM_POLICY_TEMPLATE ?? "environments/${cluster}/lifecycle-policies/${policy}.json";
}

// Strip callTool's "[status] body" prefix and, for the GitLab files API, decode the
// base64 `content` field into the raw file text.
function extractFileContent(toolResult: string): string {
	const jsonStart = toolResult.indexOf("{");
	if (jsonStart < 0) return toolResult;
	try {
		const parsed: unknown = JSON.parse(toolResult.slice(jsonStart));
		if (typeof parsed === "object" && parsed !== null && "content" in parsed) {
			const c = (parsed as { content?: unknown; encoding?: unknown }).content;
			if (typeof c === "string") {
				const enc = (parsed as { encoding?: unknown }).encoding;
				return enc === "base64" ? Buffer.from(c, "base64").toString("utf8") : c;
			}
		}
	} catch {
		// fall through
	}
	return toolResult;
}

// version-upgrade: propose the change as a GitLab config edit + branch + commit via
// the API (no clone, no terraform, no local git). CI computes the plan on the MR.
async function proposeVersionUpgrade(state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
	const cluster = req.cluster ?? "";
	const version = req.version ?? "";
	const filePath = deploymentJsonPath(deploymentJsonTemplate(), cluster);
	const branch = branchName(req);

	const raw = await callTool("gitlab_get_file_content", { filePath });
	if (raw.startsWith("[gitlab token not configured")) {
		return {
			blockedReason: "ELASTIC_IAC_GITLAB_TOKEN not configured; cannot read the GitOps repo.",
			messages: [new AIMessage("Cannot propose the change: set ELASTIC_IAC_GITLAB_TOKEN for the GitOps repo.")],
		};
	}
	let updated: { content: string; previous?: string };
	try {
		updated = setDeploymentVersion(extractFileContent(raw), version);
	} catch {
		return {
			blockedReason: `Could not read ${filePath} as JSON (got: ${raw.slice(0, 120)}).`,
			messages: [new AIMessage(`Cannot propose the change: ${filePath} did not parse as JSON.`)],
		};
	}

	await callTool("gitlab_create_branch", { branch, ref: "main" });
	const commit = await callTool("gitlab_commit_file", {
		branch,
		file_path: filePath,
		content: updated.content,
		commit_message: `${cluster}: upgrade Elasticsearch ${updated.previous ?? "?"} -> ${version}`,
	});
	const committed = !commit.startsWith("[4") && !commit.startsWith("[5");

	const diff = `${filePath}\n- "version": "${updated.previous ?? "?"}"\n+ "version": "${version}"`;
	return {
		branch,
		proposedFilePath: filePath,
		previousVersion: updated.previous ?? "",
		proposedDiff: diff,
		precheckPassed: committed,
	};
}

// SIO-879: tier-resize via the GitOps proposer -- edit elasticsearch.<tier>.size/max_size
// in the deployment JSON and open an MR via the API. Mirrors proposeVersionUpgrade.
async function proposeTierResize(state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
	const cluster = req.cluster ?? "";
	const tier = req.tier ?? "";
	const filePath = deploymentJsonPath(deploymentJsonTemplate(), cluster);
	const branch = branchName(req);

	if (!tier || (req.newSizeGb == null && req.newMaxGb == null)) {
		return {
			blockedReason: "Tier-resize needs a tier and a new size and/or max.",
			messages: [new AIMessage("Cannot propose the change: name the tier and a new size and/or max (GB).")],
		};
	}

	const raw = await callTool("gitlab_get_file_content", { filePath });
	if (raw.startsWith("[gitlab token not configured")) {
		return {
			blockedReason: "ELASTIC_IAC_GITLAB_TOKEN not configured; cannot read the GitOps repo.",
			messages: [new AIMessage("Cannot propose the change: set ELASTIC_IAC_GITLAB_TOKEN for the GitOps repo.")],
		};
	}
	let updated: { content: string; previousSize?: string; previousMax?: string };
	try {
		updated = setDeploymentTierSize(extractFileContent(raw), tier, req.newSizeGb, req.newMaxGb);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			blockedReason: `Could not edit ${tier} tier in ${filePath}: ${reason}.`,
			messages: [new AIMessage(`Cannot propose the change: ${reason}.`)],
		};
	}

	await callTool("gitlab_create_branch", { branch, ref: "main" });
	const target = [
		req.newSizeGb != null ? `size ${req.newSizeGb}g` : "",
		req.newMaxGb != null ? `max ${req.newMaxGb}g` : "",
	]
		.filter(Boolean)
		.join(", ");
	const commit = await callTool("gitlab_commit_file", {
		branch,
		file_path: filePath,
		content: updated.content,
		commit_message: `${cluster}: resize ${tier} tier (${target})`,
	});
	const committed = !commit.startsWith("[4") && !commit.startsWith("[5");

	const diffLines = [`${filePath} (elasticsearch.${tier})`];
	if (req.newSizeGb != null)
		diffLines.push(`- "size": "${updated.previousSize ?? "?"}"\n+ "size": "${req.newSizeGb}g"`);
	if (req.newMaxGb != null)
		diffLines.push(`- "max_size": "${updated.previousMax ?? "?"}"\n+ "max_size": "${req.newMaxGb}g"`);
	return {
		branch,
		proposedFilePath: filePath,
		proposedDiff: diffLines.join("\n"),
		precheckPassed: committed,
	};
}

// SIO-880: ilm-rollout via the GitOps proposer -- deep-merge a phase patch into the
// cluster's lifecycle-policy JSON and open an MR via the API. Mirrors proposeTierResize.
async function proposeIlmChange(state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
	const cluster = req.cluster ?? "";
	const policy = req.policyName ?? "";
	const patch = req.phasesPatch;

	if (!policy || !patch || Object.keys(patch).length === 0) {
		return {
			blockedReason: "ILM change needs a policy name and at least one phase field to change.",
			messages: [new AIMessage("Cannot propose the change: name the policy and at least one phase field to change.")],
		};
	}

	const filePath = deploymentJsonPath(ilmPolicyTemplate(), cluster, policy);
	const branch = branchName(req);

	const raw = await callTool("gitlab_get_file_content", { filePath });
	if (raw.startsWith("[gitlab token not configured")) {
		return {
			blockedReason: "ELASTIC_IAC_GITLAB_TOKEN not configured; cannot read the GitOps repo.",
			messages: [new AIMessage("Cannot propose the change: set ELASTIC_IAC_GITLAB_TOKEN for the GitOps repo.")],
		};
	}
	// A missing policy file comes back as 404 from the GitLab files API. Match 404
	// specifically so a 401/403 (auth/scope) isn't mislabeled as "no such policy".
	if (raw.startsWith("[404")) {
		return {
			blockedReason: `No such policy '${policy}' on '${cluster}': no such policy file at ${filePath}.`,
			messages: [
				new AIMessage(
					`Cannot propose the change: no such policy '${policy}' on '${cluster}'. Check the policy filename.`,
				),
			],
		};
	}

	let updated: { content: string; previous: Record<string, unknown> };
	try {
		updated = mergeIlmPhases(extractFileContent(raw), patch);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			blockedReason: `Could not edit ${filePath}: ${reason}.`,
			messages: [new AIMessage(`Cannot propose the change: ${reason}.`)],
		};
	}

	const retentionChange = detectRetentionReduction(updated.previous, patch);

	await callTool("gitlab_create_branch", { branch, ref: "main" });
	const fields = Object.keys(patch).join(", ");
	const commit = await callTool("gitlab_commit_file", {
		branch,
		file_path: filePath,
		content: updated.content,
		commit_message: `${cluster}: ILM ${policy} (${fields})`,
	});
	const committed = !commit.startsWith("[4") && !commit.startsWith("[5");

	// Human diff: one -/+ pair per touched leaf, walking the previous mirror against patch.
	const diffLines: string[] = [`${filePath} (ILM ${policy})`];
	const walk = (prev: Record<string, unknown>, p: Record<string, unknown>, prefix: string): void => {
		for (const [key, value] of Object.entries(p)) {
			const path = prefix ? `${prefix}.${key}` : key;
			if (typeof value === "object" && value !== null && !Array.isArray(value)) {
				const prevChild = (prev[key] ?? {}) as Record<string, unknown>;
				walk(prevChild, value as Record<string, unknown>, path);
			} else {
				// Prefix the dotted phase path, then the JSON field name verbatim so the diff
				// reads as a real JSON edit (e.g. `[delete] - "min_age": "30d" + "min_age": "60d"`).
				// A brand-new field has no prior value; render "?" to match proposeTierResize.
				const before = prev[key] === undefined ? '"?"' : JSON.stringify(prev[key]);
				diffLines.push(
					`[${path.includes(".") ? path.slice(0, path.lastIndexOf(".")) : path}] - "${key}": ${before}\n+ "${key}": ${JSON.stringify(value)}`,
				);
			}
		}
	};
	walk(updated.previous, patch, "");

	return {
		branch,
		proposedFilePath: filePath,
		proposedDiff: diffLines.join("\n"),
		precheckPassed: committed,
		retentionChange,
	};
}

// Draft the change. version-upgrade + tier-resize go through the GitOps proposer (JSON
// edit via the GitLab API); other workflows still draft a Terraform diff locally (legacy).
export async function draftChange(state: IacStateType): Promise<Partial<IacStateType>> {
	const req = state.iacRequest;
	if (!req) return {};
	if (req.workflow === "version-upgrade") return proposeVersionUpgrade(state, req);
	if (req.workflow === "tier-resize") return proposeTierResize(state, req);
	if (req.workflow === "ilm-rollout") return proposeIlmChange(state, req);

	const branch = branchName(req);
	await callTool("git_create_branch", { branch });

	const llm = createLlm("iacDrafter", AGENT);
	const sys = buildSystemPrompt(getAgentByName(AGENT));
	const res = await llm.invoke([
		new SystemMessage(sys),
		new HumanMessage(
			`Produce the minimal Terraform diff for: ${JSON.stringify(req)}.\n` +
				`Cluster state:\n${state.clusterState?.summary ?? "(unavailable)"}\n` +
				"Output the unified diff only. Do not apply. Do not push to main.",
		),
	]);
	return { branch, proposedDiff: String(res.content) };
}

// Assemble the review payload. version-upgrade skips local terraform entirely -- the
// change is already committed to a branch and CI computes the plan on the MR (deck
// p.18). Other workflows still run terraform validate/plan locally (legacy path).
export async function reviewPlan(state: IacStateType): Promise<Partial<IacStateType>> {
	const req = state.iacRequest;
	const branch = state.branch;
	const isUpgrade = req?.workflow === "version-upgrade";
	// SIO-879: version-upgrade and tier-resize are GitOps config edits (committed via the
	// API; CI plans on the MR). Other workflows still run terraform locally (legacy).
	const isConfigEdit = isUpgrade || req?.workflow === "tier-resize" || req?.workflow === "ilm-rollout";

	let plan: string;
	let precheckPassed: boolean;
	if (isConfigEdit) {
		// The commit succeeded in draftChange; CI renders the authoritative plan on the MR.
		plan = "CI computes the Terraform plan on the merge request. No local plan is run for config edits.";
		precheckPassed = state.precheckPassed;
	} else {
		await callTool("terraform_validate", { branch });
		plan = await callTool("terraform_plan", { branch, cluster: req?.cluster });
		precheckPassed = !plan.startsWith("[") && !/error/i.test(plan);
	}

	const risks: string[] = [];
	if (req?.tier === "hot") risks.push("Hot-tier change can trigger shard relocation; apply off-peak.");
	if (req?.workflow === "ilm-rollout") {
		risks.push(
			"ILM phase change can trigger force-merge load / frozen pull-in; transitions take effect as each index rolls over, not immediately.",
		);
		// SIO-880: a retention REDUCTION is irreversible data loss -- surface as HIGH (first).
		if (state.retentionChange) {
			risks.unshift(
				`Retention REDUCED ${state.retentionChange.from}->${state.retentionChange.to}; data deleted at apply is irrecoverable -- confirm the IR/issue reference before merge.`,
			);
		}
	}
	if (isUpgrade) {
		risks.push(
			"Version upgrades are rolling and irreversible; confirm the target is a valid forward step and apply off-peak.",
		);
		risks.push("CCS/CCR: the local cluster must stay <= 1 minor ahead of every remote -- audit before merge.");
	}
	if (req?.workflow === "tier-resize")
		risks.push("Tier resize triggers a plan change; a downsize relocates shards -- apply off-peak.");

	// Descriptor: upgrade shows the version transition; tier-resize the tier + new sizing.
	const tierTarget = [
		req?.newSizeGb != null ? `${req.newSizeGb}g` : "",
		req?.newMaxGb != null ? `max ${req.newMaxGb}g` : "",
	]
		.filter(Boolean)
		.join("/");
	const descriptor = isUpgrade
		? `${state.previousVersion || "?"} -> ${req?.version ?? "?"}`
		: req?.workflow === "tier-resize"
			? `${req?.tier ?? "?"} -> ${tierTarget || "resize"}`
			: req?.workflow === "ilm-rollout"
				? `${req?.policyName ?? "?"}: ${Object.keys(req?.phasesPatch ?? {}).join(", ") || "change"}`
				: (req?.tier ?? req?.resource ?? "change");
	const review: IacPlanReview = {
		kind: isConfigEdit ? "config-edit" : "terraform",
		cluster: req?.cluster ?? "",
		branch,
		title: `[${req?.cluster ?? "?"}] ${descriptor}: ${req?.workflow}`,
		diff: state.proposedDiff,
		plan,
		risks,
		precheckPassed,
	};
	return { terraformPlan: plan, precheckPassed, risks, planReview: review };
}

// HITL gate: surface the plan for human review. The graph pauses here; the resume
// payload carries the decision. This is the only path to opening an MR.
export function planReviewGate(state: IacStateType): Partial<IacStateType> {
	if (!state.planReview) return { reviewDecision: "rejected" };
	const message =
		state.planReview.kind === "config-edit"
			? "Review the proposed config change. Approve to open a GitLab MR, or reject. CI computes the plan on the MR; merge and apply remain manual in GitLab."
			: "Review the Terraform plan output. Approve to open a GitLab MR, or reject. Apply remains manual in GitLab.";
	const decision = interrupt({
		type: "iac_plan_review",
		review: state.planReview,
		message,
	}) as { decision?: "approved" | "rejected" };
	return { reviewDecision: decision?.decision === "approved" ? "approved" : "rejected" };
}

// Extract the merge_request web_url from callTool's "[status] {json}" response.
// (Not a regex over the whole body -- the JSON also contains avatar URLs.)
export function extractMrUrl(toolResult: string): string {
	const jsonStart = toolResult.indexOf("{");
	if (jsonStart >= 0) {
		try {
			const parsed: unknown = JSON.parse(toolResult.slice(jsonStart));
			if (typeof parsed === "object" && parsed !== null) {
				const url = (parsed as { web_url?: unknown }).web_url;
				if (typeof url === "string" && url.length > 0) return url;
			}
		} catch {
			// fall through to the raw result
		}
	}
	return toolResult;
}

// Minimal deterministic MR body, used as the fallback when the LLM step fails so the
// MR never blocks. Real bodies follow knowledge/mr-template.md (filled by the LLM).
function fallbackMrDescription(review: IacPlanReview | null): string {
	return `${review?.diff ?? ""}\n\n## Plan\n\n${review?.plan ?? ""}\n\n## Risks\n\n${(review?.risks ?? []).map((r) => `- ${r}`).join("\n")}`;
}

// Build the MR description by having the LLM fill the agent's own mr-template.md
// (already in the system prompt) per the open-mr skill, from the gathered context.
// Falls back to the deterministic stub on any error.
export async function buildMrDescription(state: IacStateType): Promise<string> {
	const review = state.planReview;
	const req = state.iacRequest;
	try {
		const sys = buildSystemPrompt(getAgentByName(AGENT));
		const context = [
			`Change: ${req?.workflow ?? "other"} on cluster ${req?.cluster ?? "?"}.`,
			req?.workflow === "version-upgrade"
				? `Elasticsearch version ${state.previousVersion || "?"} -> ${req?.version ?? "?"}.`
				: "",
			req?.workflow === "tier-resize"
				? `Tier '${req?.tier}' resize${req?.newSizeGb != null ? ` size -> ${req.newSizeGb}g` : ""}${req?.newMaxGb != null ? ` max -> ${req.newMaxGb}g` : ""}.`
				: "",
			req?.workflow === "ilm-rollout"
				? `ILM policy '${req?.policyName}' phase change: ${JSON.stringify(req?.phasesPatch ?? {})}.${state.retentionChange ? ` Retention REDUCED ${state.retentionChange.from} -> ${state.retentionChange.to} (irreversible).` : ""}`
				: "",
			req?.reason ? `Reason given: ${req.reason}.` : "",
			`Branch: ${state.branch}. Target: main.`,
			`File diff:\n${review?.diff ?? "(none)"}`,
			`Plan note: ${review?.plan ?? "(none)"}`,
		]
			.filter(Boolean)
			.join("\n");
		// Category + risk follow mr-template.md's own rules: version-bump = LOW;
		// tier size/max_size = tier-resize / MEDIUM.
		const categoryRisk =
			req?.workflow === "ilm-rollout"
				? `Category ilm, Risk ${state.retentionChange ? "HIGH" : "MEDIUM"}`
				: req?.workflow === "tier-resize"
					? "Category tier-resize, Risk MEDIUM"
					: "Category version-bump, Risk LOW";
		const instruction =
			"Write the GitLab merge request description using knowledge/mr-template.md's SECTION HEADINGS, but as an " +
			"agent-authored MR: state the single RESOLVED value per section -- do NOT reproduce the human checkbox " +
			"menus. Category, Cluster(s) affected, and Risk are one resolved line each (e.g. 'Category: tier-resize', " +
			"'Cluster(s) affected: eu-b2b', 'Risk: MEDIUM') -- never list the unselected options or empty `- [ ]` boxes. " +
			`This is a config edit committed via the GitLab API (no local terraform): use ${categoryRisk}, and mark the ` +
			"gl-testing / Plan output sections 'n/a -- config edit; CI computes the plan on the MR'. Fill Summary, " +
			"Cluster(s) affected, What changed, Why, Files touched, Rollback plan, and Reviewer notes from the context. " +
			"Append the open-mr skill footer. Output ONLY the final markdown.";
		const llm = createLlm("iacDrafter", AGENT);
		const res = await llm.invoke([new SystemMessage(`${sys}\n\n${instruction}`), new HumanMessage(context)]);
		const body = String(res.content).trim();
		return body.length > 0 ? body : fallbackMrDescription(review);
	} catch (err) {
		log.warn(
			{ err: err instanceof Error ? err.message : String(err) },
			"MR description generation failed; using fallback",
		);
		return fallbackMrDescription(review);
	}
}

// Open the MR. Never merges, never approves, never applies. For a config-edit
// (version-upgrade / tier-resize) the branch + commit already exist on the remote
// (created via the GitLab API in draftChange), so there is no git_push; legacy
// (terraform) workflows push the local branch first.
export async function openMr(state: IacStateType): Promise<Partial<IacStateType>> {
	const review = state.planReview;
	const isConfigEdit = review?.kind === "config-edit";
	if (!isConfigEdit) await callTool("git_push", { branch: state.branch });
	const description = await buildMrDescription(state);
	const mr = await callTool("gitlab_create_merge_request", {
		source_branch: state.branch,
		target_branch: "main",
		title: review?.title ?? "Elastic IaC change",
		description,
	});
	return { mrUrl: extractMrUrl(mr), mrIid: extractMrIid(mr) };
}

// MR iid from callTool's "[status] {json}" create-MR response (for the pipeline watch).
export function extractMrIid(toolResult: string): number | null {
	const jsonStart = toolResult.indexOf("{");
	if (jsonStart < 0) return null;
	try {
		const parsed = JSON.parse(toolResult.slice(jsonStart)) as { iid?: unknown };
		return typeof parsed.iid === "number" ? parsed.iid : null;
	} catch {
		return null;
	}
}

// Newest pipeline {id,status} from gitlab_get_merge_request_pipelines' "[status] [...]"
// body (the JSON array of pipelines, newest first). callTool prefixes "[<http status>] ".
export function parseNewestPipeline(toolResult: string): { id: number; status: string } | null {
	// Skip the "[200] " status prefix: find the first "[" that opens the JSON array.
	const m = toolResult.match(/\[\s*(?:\{|\])/);
	if (!m || m.index === undefined) return null;
	try {
		const parsed = JSON.parse(toolResult.slice(m.index)) as Array<{ id?: unknown; status?: unknown }>;
		if (!Array.isArray(parsed) || parsed.length === 0) return null;
		const p = parsed[0];
		if (typeof p?.id === "number") return { id: p.id, status: typeof p.status === "string" ? p.status : "unknown" };
		return null;
	} catch {
		return null;
	}
}

// SIO-877: newest open agent MR {iid,webUrl} from gitlab_list_agent_merge_requests'
// "[status] [...]" body (open MRs labeled agent-generated, newest first). The fallback
// when the thread no longer holds an mrIid (e.g. after a page reload).
export function parseLatestAgentMr(toolResult: string): { iid: number; webUrl: string } | null {
	const m = toolResult.match(/\[\s*(?:\{|\])/);
	if (!m || m.index === undefined) return null;
	try {
		const parsed = JSON.parse(toolResult.slice(m.index)) as Array<{ iid?: unknown; web_url?: unknown }>;
		if (!Array.isArray(parsed) || parsed.length === 0) return null;
		const mr = parsed[0];
		if (typeof mr?.iid === "number") return { iid: mr.iid, webUrl: typeof mr.web_url === "string" ? mr.web_url : "" };
		return null;
	} catch {
		return null;
	}
}

// Parse the terraform report tool result ("[...]"-free; it's the bare report JSON or a
// "[...]" not-ready message). Returns null when not ready.
export function parsePlanReport(toolResult: string): IacPlanReport | null {
	const jsonStart = toolResult.indexOf("{");
	if (jsonStart < 0) return null;
	try {
		const r = JSON.parse(toolResult.slice(jsonStart)) as Partial<IacPlanReport>;
		if (typeof r.create === "number" && typeof r.update === "number" && typeof r.delete === "number") {
			return { create: r.create, update: r.update, delete: r.delete, resources: r.resources ?? [] };
		}
		return null;
	} catch {
		return null;
	}
}

// Parse the approvals tool result ("[status] {json}").
export function parseApprovalState(toolResult: string): IacApprovalState | null {
	const jsonStart = toolResult.indexOf("{");
	if (jsonStart < 0) return null;
	try {
		const a = JSON.parse(toolResult.slice(jsonStart)) as {
			approved?: unknown;
			approvals_required?: unknown;
			approved_by?: Array<{ user?: { username?: unknown } }>;
		};
		return {
			approved: a.approved === true,
			required: typeof a.approvals_required === "number" ? a.approvals_required : undefined,
			approvedBy: Array.isArray(a.approved_by)
				? a.approved_by.map((x) => String(x?.user?.username ?? "")).filter(Boolean)
				: undefined,
		};
	} catch {
		return null;
	}
}

// A pipeline status is terminal when CI has stopped running.
export function isTerminalPipelineStatus(status: string): boolean {
	return ["success", "failed", "canceled", "skipped"].includes(status);
}

// One-line plan summary: "0 create / 1 update / 0 destroy".
export function formatPlanSummary(report: IacPlanReport | null): string {
	if (!report) return "plan not available";
	return `${report.create} create / ${report.update} update / ${report.delete} destroy`;
}

// SIO-878: classify a failed plan job's log into a human-readable cause hint. The
// deployments stack shares one Terraform state across all 10 clusters, so concurrent
// MRs contend on a single state lock -- the most common, recoverable failure. (Pure.)
export function classifyPipelineFailure(planLog: string): string {
	const lower = planLog.toLowerCase();
	if (lower.includes("error acquiring the state lock") || lower.includes("already locked")) {
		return (
			"Likely cause: a Terraform state-lock on the shared deployments stack (all 10 clusters share one " +
			"state, so concurrent MRs contend on a single lock). An operator can force-unlock in GitLab or wait " +
			"for the holding pipeline to finish, then re-run the plan."
		);
	}
	if (!planLog || planLog.startsWith("[")) return "The plan job log was not available to diagnose the failure.";
	return "The plan job failed for another reason -- review the job log on the MR.";
}

// SIO-875: poll the MR pipeline (bounded), then gather the real plan + approval state.
// Never hangs past the budget; teardownIac renders the result. Read-only. (Live mid-poll
// streaming is a follow-up -- the final state is rendered once here.)
export async function watchPipeline(state: IacStateType): Promise<Partial<IacStateType>> {
	// SIO-877: when the thread no longer holds the MR (e.g. a follow-up after a page
	// reload), fall back to the latest OPEN agent MR so "check my MR" still works.
	let iid = state.mrIid;
	let recoveredUrl = "";
	if (iid === null) {
		const latest = parseLatestAgentMr(await callTool("gitlab_list_agent_merge_requests", {}));
		if (!latest) {
			return {
				pipelineStatus: "unknown",
				messages: [new AIMessage("No open agent merge request to check. Propose a change first, then ask again.")],
			};
		}
		iid = latest.iid;
		recoveredUrl = latest.webUrl;
		log.info({ iid }, "recovered latest open agent MR for pipeline-status");
	}

	const budgetMs = Number(process.env.IAC_PIPELINE_POLL_BUDGET_MS ?? "90000");
	const intervalMs = Number(process.env.IAC_PIPELINE_POLL_INTERVAL_MS ?? "10000");
	const deadline = Date.now() + budgetMs;

	let pipelineId: number | null = null;
	let status = "unknown";
	while (Date.now() < deadline) {
		const newest = parseNewestPipeline(await callTool("gitlab_get_merge_request_pipelines", { iid }));
		if (newest) {
			pipelineId = newest.id;
			if (newest.status !== status) {
				status = newest.status;
				log.info({ iid, pipelineId, status }, "iac pipeline status");
				// SIO-876: stream the transition live (the SSE pump forwards this as
				// iac_pipeline_progress); the final status+plan+approval still arrive as
				// the assistant message.
				await dispatchCustomEvent("iac_pipeline_progress", { pipelineId, status });
			}
			if (isTerminalPipelineStatus(status)) break;
		}
		if (Date.now() + intervalMs >= deadline) break;
		await new Promise((r) => setTimeout(r, intervalMs));
	}

	// Persist the (possibly recovered) MR so subsequent turns reuse it; set the link
	// when we recovered it (don't clobber an existing mrUrl from this thread's openMr).
	const recovered: Partial<IacStateType> = { mrIid: iid, ...(recoveredUrl && { mrUrl: recoveredUrl }) };

	// Still running at budget: surface the partial result; a follow-up re-checks.
	if (!isTerminalPipelineStatus(status)) {
		return { ...recovered, pipelineId, pipelineStatus: status || "running" };
	}

	// Terminal: fetch the real plan + approval state.
	const planReport = pipelineId
		? parsePlanReport(await callTool("gitlab_get_pipeline_terraform_report", { pipelineId }))
		: null;
	const approvalState = parseApprovalState(await callTool("gitlab_get_merge_request_approvals", { iid }));

	// SIO-878: on failure, read the plan job log and classify the cause (e.g. state-lock).
	let failureHint = "";
	if (status === "failed" && pipelineId) {
		failureHint = classifyPipelineFailure(await callTool("gitlab_get_pipeline_plan_log", { pipelineId }));
	}
	return { ...recovered, pipelineId, pipelineStatus: status, planReport, approvalState, failureHint };
}

// ============================================================================
// SIO-882: content-drift detection + per-stack reconcile sub-flow.
// detectDrift audits every stack of one deployment; reconcileGate asks the human for a
// direction per drifted stack (a sequential interrupt loop); reconcileStack opens one
// independent, idempotent MR per chosen stack; advanceDrift walks the index. The agent
// never merges or applies -- a human reviews each MR's plan in GitLab.
// ============================================================================

// Parse a `task`-helper name list (list-stacks / list-deployments) into clean names.
// The output format is repo-defined (external Taskfile), so this is deliberately tolerant:
// drop the "[exit N]" suffix, then read line by line. A header line ("Available stacks:")
// ends with ":" and is skipped; otherwise a line's whitespace/comma tokens are accepted
// when they are ALL ident-shaped -- so a stack legitimately named "deployments" survives
// (a noise-word filter would wrongly eat it). Handles newline-, bullet-, space-, and
// comma-separated output. (Pure; unit-tested.) [Assumption A1/A3]
export function parseTaskNameList(toolResult: string): string[] {
	const body = toolResult.replace(/\n?\[exit -?\d+\]\s*$/, "");
	const names: string[] = [];
	for (const raw of body.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.endsWith(":")) continue; // skip blanks + header lines
		const stripped = line.replace(/^[-*•]\s*/, ""); // a single leading bullet
		const tokens = stripped.split(/[\s,]+/).filter(Boolean);
		if (tokens.every((t) => /^[A-Za-z0-9._-]+$/.test(t))) {
			for (const t of tokens) if (t.length > 1 && !t.startsWith("list-")) names.push(t);
		}
	}
	return [...new Set(names)];
}

// Parse iac_plan's JSON result into drift counts. The MCP tool returns clean JSON
// ({stack,deployment,drifted,create,update,delete,resources}); read leniently from the
// first "{" so any wrapping is tolerated. (Pure; unit-tested.)
export function parseStackPlanResult(
	toolResult: string,
): { create: number; update: number; delete: number; resources: Array<{ address: string; actions: string[] }> } | null {
	const jsonStart = toolResult.indexOf("{");
	if (jsonStart < 0) return null;
	try {
		const r = JSON.parse(toolResult.slice(jsonStart)) as Partial<{
			create: number;
			update: number;
			delete: number;
			resources: Array<{ address: string; actions: string[] }>;
		}>;
		if (typeof r.create === "number" && typeof r.update === "number" && typeof r.delete === "number") {
			return {
				create: r.create,
				update: r.update,
				delete: r.delete,
				resources: Array.isArray(r.resources) ? r.resources : [],
			};
		}
		return null;
	} catch {
		return null;
	}
}

// Which stack names own per-deployment JSON the agent can edit. Read lazily (process.env,
// never module-scope Bun.env -- Vite SSR throws). Defaults match the repo map (the
// deployment-config stack + the lifecycle-policies stack). [Assumption A3]
function configDeploymentStacks(): Set<string> {
	return new Set(
		(process.env.ELASTIC_IAC_CONFIG_DEPLOYMENT_STACKS ?? "deployments")
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	);
}
function configIlmStacks(): Set<string> {
	return new Set(
		(process.env.ELASTIC_IAC_CONFIG_ILM_STACKS ?? "lifecycle-policies")
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	);
}

// Pure: the config-JSON family a stack name belongs to (null = treat as HCL). Exported
// for unit testing; classifyStack adds a repo path-resolve probe on top.
export function configStackFamily(stack: string): "deployment" | "ilm" | null {
	const s = stack.toLowerCase();
	if (configDeploymentStacks().has(s)) return "deployment";
	if (configIlmStacks().has(s)) return "ilm";
	return null;
}

// Classify a stack as config-JSON (the agent can edit its per-deployment JSON) or HCL.
// Name-based family + a repo path-resolve probe (a non-2xx means the path doesn't resolve
// -> fall back to HCL, the conservative fewer-directions case). liveReconcilable is true
// only where a clean live->file mapping exists in Phase 1 (the deployment-config version
// field); HCL + ILM + tier-sizing defer reconcile-to-live.
async function classifyStack(
	stack: string,
	deployment: string,
): Promise<{ kind: "config-json" | "hcl"; configPath?: string; liveReconcilable: boolean }> {
	const family = configStackFamily(stack);
	if (family === "deployment") {
		const path = deploymentJsonPath(deploymentJsonTemplate(), deployment);
		const raw = await callTool("gitlab_get_file_content", { filePath: path });
		if (raw.startsWith("[2")) return { kind: "config-json", configPath: path, liveReconcilable: true };
	}
	if (family === "ilm") {
		// Derive the lifecycle-policies dir from the configured template (honors
		// ELASTIC_IAC_ILM_POLICY_TEMPLATE) rather than hard-coding it, so an override
		// doesn't misclassify ILM stacks as HCL.
		const probe = deploymentJsonPath(ilmPolicyTemplate(), deployment, "__probe__");
		const dir = probe.includes("/") ? probe.slice(0, probe.lastIndexOf("/")) : probe;
		const tree = await callTool("gitlab_get_repository_tree", { path: dir });
		if (tree.startsWith("[2") && tree.includes('"name"'))
			return { kind: "config-json", configPath: dir, liveReconcilable: false };
	}
	return { kind: "hcl", liveReconcilable: false };
}

// Deterministic, DATE-FREE reconcile branch per (deployment, stack, direction). Date-free
// so re-running on a later day reuses the same branch (idempotent MR). (Pure; unit-tested.)
export function reconcileBranch(deployment: string, stack: string, direction: ReconcileDirection): string {
	const slug = `${deployment}-${stack}-${direction}`
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60);
	return `agent/reconcile-${slug}`;
}

// The web_url of an OPEN agent MR whose source branch matches, from
// gitlab_list_agent_merge_requests' "[status] [...]" body. "" when none. Powers idempotent
// reuse (re-running never opens a duplicate). (Pure; unit-tested.)
export function parseAgentMrBySourceBranch(toolResult: string, branch: string): string {
	const m = toolResult.match(/\[\s*(?:\{|\])/);
	if (!m || m.index === undefined) return "";
	try {
		const arr = JSON.parse(toolResult.slice(m.index)) as Array<{ source_branch?: unknown; web_url?: unknown }>;
		if (!Array.isArray(arr)) return "";
		const found = arr.find((mr) => mr.source_branch === branch);
		return found && typeof found.web_url === "string" ? found.web_url : "";
	} catch {
		return "";
	}
}

// Stable fingerprint of a stack's drift (sorted resource changes, else the counts). Same
// drift -> same marker content -> same branch (idempotent); changed drift -> new marker
// commit. (Pure; unit-tested.)
export function driftFingerprint(stack: {
	resources: Array<{ address: string; actions: string[] }>;
	create: number;
	update: number;
	delete: number;
}): string {
	const addresses = stack.resources
		.map((r) => `${r.actions.join("+")} ${r.address}`)
		.sort()
		.join("\n");
	const basis = addresses || `${stack.create}/${stack.update}/${stack.delete}`;
	return createHash("sha1").update(basis).digest("hex").slice(0, 12);
}

// The first semver-shaped version in the live Elastic Cloud deployment detail (best-effort;
// used for the deployment-config reconcile-to-live mapping). (Pure; unit-tested.)
export function extractLiveVersion(deploymentDetail: string): string {
	// Prefer the Elasticsearch service version from the structured deployment detail so an
	// unrelated "version" field (Kibana, integrations server, plan metadata) can't be
	// picked up; fall back to the first semver only when parsing fails / the shape differs.
	try {
		const jsonStart = deploymentDetail.indexOf("{");
		if (jsonStart >= 0) {
			const parsed = JSON.parse(deploymentDetail.slice(jsonStart)) as {
				resources?: {
					elasticsearch?: Array<{
						info?: {
							version?: unknown;
							plan_info?: { current?: { plan?: { elasticsearch?: { version?: unknown } } } };
						};
					}>;
				};
			};
			const info = parsed.resources?.elasticsearch?.[0]?.info;
			const v = info?.version ?? info?.plan_info?.current?.plan?.elasticsearch?.version;
			if (typeof v === "string" && v.length > 0) return v;
		}
	} catch {
		// fall through to the regex
	}
	const m = deploymentDetail.match(/"version"\s*:\s*"(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)"/);
	return m?.[1] ?? "";
}

// Agent-side path template for the reconcile-to-json marker. ${stack}/${deployment} are
// literal placeholders. The marker is plan-neutral (Terraform does not auto-load a
// .agent-reconcile/*.json file) but lives under the stack dir so the per-stack
// plan:<deployment>:<stack> job's `changes:` rule triggers. [Assumption A2 -- validate the
// path against the repo's .gitlab-ci.yml] Lazy process.env read (no module-scope Bun.env).
function reconcileMarkerTemplate(): string {
	return process.env.ELASTIC_IAC_RECONCILE_MARKER_TEMPLATE ?? "stacks/${stack}/.agent-reconcile/${deployment}.json";
}
function reconcileMarkerPath(deployment: string, stack: string): string {
	return reconcileMarkerTemplate()
		.replace(/\$\{stack\}/g, stack)
		.replace(/\$\{deployment\}/g, deployment);
}
function reconcileMarkerContent(deployment: string, stack: StackDrift): string {
	const body = {
		reconcile: "reconcile-to-json",
		deployment,
		stack: stack.stack,
		driftFingerprint: driftFingerprint(stack),
		note: "Agent-generated reconcile marker (Terraform ignores this file). Merging re-runs the stack plan to revert live drift; a human approves and applies.",
	};
	return `${JSON.stringify(body, null, 2)}\n`;
}

function buildReconcileMrBody(
	deployment: string,
	stack: StackDrift,
	direction: ReconcileDirection,
	filePath: string,
): string {
	const summary = `${stack.create} create / ${stack.update} update / ${stack.delete} destroy`;
	const lines = [
		`## Reconcile: ${stack.stack} on ${deployment}`,
		"",
		direction === "reconcile-to-live"
			? `Direction: **reconcile to live** -- the repo config is updated to match the live cluster. After merge, the next plan for \`${stack.stack}\` should show no changes.`
			: `Direction: **reconcile to declared config** -- this re-asserts the repo's declared state. The MR pipeline's \`plan:${deployment}:${stack.stack}\` job shows the live drift it will revert. Review the plan, then merge and apply.`,
		"",
		`Detected drift: ${summary}.`,
		stack.resources.length > 0
			? `\nResources:\n${stack.resources
					.slice(0, 20)
					.map((r) => `- ${r.actions.join("+")} ${r.address}`)
					.join("\n")}`
			: "",
		`\nFile touched: \`${filePath}\``,
		"",
		"Agent-generated. I never merge or apply; review the plan and apply manually in GitLab.",
	];
	return lines.filter((l) => l !== "").join("\n");
}

// reconcile-to-live (deployment-config version only, Phase 1): write the LIVE version into
// the repo JSON via the existing read-modify-write helper.
async function buildLiveVersionReconcile(
	deployment: string,
	configPath: string,
): Promise<{ content: string; from: string; to: string } | { blocked: string }> {
	const deploymentId = await resolveDeploymentId(deployment);
	if (!deploymentId) return { blocked: `Could not resolve a live Elastic Cloud deployment id for '${deployment}'.` };
	const detail = await callTool("elastic_cloud_get_deployment", { deploymentId });
	const liveVersion = extractLiveVersion(detail);
	if (!liveVersion) return { blocked: "Could not read the live Elasticsearch version to reconcile." };
	const raw = await callTool("gitlab_get_file_content", { filePath: configPath });
	if (!raw.startsWith("[2")) return { blocked: `Could not read ${configPath} from the repo.` };
	try {
		const updated = setDeploymentVersion(extractFileContent(raw), liveVersion);
		return { content: updated.content, from: updated.previous ?? "?", to: liveVersion };
	} catch {
		return { blocked: `${configPath} did not parse as JSON.` };
	}
}

// Open one independent, idempotent MR for a stack + direction (or block with a reason).
// Reuses an existing open agent MR on the deterministic branch rather than duplicating.
async function openReconcileMr(
	deployment: string,
	stack: StackDrift,
	direction: ReconcileDirection,
): Promise<ReconcileResult> {
	const branch = reconcileBranch(deployment, stack.stack, direction);

	const existing = parseAgentMrBySourceBranch(await callTool("gitlab_list_agent_merge_requests", {}), branch);
	if (existing) return { stack: stack.stack, direction, status: "reused", mrUrl: existing, branch };

	let filePath: string;
	let content: string;
	let commitMessage: string;
	let title: string;

	if (direction === "reconcile-to-live") {
		if (!stack.liveReconcilable || !stack.configPath) {
			return {
				stack: stack.stack,
				direction,
				status: "blocked",
				note: "reconcile-to-live is not supported for this stack in Phase 1; use reconcile-to-json.",
			};
		}
		const built = await buildLiveVersionReconcile(deployment, stack.configPath);
		if ("blocked" in built) return { stack: stack.stack, direction, status: "blocked", note: built.blocked, branch };
		filePath = stack.configPath;
		content = built.content;
		commitMessage = `${deployment}: reconcile ${stack.stack} to live (version ${built.from} -> ${built.to})`;
		title = `[${deployment}] reconcile ${stack.stack} to live`;
	} else {
		// reconcile-to-json: a deterministic, plan-neutral marker that triggers the stack plan.
		filePath = reconcileMarkerPath(deployment, stack.stack);
		content = reconcileMarkerContent(deployment, stack);
		commitMessage = `${deployment}: reconcile ${stack.stack} to declared config`;
		title = `[${deployment}] reconcile ${stack.stack} to declared config`;
	}

	// Create the branch (tolerate "already exists" 4xx, like the proposers) and commit.
	await callTool("gitlab_create_branch", { branch, ref: "main" });
	const commit = await callTool("gitlab_commit_file", {
		branch,
		file_path: filePath,
		content,
		commit_message: commitMessage,
	});
	// A failed commit (4xx auth/validation/bad-path or 5xx) must block -- otherwise we'd open
	// an MR on a branch with no change. The early MR-reuse check above already short-circuits
	// the idempotent re-run, so a 4xx here is a real failure.
	if (commit.startsWith("[4") || commit.startsWith("[5")) {
		return { stack: stack.stack, direction, status: "blocked", note: `Commit failed: ${commit.slice(0, 120)}`, branch };
	}

	const description = buildReconcileMrBody(deployment, stack, direction, filePath);
	const mr = await callTool("gitlab_create_merge_request", {
		source_branch: branch,
		target_branch: "main",
		title,
		description,
	});
	// Only a 409 (MR already exists for this branch) is a reuse; any other 4xx/5xx is a real
	// failure and must block (never report a successful reconcile with an empty MR url).
	if (mr.startsWith("[409")) {
		const reuse = parseAgentMrBySourceBranch(await callTool("gitlab_list_agent_merge_requests", {}), branch);
		return reuse
			? { stack: stack.stack, direction, status: "reused", mrUrl: reuse, branch }
			: {
					stack: stack.stack,
					direction,
					status: "blocked",
					note: "MR already exists but could not be resolved.",
					branch,
				};
	}
	if (mr.startsWith("[4") || mr.startsWith("[5")) {
		return {
			stack: stack.stack,
			direction,
			status: "blocked",
			note: `MR creation failed: ${mr.slice(0, 120)}`,
			branch,
		};
	}
	return { stack: stack.stack, direction, status: "opened", mrUrl: extractMrUrl(mr), branch };
}

// Resolve the target deployment for a drift audit from the user's text, matched against
// the repo's known deployments (so a typo doesn't run N plans against nothing).
async function resolveDriftDeployment(state: IacStateType): Promise<string> {
	if (state.targetDeployment) return state.targetDeployment;
	const query = lastHumanText(state).toLowerCase();
	const listed = parseTaskNameList(await callTool("iac_list_deployments", {}));
	return listed.find((d) => query.includes(d.toLowerCase())) ?? "";
}

function driftedStacks(state: IacStateType): StackDrift[] {
	return (state.driftReport?.stacks ?? []).filter((s) => s.drifted);
}

// Audit every stack of one deployment for drift. Resolves the deployment (asking once via
// an iac_clarify interrupt when it's not named), enumerates stacks, runs the read-only
// iac_plan per stack, classifies each, and emits the full report once (iac_drift_report)
// for the UI overview. No writes here.
export async function detectDrift(state: IacStateType): Promise<Partial<IacStateType>> {
	let deployment = await resolveDriftDeployment(state);
	if (!deployment) {
		const answer = interrupt({
			type: "iac_clarify",
			question: "Which deployment should I check for drift? (e.g. gl-testing)",
			message: "Which deployment should I check for drift? (e.g. gl-testing)",
		}) as { answer?: string };
		deployment = (answer?.answer ?? "").trim();
	}
	if (!deployment) {
		return {
			messages: [new AIMessage('I need a deployment name to check for drift. Try: "check gl-testing for drift".')],
		};
	}

	const stacks = parseTaskNameList(await callTool("iac_list_stacks", {}));
	if (stacks.length === 0) {
		return {
			targetDeployment: deployment,
			messages: [
				new AIMessage(
					`Could not list the stacks to audit for '${deployment}'. Is the elastic-iac server connected and its repo workspace initialized?`,
				),
			],
		};
	}

	const stackDrifts: StackDrift[] = [];
	for (const stack of stacks) {
		const counts = parseStackPlanResult(await callTool("iac_plan", { stack, deployment }));
		const { kind, configPath, liveReconcilable } = await classifyStack(stack, deployment);
		const create = counts?.create ?? 0;
		const update = counts?.update ?? 0;
		const del = counts?.delete ?? 0;
		stackDrifts.push({
			stack,
			// A null plan result means iac_plan could not be read (task failure / unknown
			// format). Surface it as planError rather than silently reporting "no drift" --
			// a false "clean" would skip reconciliation for a stack we never assessed.
			planError: counts === null,
			drifted: counts !== null && create + update + del > 0,
			kind,
			create,
			update,
			delete: del,
			resources: counts?.resources ?? [],
			...(configPath && { configPath }),
			liveReconcilable,
		});
	}

	const driftReport: DriftReport = { deployment, stacks: stackDrifts, generatedAt: new Date().toISOString() };
	// Emit the full report once for the UI overview (forwarded by the SSE pump).
	await dispatchCustomEvent("iac_drift_report", {
		deployment,
		stacks: stackDrifts.map((s) => ({
			stack: s.stack,
			drifted: s.drifted,
			planError: s.planError ?? false,
			kind: s.kind,
			create: s.create,
			update: s.update,
			delete: s.delete,
			resources: s.resources,
		})),
	});

	return { targetDeployment: deployment, driftReport, driftIndex: 0, reconcileResults: [] };
}

// HITL gate for the stack at driftIndex. Pauses (interrupt) asking the human to pick a
// reconcile direction; the resume payload carries { direction }. reconcile-to-live is
// offered only where a clean live->file mapping exists (liveReconcilable).
export function reconcileGate(state: IacStateType): Partial<IacStateType> {
	const drifted = driftedStacks(state);
	const current = drifted[state.driftIndex];
	if (!current) return { currentDirection: "skip" };

	const directions: ReconcileDirection[] = current.liveReconcilable
		? ["reconcile-to-live", "reconcile-to-json", "skip"]
		: ["reconcile-to-json", "skip"];
	const summary = `${current.create} create / ${current.update} update / ${current.delete} destroy`;
	const choice = interrupt({
		type: "iac_reconcile_choice",
		stack: current.stack,
		kind: current.kind,
		summary,
		directions,
		message:
			`Stack '${current.stack}' (${state.driftIndex + 1} of ${drifted.length}) has drifted: ${summary}. ` +
			"Reconcile toward live, toward the declared config (opens an MR; CI shows the revert), or skip.",
	}) as { direction?: ReconcileDirection };

	const dir = choice?.direction;
	const valid: ReconcileDirection = dir && directions.includes(dir) ? dir : "skip";
	return { currentDirection: valid };
}

// Act on the chosen direction for the stack at driftIndex -- open one independent,
// idempotent MR (reconcile-to-live or reconcile-to-json) or record a skip. Emits a
// per-stack result for the UI as each MR resolves.
export async function reconcileStack(state: IacStateType): Promise<Partial<IacStateType>> {
	const drifted = driftedStacks(state);
	const current = drifted[state.driftIndex];
	const direction = state.currentDirection ?? "skip";
	if (!current) return {};

	const result: ReconcileResult =
		direction === "skip"
			? { stack: current.stack, direction: "skip", status: "skipped" }
			: await openReconcileMr(state.targetDeployment, current, direction);

	await dispatchCustomEvent("iac_reconcile_result", {
		stack: result.stack,
		direction: result.direction,
		status: result.status,
		...(result.mrUrl && { mrUrl: result.mrUrl }),
		...(result.note && { note: result.note }),
	});

	return { reconcileResults: [...state.reconcileResults, result] };
}

// Step to the next drifted stack (the gate->worker->advance loop re-enters reconcileGate
// until every drifted stack is processed). Clears the per-stack direction.
export function advanceDrift(state: IacStateType): Partial<IacStateType> {
	return { driftIndex: state.driftIndex + 1, currentDirection: null };
}

// The drift flow's terminal message -- per-stack outcomes (MR opened/reused, skipped,
// blocked) + the apply reminder. (Pure; reads only state.)
export function formatDriftSummary(state: IacStateType): string {
	const dep = state.targetDeployment || "(unknown)";
	const all = state.driftReport?.stacks ?? [];
	const drifted = all.filter((s) => s.drifted);
	const planErrored = all.filter((s) => s.planError);
	// Stacks whose plan could not be read were NOT assessed -- never imply they are clean.
	const errSuffix =
		planErrored.length > 0
			? ` ${planErrored.length} stack(s) could NOT be planned and were not assessed: ${planErrored.map((s) => s.stack).join(", ")}.`
			: "";
	if (drifted.length === 0) {
		const planned = all.length - planErrored.length;
		return `No drift detected for ${dep} across the ${planned} stack(s) I could plan.${errSuffix}`;
	}
	const lines = [`Drift reconcile summary for ${dep} (${drifted.length} drifted stack(s)):`];
	for (const r of state.reconcileResults) {
		if (r.status === "opened") lines.push(`  ${r.stack}: MR opened (${r.direction}) -> ${r.mrUrl}`);
		else if (r.status === "reused") lines.push(`  ${r.stack}: existing MR reused (${r.direction}) -> ${r.mrUrl}`);
		else if (r.status === "skipped") lines.push(`  ${r.stack}: skipped`);
		else lines.push(`  ${r.stack}: blocked -- ${r.note ?? "see logs"}`);
	}
	const handled = new Set(state.reconcileResults.map((r) => r.stack));
	for (const s of drifted) if (!handled.has(s.stack)) lines.push(`  ${s.stack}: not processed`);
	if (errSuffix) lines.push(`Note:${errSuffix}`);
	lines.push("Review each MR's plan in GitLab, then merge and apply. I never merge or apply.");
	return lines.join("\n");
}

// Final message: MR link + pipeline status + the real plan + approval state, then stop.
export function teardownIac(state: IacStateType): Partial<IacStateType> {
	// SIO-882: the drift flow renders its own per-stack reconcile summary.
	if (state.intent === "drift") {
		return { messages: [new AIMessage(formatDriftSummary(state))] };
	}
	if (state.reviewDecision === "rejected") {
		return { messages: [new AIMessage("Plan rejected. No MR opened. Nothing was applied.")] };
	}
	const lines: string[] = [state.mrUrl ? `MR opened: ${state.mrUrl}` : "MR step complete."];

	if (state.pipelineStatus && state.pipelineStatus !== "unknown") {
		const pid = state.pipelineId ? `#${state.pipelineId}` : "";
		lines.push(`Pipeline ${pid}: ${state.pipelineStatus}`);
	}
	if (state.planReport) {
		lines.push(`Plan: ${formatPlanSummary(state.planReport)}`);
		for (const r of state.planReport.resources.slice(0, 10)) {
			lines.push(`  ${r.actions.join("+")} ${r.address}`);
		}
	} else if (isTerminalPipelineStatus(state.pipelineStatus)) {
		lines.push("Plan: not available from the pipeline report.");
		// SIO-878: when the pipeline failed, explain the likely cause.
		if (state.failureHint) lines.push(state.failureHint);
	} else if (state.pipelineStatus) {
		lines.push('Pipeline still running — ask "check my MR" to refresh the plan + approval.');
	}
	if (state.approvalState) {
		const by = state.approvalState.approvedBy?.length ? ` by ${state.approvalState.approvedBy.join(", ")}` : "";
		const req = state.approvalState.required != null ? ` (${state.approvalState.required} required)` : "";
		lines.push(`Approval: ${state.approvalState.approved ? `approved${by}` : "not approved"}${req}`);
	}
	lines.push("Review and apply manually in GitLab. I never merge or apply.");
	return { messages: [new AIMessage(lines.join("\n"))] };
}
