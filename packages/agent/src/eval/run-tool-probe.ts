// packages/agent/src/eval/run-tool-probe.ts
//
// SIO-1398: probes every coverage target DIRECTLY against its live MCP server -- no agent, no
// model, no steering. Answers "is the tool healthy", which the LangSmith eval structurally
// cannot: that one only observes tools the model chose to call, so a healthy tool the agent
// never reached for is indistinguishable from a broken one.
//
//   bun run eval:tool-probe                          # every datasource
//   bun run eval:tool-probe -- --datasource kafka    # one server
//
// Free and fast (no Bedrock, no LangSmith, no judge) -- run it on every MCP server change.
// Exits non-zero only on a genuine tool defect; `needs-args` and a disabled datasource are
// reported, not failed.

import { buildCoverageTargets } from "./coverage-targets.ts";
import { LIVE_ANCHORS } from "./mcp-tool-dataset.ts";
import { type ProbeArgs, probeFailures, probeTools } from "./tool-probe.ts";

const argv = process.argv.slice(2);
function opt(name: string): string | undefined {
	const i = argv.indexOf(`--${name}`);
	if (i < 0) return undefined;
	const value = argv[i + 1];
	if (!value || value.startsWith("--")) {
		console.error(`--${name} requires a value.`);
		process.exit(1);
	}
	return value;
}

// Curated READ-ONLY arguments, built from the live-verified anchors. A probe with a real anchor
// exercises the tool end to end; a bare {} only proves its schema. Every value here was
// confirmed to return rows on 2026-08-06 -- see LIVE_ANCHORS for the per-field evidence.
const PROBE_ARGS: ProbeArgs = {
	// kafka -- topic/group scoped
	kafka_describe_topic: { topic: LIVE_ANCHORS.kafka.topic },
	kafka_get_topic_offsets: { topic: LIVE_ANCHORS.kafka.topic },
	kafka_consume_messages: { topic: LIVE_ANCHORS.kafka.topic, maxMessages: 1 },
	kafka_get_consumer_group_lag: { groupId: LIVE_ANCHORS.kafka.consumerGroup },
	kafka_describe_consumer_group: { groupId: LIVE_ANCHORS.kafka.consumerGroup },
	// couchbase -- scope/collection scoped
	capella_run_sql_plus_plus_query: {
		scope_name: LIVE_ANCHORS.couchbase.scope,
		query: `SELECT RAW COUNT(*) FROM \`${LIVE_ANCHORS.couchbase.collection}\` LIMIT 1`,
	},
	capella_suggest_query_optimizations: {
		query: `SELECT * FROM \`${LIVE_ANCHORS.couchbase.collection}\` LIMIT 1`,
	},
	// gitlab -- project scoped. NOTE the types differ per tool, which is SIO-1403: the same
	// project identifier is `integer` on list_merge_requests, `string` on list_commits /
	// get_repository_tree / get_blame / get_file_content / get_commit_diff, and `string|number`
	// elsewhere. These literals encode the CURRENT server contract so the probe tests the tools;
	// once SIO-1403 normalises them, one shape will work everywhere and this comment can go.
	gitlab_list_merge_requests: { project_id: Number(LIVE_ANCHORS.gitlab.projectId) }, // integer
	gitlab_list_commits: { project_id: LIVE_ANCHORS.gitlab.projectId }, // string
	gitlab_get_repository_tree: { project_id: LIVE_ANCHORS.gitlab.projectId }, // string
	gitlab_get_file_content: { project_id: LIVE_ANCHORS.gitlab.projectId, file_path: "README.md" },
	gitlab_get_blame: { project_id: LIVE_ANCHORS.gitlab.projectId, file_path: "README.md" },
	gitlab_get_merge_request: { id: LIVE_ANCHORS.gitlab.projectId, merge_request_iid: 383 },
	gitlab_get_merge_request_diffs: { id: LIVE_ANCHORS.gitlab.projectId, merge_request_iid: 383 },
	gitlab_get_merge_request_notes: { project_id: LIVE_ANCHORS.gitlab.projectId, merge_request_iid: 383 },
	gitlab_get_merge_request_pipelines: { id: LIVE_ANCHORS.gitlab.projectId, merge_request_iid: 383 },
	gitlab_semantic_code_search: { id: LIVE_ANCHORS.gitlab.projectId, q: "styles" },
	// Orbit's `query` is a DSL OBJECT, not Cypher. Single-node `traversal` is the search shape
	// (Orbit has no `search` query_type); filters take operator objects. Verified live: row_count
	// 3, format_version 5.0.1. An earlier probe sent a Cypher string and got -32602, which is why
	// this tool was briefly written off as uncoverable.
	gitlab_orbit_query_graph: {
		query: {
			query_type: "traversal",
			nodes: [
				{ id: "file", entity: "File", filters: { path: { ends_with: "README.md" } }, columns: ["path", "language"] },
			],
			limit: 3,
		},
	},
	gitlab_blast_radius: { symbol: "main" },
	gitlab_cross_project_callers: { fqn: "main" },
	gitlab_search: { scope: "projects", search: LIVE_ANCHORS.gitlab.searchableNamespace },
	gitlab_get_commit_diff: { project_id: LIVE_ANCHORS.gitlab.projectId, sha: LIVE_ANCHORS.gitlab.commitSha },
	gitlab_get_issue: { id: LIVE_ANCHORS.gitlab.projectId, issue_iid: 1 },
	gitlab_get_job_log: { id: LIVE_ANCHORS.gitlab.projectId, job_id: LIVE_ANCHORS.gitlab.jobId },
	gitlab_get_pipeline_jobs: { id: LIVE_ANCHORS.gitlab.projectId, pipeline_id: LIVE_ANCHORS.gitlab.pipelineId },
	gitlab_recent_deploys: { since: "2026-07-01" },
	gitlab_pipeline_failures: { since: "2026-07-01" },
	// atlassian
	atlassian_search: { query: LIVE_ANCHORS.elastic.service },
	findLinkedIncidents: { service: LIVE_ANCHORS.elastic.service },
	// aws -- estate is required on nearly every tool; ECS detail tools also need a cluster
	aws_cloudwatch_describe_alarms: { estate: LIVE_ANCHORS.aws.estates[1] },
	aws_ec2_describe_instances: { estate: LIVE_ANCHORS.aws.estates[0] },
	aws_ec2_describe_security_groups: { estate: LIVE_ANCHORS.aws.estates[0] },
	aws_ecs_list_clusters: { estate: LIVE_ANCHORS.aws.estates[0] },
	aws_ecs_list_services: { estate: LIVE_ANCHORS.aws.estates[0], cluster: LIVE_ANCHORS.aws.ecsCluster },
	aws_ecs_list_tasks: { estate: LIVE_ANCHORS.aws.estates[0], cluster: LIVE_ANCHORS.aws.ecsCluster },
	aws_health_describe_events: { estate: LIVE_ANCHORS.aws.estates[0] },
	aws_logs_describe_log_groups: { estate: LIVE_ANCHORS.aws.estates[0] },
	aws_rds_describe_db_instances: { estate: LIVE_ANCHORS.aws.estates[1] },
};

