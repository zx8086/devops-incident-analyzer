// agent/src/iac/nodes.ts
import { buildSystemPrompt } from "@devops-agent/gitagent-bridge";
import { getLogger } from "@devops-agent/observability";
import { AIMessage, type BaseMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod";
import { createLlm, createLlmWithTools } from "../llm.ts";
import { getConnectedServers, getToolsForDataSource } from "../mcp-bridge.ts";
import { getAgentByName } from "../prompt-context.ts";
import { evaluateGuards } from "./guards.ts";
import type { IacApprovalState, IacPlanReport, IacPlanReview, IacRequest, IacStateType } from "./state.ts";

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

// Map a raw classifier reply to an intent. "gitops" and "pipeline-status" are explicit;
// anything else defaults to "info". (Pure; unit-tested directly.)
export function intentFromText(raw: string): "info" | "gitops" | "pipeline-status" {
	const r = raw.toLowerCase();
	if (r.includes("pipeline-status") || r.includes("pipeline_status")) return "pipeline-status";
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
		"- 'gitops': a request to CHANGE infrastructure (resize, downsize, add/modify ILM, import, open an MR, " +
		"anything that should produce a Terraform diff).\n" +
		"- 'pipeline-status': a follow-up about a merge request the agent already opened -- 'did the pipeline " +
		"pass/fail', 'check my MR', 'show me the plan', 'is it approved', 'what's the CI status'.\n" +
		"Reply with ONLY one word: 'info', 'gitops', or 'pipeline-status'. " +
		"If the user asks for a recommendation or 'should I…' that implies a change, answer 'gitops'.";
	const res = await llm.invoke([new SystemMessage(sys), new HumanMessage(query)]);
	let intent = intentFromText(String(res.content));
	// pipeline-status only makes sense once an MR exists in this thread; else treat as info.
	if (intent === "pipeline-status" && state.mrIid === null) intent = "info";
	log.info({ intent, query }, "classified IaC intent");
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
		"newMaxGb, policyName, version, reason, isProd (true only if the user explicitly named a production " +
		"cluster), and clarification. " +
		"For an Elasticsearch version upgrade ('upgrade X to 9.4.2', 'bump Y to 8.15'), set workflow to " +
		"'version-upgrade', cluster to the named deployment, and version to the explicit target version string. " +
		"Set clarification (a single direct question) ONLY when a required field is genuinely missing -- e.g. no " +
		"cluster named, or an upgrade with no concrete target version ('upgrade to latest'). Do NOT ask for " +
		"information the user already provided. Respond with ONLY the JSON object.";

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

// Resolve the per-deployment JSON path from the configured template + cluster name.
// The template carries a literal "${cluster}" placeholder (it is config, not a JS
// template literal), so substitute it explicitly.
export function deploymentJsonPath(template: string, cluster: string): string {
	return template.replace(/\$\{cluster\}/g, cluster);
}

// Pure branch slug from the request descriptor: cluster-<descriptor>-workflow.
// For a version-upgrade the descriptor is the target version (e.g. "9-4-2").
// (Exported for unit testing; branchName appends agent/ + the date.)
export function branchSlug(req: IacRequest): string {
	const descriptor = req.workflow === "version-upgrade" ? req.version : (req.tier ?? req.resource);
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

// Draft the change. version-upgrade goes through the GitOps proposer (JSON edit via
// the GitLab API); other workflows still draft a Terraform diff locally (legacy path).
export async function draftChange(state: IacStateType): Promise<Partial<IacStateType>> {
	const req = state.iacRequest;
	if (!req) return {};
	if (req.workflow === "version-upgrade") return proposeVersionUpgrade(state, req);

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

	let plan: string;
	let precheckPassed: boolean;
	if (isUpgrade) {
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
	if (req?.workflow === "ilm-rollout")
		risks.push("ILM phase change can pull frozen data in and cause force-merge load.");
	if (isUpgrade) {
		risks.push(
			"Version upgrades are rolling and irreversible; confirm the target is a valid forward step and apply off-peak.",
		);
		risks.push("CCS/CCR: the local cluster must stay <= 1 minor ahead of every remote -- audit before merge.");
	}

	// version-upgrade descriptor shows the version transition; tier/resize use tier/resource.
	const descriptor = isUpgrade
		? `${state.previousVersion || "?"} -> ${req?.version ?? "?"}`
		: (req?.tier ?? req?.resource ?? "change");
	const review: IacPlanReview = {
		kind: isUpgrade ? "config-edit" : "terraform",
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
			req?.reason ? `Reason given: ${req.reason}.` : "",
			`Branch: ${state.branch}. Target: main.`,
			`File diff:\n${review?.diff ?? "(none)"}`,
			`Plan note: ${review?.plan ?? "(none)"}`,
		]
			.filter(Boolean)
			.join("\n");
		const instruction =
			"Write the GitLab merge request description using knowledge/mr-template.md's SECTION HEADINGS, but as an " +
			"agent-authored MR: state the single RESOLVED value per section -- do NOT reproduce the human checkbox " +
			"menus. Category, Cluster(s) affected, and Risk are one resolved line each (e.g. 'Category: version-bump', " +
			"'Cluster(s) affected: ap-cld', 'Risk: LOW') -- never list the unselected options or empty `- [ ]` boxes. " +
			"This is a config edit committed via the GitLab API (no local terraform): for a version bump use Category " +
			"version-bump, Risk LOW, and mark the gl-testing / Plan output sections 'n/a -- config edit; CI computes " +
			"the plan on the MR'. Fill Summary, Cluster(s) affected, What changed, Why, Files touched, Rollback plan, " +
			"and Reviewer notes from the context. Append the open-mr skill footer. Output ONLY the final markdown.";
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

// Open the MR. Never merges, never approves, never applies. For version-upgrade the
// branch + commit already exist on the remote (created via the GitLab API in
// draftChange), so there is no git_push; other workflows push the local branch first.
export async function openMr(state: IacStateType): Promise<Partial<IacStateType>> {
	const review = state.planReview;
	const isUpgrade = state.iacRequest?.workflow === "version-upgrade";
	if (!isUpgrade) await callTool("git_push", { branch: state.branch });
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

// SIO-875: poll the MR pipeline (bounded), then gather the real plan + approval state.
// Never hangs past the budget; teardownIac renders the result. Read-only. (Live mid-poll
// streaming is a follow-up -- the final state is rendered once here.)
export async function watchPipeline(state: IacStateType): Promise<Partial<IacStateType>> {
	const iid = state.mrIid;
	if (iid === null) return { pipelineStatus: "unknown" };

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
			}
			if (isTerminalPipelineStatus(status)) break;
		}
		if (Date.now() + intervalMs >= deadline) break;
		await new Promise((r) => setTimeout(r, intervalMs));
	}

	// Still running at budget: surface the partial result; a follow-up re-checks.
	if (!isTerminalPipelineStatus(status)) {
		return { pipelineId, pipelineStatus: status || "running" };
	}

	// Terminal: fetch the real plan + approval state.
	const planReport = pipelineId
		? parsePlanReport(await callTool("gitlab_get_pipeline_terraform_report", { pipelineId }))
		: null;
	const approvalState = parseApprovalState(await callTool("gitlab_get_merge_request_approvals", { iid }));
	return { pipelineId, pipelineStatus: status, planReport, approvalState };
}

// Final message: MR link + pipeline status + the real plan + approval state, then stop.
export function teardownIac(state: IacStateType): Partial<IacStateType> {
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
