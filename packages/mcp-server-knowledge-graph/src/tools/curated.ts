// src/tools/curated.ts
//
// SIO-967: the curated, read-only graph tools, one per packages/knowledge-graph
// reader. They are the MCP-standardized successor to the SIO-966 in-process
// local-tools.ts (createQueryKnowledgeGraphTool). No raw Cypher -> injection-safe;
// all values bind as params inside the readers. Each tool soft-fails to a friendly
// string when the graph is disabled/unavailable so a turn degrades instead of
// erroring (mirrors the SIO-966 runKnowledgeGraphQuery wording).

import {
	appliedChanges,
	changeHistoryForStackInstance,
	deploymentsRunningStack,
	type GraphStore,
	getGraphStore,
	ipToWorkload,
	networkMapForService,
	priorChangesForDeployment,
	priorRootCauses,
	stacksUsingModule,
	successfulPromptChanges,
} from "@devops-agent/knowledge-graph";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { text } from "./shared.ts";

// SIO-968: loud-fail strings. When the graph cannot answer, the model MUST NOT
// silently substitute prose from loaded specs/runbooks -- the disabled/unavailable
// state is surfaced as an explicit instruction so the agent reports the answer as
// unverified instead of fabricating a confident one.
const GRAPH_DISABLED =
	"KNOWLEDGE GRAPH UNAVAILABLE (disabled for this process). Do NOT answer from memory, " +
	"specs, or runbooks -- you have no graph evidence. Tell the user the knowledge graph is " +
	"disabled and the answer cannot be verified.";
const GRAPH_UNAVAILABLE =
	"KNOWLEDGE GRAPH UNAVAILABLE (store could not be opened). Do NOT answer from memory, " +
	"specs, or runbooks -- you have no graph evidence. Tell the user the knowledge graph is " +
	"unavailable and the answer cannot be verified.";

// SIO-968: gate on the SERVER'S STARTUP CONFIG, not a per-call process.env re-read.
// The earlier per-call isKnowledgeGraphEnabled() read process.env at request time,
// which diverged from the value the server booted with (e.g. a --env-file launch that
// repopulated process.env without the flag), so tools reported "disabled" even though
// the server was started enabled. Capturing `enabled` at registration removes that skew.
function makeResolveStore(enabled: boolean): () => Promise<GraphStore | string> {
	return async () => {
		if (!enabled) return GRAPH_DISABLED;
		try {
			return await getGraphStore();
		} catch {
			return GRAPH_UNAVAILABLE;
		}
	};
}