const datasource = opt("datasource");
const allTargets = buildCoverageTargets();
const targets = datasource ? allTargets.filter((t) => t.dataSource === datasource) : allTargets;
if (datasource && targets.length === 0) {
	const known = [...new Set(allTargets.map((t) => t.dataSource))].sort();
	console.error(`--datasource "${datasource}" has no coverage targets. Known: ${known.join(", ")}.`);
	process.exit(1);
}

console.log(
	`Probing ${targets.length} coverage target(s)${datasource ? ` for ${datasource}` : ""} against live MCP servers.`,
);
console.log("Read-only: probes send {} or curated read-only anchor arguments, never a mutating payload.\n");

const report = await probeTools({
	targets,
	args: PROBE_ARGS,
	// The elastic MCP routes per deployment via header, matching how the agent calls it.
	headers: { elastic: { "x-elastic-deployment": LIVE_ANCHORS.elastic.deployment } },
	onResult: (r) => {
		const mark = r.verdict === "ok" ? "OK  " : r.verdict === "needs-args" ? "ARGS" : "FAIL";
		const note = r.missingParam
			? ` (needs ${r.missingParam})`
			: r.kind
				? ` (kind=${r.kind})`
				: r.detail && r.verdict !== "ok"
					? ` (${r.detail.slice(0, 60)})`
					: "";
		console.log(`  ${mark}  ${r.dataSource.padEnd(10)} ${r.toolName}${note}`);
	},
});

console.log("\n--- per datasource ---");
for (const [ds, s] of [...report.byDatasource.entries()].sort()) {
	console.log(`  ${ds.padEnd(11)} ${s.ok}/${s.total} ok, ${s.needsArgs} need args, ${s.failed} failed`);
}

const failures = probeFailures(report);
const totalOk = report.results.filter((r) => r.verdict === "ok").length;
console.log(`\n${totalOk}/${report.results.length} target tools returned data. ${failures.length} genuine failure(s).`);

if (failures.length > 0) {
	console.error("\nTool defects (a failure here is the TOOL, not the model's tool selection):");
	for (const f of failures) {
		console.error(
			`  ${f.dataSource}/${f.toolName}: ${f.verdict}${f.kind ? ` kind=${f.kind}` : ""} -- ${f.detail ?? ""}`,
		);
	}
	process.exit(1);
}
console.log("No tool defects.");
