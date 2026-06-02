// agent/src/iac/nodes.ts
import { buildSystemPrompt } from "@devops-agent/gitagent-bridge";
import { getLogger } from "@devops-agent/observability";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod";
import { createLlm } from "../llm.ts";
import { getConnectedServers, getToolsForDataSource } from "../mcp-bridge.ts";
import { getAgentByName } from "../prompt-context.ts";
import { evaluateGuards } from "./guards.ts";
import type { IacPlanReview, IacRequest, IacStateType } from "./state.ts";

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

const IntentSchema = z.object({
	workflow: z.enum(["tier-resize", "ilm-rollout", "other"]).default("other"),
	cluster: z.string().optional(),
	tier: z.string().optional(),
	resource: z.string().optional(),
	newSizeGb: z.number().optional(),
	newMaxGb: z.number().optional(),
	policyName: z.string().optional(),
	reason: z.string().optional(),
	isProd: z.boolean().default(false),
	clarification: z.string().optional(),
});

function parseIntentJson(raw: string): IacRequest {
	const match = raw.match(/\{[\s\S]*\}/);
	if (match) {
		try {
			const parsed = IntentSchema.safeParse(JSON.parse(match[0]));
			if (parsed.success) return parsed.data;
		} catch {
			// fall through to the safe default below
		}
	}
	return { workflow: "other", isProd: false, clarification: "Which cluster and what change should I make?" };
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
		"workflow ('tier-resize'|'ilm-rollout'|'other'), cluster, tier, resource, newSizeGb, newMaxGb, " +
		"policyName, reason, isProd (true only if the user explicitly named a production cluster), and " +
		"clarification (a single direct question to ask ONLY when the cluster or change is ambiguous). " +
		"Respond with ONLY the JSON object.";

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

// Read live cluster state (topology, plan history, ILM, health) before drafting.
export async function readClusterState(state: IacStateType): Promise<Partial<IacStateType>> {
	const req = state.iacRequest;
	const cluster = req?.cluster ?? "";
	const summary = await callTool("elastic_cloud_get_deployment", { cluster });
	const alerts = await callTool("elastic_ilm_get_lifecycle", { cluster, policy: ".alerts" });
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

function branchName(req: IacRequest): string {
	const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
	const slug = [req.cluster, req.tier ?? req.resource, req.workflow]
		.filter(Boolean)
		.join("-")
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.slice(0, 40);
	return `agent/${slug}-${date}`;
}

// Draft the minimal Terraform diff on a fresh branch (never main; never apply).
export async function draftChange(state: IacStateType): Promise<Partial<IacStateType>> {
	const req = state.iacRequest;
	if (!req) return {};
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

// Run fmt/validate/plan + gl-testing pre-check and assemble the review payload.
export async function reviewPlan(state: IacStateType): Promise<Partial<IacStateType>> {
	const req = state.iacRequest;
	const branch = state.branch;
	await callTool("terraform_validate", { branch });
	const plan = await callTool("terraform_plan", { branch, cluster: req?.cluster });
	const precheckPassed = !plan.startsWith("[") && !/error/i.test(plan);

	const risks: string[] = [];
	if (req?.tier === "hot") risks.push("Hot-tier change can trigger shard relocation; apply off-peak.");
	if (req?.workflow === "ilm-rollout")
		risks.push("ILM phase change can pull frozen data in and cause force-merge load.");

	const review: IacPlanReview = {
		cluster: req?.cluster ?? "",
		branch,
		title: `[${req?.cluster ?? "?"}] ${req?.tier ?? req?.resource ?? "change"}: ${req?.workflow}`,
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
	const decision = interrupt({
		type: "iac_plan_review",
		review: state.planReview,
		message:
			"Review the Terraform plan output. Approve to open a GitLab MR, or reject. Apply remains manual in GitLab.",
	}) as { decision?: "approved" | "rejected" };
	return { reviewDecision: decision?.decision === "approved" ? "approved" : "rejected" };
}

// Push the branch and open the MR. Never merges, never approves, never applies.
export async function openMr(state: IacStateType): Promise<Partial<IacStateType>> {
	const review = state.planReview;
	await callTool("git_push", { branch: state.branch });
	const mr = await callTool("gitlab_create_merge_request", {
		source_branch: state.branch,
		target_branch: "main",
		title: review?.title ?? "Elastic IaC change",
		description: `${review?.diff ?? ""}\n\n## Plan\n\n${review?.plan ?? ""}\n\n## Risks\n\n${(review?.risks ?? []).map((r) => `- ${r}`).join("\n")}`,
	});
	const urlMatch = mr.match(/https?:\/\/\S+/);
	return { mrUrl: urlMatch?.[0] ?? mr };
}

// Final message: post the MR link (or the terminal reason) and stop.
export function teardownIac(state: IacStateType): Partial<IacStateType> {
	if (state.reviewDecision === "rejected") {
		return { messages: [new AIMessage("Plan rejected. No MR opened. Nothing was applied.")] };
	}
	const link = state.mrUrl ? `MR opened: ${state.mrUrl}` : "MR step complete.";
	return {
		messages: [new AIMessage(`${link}\n\nReview and apply manually in GitLab. I never merge or apply.`)],
	};
}