export function registerCuratedTools(server: McpServer, enabled: boolean): void {
	const resolveStore = makeResolveStore(enabled);
	server.tool(
		"kg_deployments_running_stack",
		"Blast radius: which Elastic deployments run a given stack (cross-deployment). Read-only; no Cypher.",
		{ stack: z.string().min(1).describe("Stack name, e.g. slos") },
		async ({ stack }) => {
			const store = await resolveStore();
			if (typeof store === "string") return text(store);
			const rows = await deploymentsRunningStack(store, stack);
			return text(
				rows.length > 0
					? `Deployments running the ${stack} stack: ${rows.join(", ")}. (Graph result -- authoritative.)`
					: `Graph queried: no deployment runs the ${stack} stack (the stack may not exist or is unseeded). Report this graph result; do not substitute a guess from specs.`,
			);
		},
	);

	server.tool(
		"kg_stacks_using_module",
		"Blast radius: which stacks wire a given module (cross-stack reuse). Read-only; no Cypher.",
		{ module: z.string().min(1).describe("Module name, e.g. lifecycle") },
		async ({ module }) => {
			const store = await resolveStore();
			if (typeof store === "string") return text(store);
			const rows = await stacksUsingModule(store, module);
			return text(
				rows.length > 0
					? `Stacks using the ${module} module: ${rows.join(", ")}. (Graph result -- authoritative.)`
					: `Graph queried: no stack uses the ${module} module (the module may not exist or is unseeded). Report this graph result; do not substitute a guess from specs.`,
			);
		},
	);

	server.tool(
		"kg_stack_instance_history",
		"Recent change history for one (deployment, stack) cell, with outcome. Read-only; no Cypher.",
		{
			deployment: z.string().min(1).describe("Deployment name, e.g. eu-b2b"),
			stack: z.string().min(1).describe("Stack name, e.g. slos"),
		},
		async ({ deployment, stack }) => {
			const store = await resolveStore();
			if (typeof store === "string") return text(store);
			const id = `${deployment}/${stack}`;
			const rows = await changeHistoryForStackInstance(store, id);
			if (rows.length === 0)
				return text(`Graph queried: no recorded changes for ${id}. Report this; do not invent a history from specs.`);
			const lines = rows.map((c) => {
				const wf = c.workflow ? `${c.workflow}: ` : "";
				const mr = c.mrUrl ? ` (${c.mrUrl})` : "";
				return `- [${c.outcome}] ${wf}${c.summary}${mr}`;
			});
			return text(`Recent changes to ${id}:\n${lines.join("\n")}`);
		},
	);

	server.tool(
		"kg_deployment_history",
		"Recent IaC change history for one deployment, most-recent first. Read-only; no Cypher.",
		{ deployment: z.string().min(1).describe("Deployment name, e.g. eu-b2b") },
		async ({ deployment }) => {
			const store = await resolveStore();
			if (typeof store === "string") return text(store);
			const rows = await priorChangesForDeployment(store, deployment);
			if (rows.length === 0)
				return text(
					`Graph queried: no recorded changes for ${deployment}. Report this; do not invent a history from specs.`,
				);
			const lines = rows.map((c) => {
				const wf = c.workflow ? `${c.workflow}: ` : "";
				const mr = c.mrUrl ? ` (${c.mrUrl})` : "";
				return `- ${wf}${c.summary}${mr}`;
			});
			return text(`Recent changes to ${deployment}:\n${lines.join("\n")}`);
		},
	);

	// SIO-1026: "have we seen this root cause before, and what resolved it".
	server.tool(
		"kg_prior_root_causes",
		"Prior incidents that shared a root-cause class (e.g. a correlation rule name), with any runbook that resolved them. Read-only; no Cypher.",
		{
			causeClass: z.string().min(1).describe("Root-cause class, e.g. the correlation rule name kafka-significant-lag"),
		},
		async ({ causeClass }) => {
			const store = await resolveStore();
			if (typeof store === "string") return text(store);
			const rows = await priorRootCauses(store, causeClass);
			if (rows.length === 0)
				return text(
					`Graph queried: no prior incident recorded the ${causeClass} root cause. Report this; do not invent a history from specs.`,
				);
			const lines = rows.map((r) => {
				const rb = r.runbooks.length > 0 ? ` resolved by ${r.runbooks.join(", ")}` : "";
				// reader.ts coalesces missing severity/summary to "" -- omit an empty
				// severity prefix and fall back for an empty summary so the bullet is
				// never rendered as "- []  (incident ...)".
				const severity = r.severity ? `[${r.severity}] ` : "";
				const summary = r.summary || "(summary unavailable)";
				return `- ${severity}${summary} (incident ${r.incidentId})${rb}`;
			});
			return text(`Prior incidents with the ${causeClass} root cause:\n${lines.join("\n")}`);
		},
	);

	// SIO-1202: prompts that produced a successfully APPLIED change -- "what to ask
	// to get a working change", for a documentation catalog of validated examples.
	server.tool(
		"kg_successful_prompts",
		"Prompts that produced a successfully applied elastic-iac change (Prompt joined to its ConfigChange via matching id, filtered to outcome = 'applied'), newest first. Read-only; no Cypher.",
		{ limit: z.number().int().positive().max(200).optional().describe("Max rows to return (default 20)") },
		async ({ limit }) => {
			const store = await resolveStore();
			if (typeof store === "string") return text(store);
			const rows = await successfulPromptChanges(store, limit ?? 20);
			if (rows.length === 0)
				return text(
					"Graph queried: no applied ConfigChange has a linked Prompt. Report this; do not invent examples from specs.",
				);
			const lines = rows.map((r) => {
				const wf = r.workflow ? `${r.workflow}: ` : "";
				const mr = r.mrUrl ? ` (${r.mrUrl})` : "";
				return `- ${r.createdAt} — "${r.prompt}" -> ${wf}${r.summary}${mr}`;
			});
			return text(`Prompts that produced applied changes:\n${lines.join("\n")}`);
		},
	);

	// SIO-1203: fallback for kg_successful_prompts -- every applied change, whether or
	// not it has a linked Prompt. The Prompt node only exists from SIO-1038 onward (KG
	// activation for elastic-iac was SIO-954, well before SIO-1038), so a change applied
	// in that window has no prompt to join and is invisible to kg_successful_prompts even
	// though it is real. A missing Prompt can also reflect a soft-failed write on a later
	// turn -- render it as "no prompt recorded" rather than asserting the change predates
	// SIO-1038 (CodeRabbit PR #463: don't infer provenance from an absence).
	server.tool(
		"kg_applied_changes",
		"Every successfully applied elastic-iac change, newest first, whether or not it has a linked Prompt (a missing Prompt is common for changes recorded before the Prompt node existed, SIO-1038, but can also reflect a soft-failed write). Use this for full historical coverage; use kg_successful_prompts when you specifically need the prompt text. Read-only; no Cypher.",
		{ limit: z.number().int().positive().max(200).optional().describe("Max rows to return (default 20)") },
		async ({ limit }) => {
			const store = await resolveStore();
			if (typeof store === "string") return text(store);
			const rows = await appliedChanges(store, limit ?? 20);
			if (rows.length === 0)
				return text("Graph queried: no applied ConfigChange recorded. Report this; do not invent examples from specs.");
			const lines = rows.map((r) => {
				const wf = r.workflow ? `${r.workflow}: ` : "";
				const mr = r.mrUrl ? ` (${r.mrUrl})` : "";
				const prompt = r.prompt ? `"${r.prompt}"` : "(no prompt recorded)";
				return `- ${r.createdAt} — ${prompt} -> ${wf}${r.summary}${mr}`;
			});
			return text(`Applied changes:\n${lines.join("\n")}`);
		},
	);

	// SIO-1204/SIO-1207: the persisted per-service network map (static topology +
	// currently-valid IP bindings accreted from prior incident turns).
	server.tool(
		"kg_network_map",
		"Persisted network map for one service: DNS -> load balancer -> target group -> workload chain, VPC/subnet placement, currently-valid IP bindings, and service endpoints (Kong/Kafka/Capella/Elastic). Accreted per incident; verify live before acting on IPs. Read-only; no Cypher.",
		{
			service: z.string().min(1).describe("Canonical service name, e.g. orders-service"),
			asOf: z.string().optional().describe("ISO timestamp for a bi-temporal as-of read (default: currently valid)"),
		},
		async ({ service, asOf }) => {
			const store = await resolveStore();
			if (typeof store === "string") return text(store);
			const map = await networkMapForService(store, service, asOf);
			const lines: string[] = [];
			for (const dns of map.dnsRecords) {
				const lb = map.loadBalancers.find((l) => l.arn === dns.loadBalancerArn);
				lines.push(`- dns ${dns.name} ${dns.type} -> ${lb ? lb.name || lb.arn : dns.target || "(unlinked)"}`);
			}
			for (const lb of map.loadBalancers) {
				const tg = map.targetGroups.find((t) => t.arn === lb.targetGroupArn);
				lines.push(
					`- lb ${lb.name || lb.arn} (${[lb.type, lb.scheme].filter(Boolean).join("/") || "lb"})${tg ? ` -> tg ${tg.name || tg.arn}` : ""}`,
				);
			}
			for (const p of map.placements) {
				lines.push(
					`- placement: subnet ${p.subnetId}${p.subnetCidr ? ` (${p.subnetCidr})` : ""}${p.az ? ` ${p.az}` : ""} in vpc ${p.vpcName || p.vpcId}${p.vpcCidr ? ` (${p.vpcCidr})` : ""}`,
				);
			}
			for (const ip of map.ipAddresses) {
				lines.push(
					`- ip ${ip.ip} bound to ${ip.workloadArn}${ip.subnetId ? ` (subnet ${ip.subnetId})` : ""}${ip.lastVerified ? `, verified ${ip.lastVerified}` : ""}`,
				);
			}
			for (const ep of map.endpoints) {
				lines.push(`- endpoint [${ep.datasource}] ${ep.port ? `${ep.host}:${ep.port}` : ep.host}`);
			}
			if (lines.length === 0 && map.workloads.length === 0)
				return text(
					`Graph queried: no persisted network map for ${service}. Report this; the map accretes only from incident turns that fetched network data (ec2_state/ingress_state).`,
				);
			const workloads = map.workloads.length > 0 ? `\nWorkloads: ${map.workloads.join(", ")}` : "";
			return text(`Network map for ${service}:${workloads}\n${lines.join("\n")}`);
		},
	);

	// SIO-1204/SIO-1207: KG-cache-first reverse IP lookup (the SIO-1200 protocol's
	// step 0). Returns ALL currently-valid owners: a private IP is unique only per
	// VPC, so multiple hits need live disambiguation.
	server.tool(
		"kg_ip_to_workload",
		"Cached reverse-IP lookup: which workload was this private IP last bound to (BOUND_TO edges from prior incidents). Verify-then-trust: always confirm live via the AWS reverse-IP protocol before relying on it. asOf gives a historical as-of read. Read-only; no Cypher.",
		{
			ip: z
				.string()
				.regex(/^\d{1,3}(?:\.\d{1,3}){3}$/, "IPv4 dotted-quad expected")
				.describe("IPv4 address, e.g. 10.34.50.147"),
			asOf: z.string().optional().describe("ISO timestamp for a bi-temporal as-of read (default: currently valid)"),
		},
		async ({ ip, asOf }) => {
			const store = await resolveStore();
			if (typeof store === "string") return text(store);
			const hits = await ipToWorkload(store, ip, asOf);
			if (hits.length === 0)
				return text(
					`Graph queried: no cached binding for ${ip}${asOf ? ` as of ${asOf}` : ""}. Resolve it live via the AWS reverse-IP protocol (aws_ec2_describe_network_interfaces filtered on private-ip-address).`,
				);
			const lines = hits.map((h) => {
				const service = h.service ? `, service ${h.service}` : "";
				const place = h.subnetId ? `, subnet ${h.subnetId}${h.vpcId ? ` / vpc ${h.vpcId}` : ""}` : "";
				const verified = h.lastVerified ? `, verified ${h.lastVerified}` : "";
				return `- ${h.workloadArn}${service}${place}${verified}`;
			});
			const plural =
				hits.length > 1 ? " (MULTIPLE valid owners -- private IPs are unique only per VPC; disambiguate live)" : "";
			return text(`Cached binding(s) for ${ip}${plural}:\n${lines.join("\n")}\nVerify live before acting on this.`);
		},
	);
}
