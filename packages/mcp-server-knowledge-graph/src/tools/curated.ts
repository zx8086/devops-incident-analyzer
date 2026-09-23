// src/tools/curated.ts
//
// SIO-967: the curated, read-only graph tools, one per packages/knowledge-graph
// reader. They are the MCP-standardized successor to the SIO-966 in-process
// local-tools.ts (createQueryKnowledgeGraphTool). No raw Cypher -> injection-safe;
// all values bind as params inside the readers. Each tool soft-fails to a friendly
// string when the graph is disabled/unavailable so a turn degrades instead of
// erroring (mirrors the SIO-966 runKnowledgeGraphQuery wording).

import {
	accountManagingRoots,
	accountNetworkMap,
	appliedChanges,
	centralNetworkAttachments,
	changeHistoryForStackInstance,
	deploymentsRunningStack,
	type GraphStore,
	getGraphStore,
	hostnameResolutionPath,
	ipToWorkload,
	landingZoneTopologyDrift,
	mergeRequestPipelineOutcome,
	networkMapForService,
	priorChangesForDeployment,
	priorRootCauses,
	repositoryChangeHistory,
	stacksUsingModule,
	standardsForRepository,
	subnetRouteAssociation,
	successfulPromptChanges,
	terraformModuleConsumers,
	vpcRoutePath,
} from "@devops-agent/knowledge-graph";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { KG_READ_ONLY_ANNOTATIONS, text } from "./shared.ts";

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
const GRAPH_INCOMPLETE = "The graph may be incomplete; verify against live GitLab before concluding absence.";

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
	server.registerTool(
		"kg_lz_repository_history",
		{
			description:
				"Landing Zone repository change history with MR, pipeline, and Terraform plan outcomes. Read-only; graph results never replace live GitLab verification.",
			inputSchema: {
				repository: z.string().min(1).describe("Full GitLab repository path"),
				limit: z.number().int().positive().max(200).optional().describe("Max rows to return (default 20)"),
			},
			annotations: KG_READ_ONLY_ANNOTATIONS,
		},
		async ({ repository, limit }) => {
			const store = await resolveStore();
			if (typeof store === "string") return text(store);
			const rows = await repositoryChangeHistory(store, repository, limit ?? 20);
			if (rows.length === 0) return text(`No recorded changes for ${repository}. ${GRAPH_INCOMPLETE}`);
			const lines = rows.map((row) => {
				const mr = row.mrUrl ? `; MR ${row.mrUrl}` : "";
				const pipeline = row.pipelineId ? `; pipeline ${row.pipelineId} ${row.pipelineStatus || "status unknown"}` : "";
				const plan = row.planId
					? `; plan ${row.planId} ${row.planStatus || "status unknown"}${row.planSummary ? ` (${row.planSummary})` : ""}`
					: "";
				return `- ${row.changeId} [${row.outcome}] ${row.summary || "(summary unavailable)"}${mr}${pipeline}${plan}`;
			});
			return text(`Landing Zone changes for ${repository}:\n${lines.join("\n")}`);
		},
	);

	server.registerTool(
		"kg_lz_module_consumers",
		{
			description: "Landing Zone Terraform roots that consume one local or shared Terraform module. Read-only.",
			inputSchema: { moduleId: z.string().min(1).describe("Stable TerraformModule id") },
			annotations: KG_READ_ONLY_ANNOTATIONS,
		},
		async ({ moduleId }) => {
			const store = await resolveStore();
			if (typeof store === "string") return text(store);
			const rows = await terraformModuleConsumers(store, moduleId);
			if (rows.length === 0) return text(`No recorded consumers for ${moduleId}. ${GRAPH_INCOMPLETE}`);
			return text(
				`Terraform roots consuming ${moduleId}:\n${rows.map((row) => `- ${row.rootId} (${row.repositoryPath}:${row.rootPath})`).join("\n")}`,
			);
		},
	);

	server.registerTool(
		"kg_lz_account_roots",
		{
			description: "Landing Zone Terraform roots explicitly recorded as managing AWS accounts. Read-only.",
			inputSchema: { repository: z.string().min(1).optional().describe("Optional full GitLab repository path") },
			annotations: KG_READ_ONLY_ANNOTATIONS,
		},
		async ({ repository }) => {
			const store = await resolveStore();
			if (typeof store === "string") return text(store);
			const rows = await accountManagingRoots(store, repository);
			if (rows.length === 0) return text(`No account-managing Terraform roots are recorded. ${GRAPH_INCOMPLETE}`);
			return text(
				`Account-managing Terraform roots:\n${rows.map((row) => `- ${row.rootId} (${row.repositoryPath}:${row.rootPath})`).join("\n")}`,
			);
		},
	);

	server.registerTool(
		"kg_lz_account_network_map",
		{
			description: "Account-scoped Landing Zone VPC and subnet map with graph-recorded topology only. Read-only.",
			inputSchema: { accountId: z.string().min(1).describe("Verified AWS account identifier") },
			annotations: KG_READ_ONLY_ANNOTATIONS,
		},
		async ({ accountId }) => {
			const store = await resolveStore();
			if (typeof store === "string") return text(store);
			const rows = await accountNetworkMap(store, accountId);
			if (rows.length === 0) return text(`No recorded network topology for account ${accountId}. ${GRAPH_INCOMPLETE}`);
			return text(
				`Account network map for ${accountId}:\n${rows
					.map(
						(row) =>
							`- VPC ${row.vpcName || row.vpcId} (${row.vpcId})${row.subnetId ? ` -> subnet ${row.subnetId}${row.subnetCidr ? ` (${row.subnetCidr})` : ""}` : ""}`,
					)
					.join("\n")}`,
			);
		},
	);

	server.registerTool(
		"kg_lz_hostname_resolution",
		{
			description:
				"DNS-only hostname resolution path through hosted zones and records. It does not claim packet routing. Read-only.",
			inputSchema: { hostname: z.string().min(1).describe("Fully qualified hostname") },
			annotations: KG_READ_ONLY_ANNOTATIONS,
		},
		async ({ hostname }) => {
			const store = await resolveStore();
			if (typeof store === "string") return text(store);
			const rows = await hostnameResolutionPath(store, hostname);
			if (rows.length === 0) return text(`No recorded DNS resolution path for ${hostname}. ${GRAPH_INCOMPLETE}`);
			return text(
				`DNS only for ${hostname}; query the VPC route path separately for reachability:\n${rows.map((row) => `- zone ${row.zoneId || "unknown"}: ${row.hostname} -> ${row.targetId || "unresolved"} [${row.targetKind || "target unknown"}]`).join("\n")}`,
			);
		},
	);

	server.registerTool(
		"kg_lz_subnet_route_association",
		{
			description: "Recorded route-table association for one Landing Zone subnet. Read-only.",
			inputSchema: { subnetId: z.string().min(1).describe("Graph subnet identifier") },
			annotations: KG_READ_ONLY_ANNOTATIONS,
		},
		async ({ subnetId }) => {
			const store = await resolveStore();
			if (typeof store === "string") return text(store);
			const rows = await subnetRouteAssociation(store, subnetId);
			if (rows.length === 0) return text(`No recorded route-table association for ${subnetId}. ${GRAPH_INCOMPLETE}`);
			return text(
				`Route-table association for ${subnetId}:\n${rows.map((row) => `- ${row.routeTableId} [${row.status || "status unknown"}/${row.confidence || "confidence unknown"}]`).join("\n")}`,
			);
		},
	);

	server.registerTool(
		"kg_lz_vpc_route_path",
		{
			description: "Recorded subnet, route-table, route, destination, and target path for one VPC. Read-only.",
			inputSchema: { vpcId: z.string().min(1).describe("Graph VPC identifier") },
			annotations: KG_READ_ONLY_ANNOTATIONS,
		},
		async ({ vpcId }) => {
			const store = await resolveStore();
			if (typeof store === "string") return text(store);
			const rows = await vpcRoutePath(store, vpcId);
			if (rows.length === 0) return text(`No recorded route path for ${vpcId}. ${GRAPH_INCOMPLETE}`);
			return text(
				`Route paths for ${vpcId}:\n${rows.map((row) => `- ${row.routeId}: ${row.destination} -> ${row.targetId || "local"} [${row.targetKind || "target unknown"}]`).join("\n")}`,
			);
		},
	);

	server.registerTool(
		"kg_lz_central_attachment",
		{
			description: "Recorded Core Network or Transit Gateway attachment path for one VPC. Read-only.",
			inputSchema: { vpcId: z.string().min(1).describe("Graph VPC identifier") },
			annotations: KG_READ_ONLY_ANNOTATIONS,
		},
		async ({ vpcId }) => {
			const store = await resolveStore();
			if (typeof store === "string") return text(store);
			const rows = await centralNetworkAttachments(store, vpcId);
			if (rows.length === 0) return text(`No recorded central-network attachment for ${vpcId}. ${GRAPH_INCOMPLETE}`);
			return text(
				`Central-network attachments for ${vpcId}:\n${rows.map((row) => `- ${row.attachmentId} -> ${row.targetId} [${row.targetKind}]`).join("\n")}`,
			);
		},
	);

	server.registerTool(
		"kg_lz_topology_drift",
		{
			description: "Desired/observed Landing Zone topology differences, unknowns, and conflicting evidence. Read-only.",
			inputSchema: { accountId: z.string().min(1).optional().describe("Optional verified AWS account identifier") },
			annotations: KG_READ_ONLY_ANNOTATIONS,
		},
		async ({ accountId }) => {
			const store = await resolveStore();
			if (typeof store === "string") return text(store);
			const rows = await landingZoneTopologyDrift(store, accountId);
			if (rows.length === 0)
				return text(
					`No active topology drift facts are recorded${accountId ? ` for ${accountId}` : ""}. ${GRAPH_INCOMPLETE}`,
				);
			return text(
				`Topology reconciliation issues${accountId ? ` for ${accountId}` : ""}:\n${rows.map((row) => `- ${row.id} [${row.status}]`).join("\n")}`,
			);
		},
	);

	server.registerTool(
		"kg_lz_mr_outcome",
		{
			description:
				"Recorded Landing Zone change, pipeline, and Terraform plan outcome for one merge request. Read-only.",
			inputSchema: { mrUrl: z.url().describe("Full GitLab merge request URL") },
			annotations: KG_READ_ONLY_ANNOTATIONS,
		},
		async ({ mrUrl }) => {
			const store = await resolveStore();
			if (typeof store === "string") return text(store);
			const row = await mergeRequestPipelineOutcome(store, mrUrl);
			if (!row) return text(`No recorded outcome for ${mrUrl}. ${GRAPH_INCOMPLETE}`);
			const pipeline = row.pipelineId ? `; pipeline ${row.pipelineId} ${row.pipelineStatus || "status unknown"}` : "";
			const plan = row.planId
				? `; plan ${row.planId} ${row.planStatus || "status unknown"}${row.planSummary ? ` (${row.planSummary})` : ""}`
				: "";
			return text(`${row.changeId} [${row.outcome}] MR ${row.mrUrl}${pipeline}${plan}`);
		},
	);

	server.registerTool(
		"kg_lz_repository_standards",
		{
			description: "Standards and accepted ADR records governing one Landing Zone repository. Read-only.",
			inputSchema: { repository: z.string().min(1).describe("Full GitLab repository path") },
			annotations: KG_READ_ONLY_ANNOTATIONS,
		},
		async ({ repository }) => {
			const store = await resolveStore();
			if (typeof store === "string") return text(store);
			const rows = await standardsForRepository(store, repository);
			if (rows.length === 0) return text(`No governing standards are recorded for ${repository}. ${GRAPH_INCOMPLETE}`);
			const lines = rows.map((row) => {
				const adr = row.adrId ? ` implements ${row.adrTitle || row.adrId} [${row.adrStatus || "status unknown"}]` : "";
				return `- ${row.standardTitle || row.standardId} [${row.standardStatus || "status unknown"}]${adr}`;
			});
			return text(`Standards governing ${repository}:\n${lines.join("\n")}`);
		},
	);

	server.registerTool(
		"kg_deployments_running_stack",
		{
			description:
				"Blast radius: which Elastic deployments run a given stack (cross-deployment). Read-only; no Cypher.",
			inputSchema: { stack: z.string().min(1).describe("Stack name, e.g. slos") },
			annotations: KG_READ_ONLY_ANNOTATIONS,
		},
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

	server.registerTool(
		"kg_stacks_using_module",
		{
			description: "Blast radius: which stacks wire a given module (cross-stack reuse). Read-only; no Cypher.",
			inputSchema: { module: z.string().min(1).describe("Module name, e.g. lifecycle") },
			annotations: KG_READ_ONLY_ANNOTATIONS,
		},
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

	server.registerTool(
		"kg_stack_instance_history",
		{
			description: "Recent change history for one (deployment, stack) cell, with outcome. Read-only; no Cypher.",
			inputSchema: {
				deployment: z.string().min(1).describe("Deployment name, e.g. eu-b2b"),
				stack: z.string().min(1).describe("Stack name, e.g. slos"),
			},
			annotations: KG_READ_ONLY_ANNOTATIONS,
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

	server.registerTool(
		"kg_deployment_history",
		{
			description: "Recent IaC change history for one deployment, most-recent first. Read-only; no Cypher.",
			inputSchema: { deployment: z.string().min(1).describe("Deployment name, e.g. eu-b2b") },
			annotations: KG_READ_ONLY_ANNOTATIONS,
		},
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
	server.registerTool(
		"kg_prior_root_causes",
		{
			description:
				"Prior incidents that shared a root-cause class (e.g. a correlation rule name), with any runbook that resolved them. Read-only; no Cypher.",
			inputSchema: {
				causeClass: z
					.string()
					.min(1)
					.describe("Root-cause class, e.g. the correlation rule name kafka-significant-lag"),
			},
			annotations: KG_READ_ONLY_ANNOTATIONS,
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
	server.registerTool(
		"kg_successful_prompts",
		{
			description:
				"Prompts that produced a successfully applied elastic-iac change (Prompt joined to its ConfigChange via matching id, filtered to outcome = 'applied'), newest first. Read-only; no Cypher.",
			inputSchema: {
				limit: z.number().int().positive().max(200).optional().describe("Max rows to return (default 20)"),
			},
			annotations: KG_READ_ONLY_ANNOTATIONS,
		},
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
	server.registerTool(
		"kg_applied_changes",
		{
			description:
				"Every successfully applied elastic-iac change, newest first, whether or not it has a linked Prompt (a missing Prompt is common for changes recorded before the Prompt node existed, SIO-1038, but can also reflect a soft-failed write). Use this for full historical coverage; use kg_successful_prompts when you specifically need the prompt text. Read-only; no Cypher.",
			inputSchema: {
				limit: z.number().int().positive().max(200).optional().describe("Max rows to return (default 20)"),
			},
			annotations: KG_READ_ONLY_ANNOTATIONS,
		},
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
	server.registerTool(
		"kg_network_map",
		{
			description:
				"Persisted network map for one service: DNS -> load balancer -> target group -> workload chain, VPC/subnet placement, currently-valid IP bindings, and service endpoints (Kong/Kafka/Capella/Elastic). Accreted per incident; verify live before acting on IPs. Read-only; no Cypher.",
			inputSchema: {
				service: z.string().min(1).describe("Canonical service name, e.g. orders-service"),
				asOf: z.string().optional().describe("ISO timestamp for a bi-temporal as-of read (default: currently valid)"),
			},
			annotations: KG_READ_ONLY_ANNOTATIONS,
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
	server.registerTool(
		"kg_ip_to_workload",
		{
			description:
				"Cached reverse-IP lookup: which workload was this private IP last bound to (BOUND_TO edges from prior incidents). Verify-then-trust: always confirm live via the AWS reverse-IP protocol before relying on it. asOf gives a historical as-of read. Read-only; no Cypher.",
			inputSchema: {
				ip: z.ipv4().describe("IPv4 address, e.g. 10.34.50.147"),
				asOf: z.string().optional().describe("ISO timestamp for a bi-temporal as-of read (default: currently valid)"),
			},
			annotations: KG_READ_ONLY_ANNOTATIONS,
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
