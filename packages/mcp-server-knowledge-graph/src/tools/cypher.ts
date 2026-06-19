// src/tools/cypher.ts
//
// SIO-967: OPTIONAL raw-Cypher tool, registered ONLY when KG_MCP_ALLOW_CYPHER=true.
// Off by default -- raw Cypher is an injection/footgun risk and lbug has binder
// quirks (vars don't cross two MATCH clauses; ORDER BY after RETURN DISTINCT must
// use the projected alias -- memory: reference_lbug_cypher_and_teardown_gotchas).
// When on, a read-only guard rejects any statement that contains a write/DDL
// keyword, and the agent is told to pass bound $params (never interpolate values).

import { type GraphStore, getGraphStore } from "@devops-agent/knowledge-graph";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errText, text } from "./shared.ts";

// Mutation / DDL keywords that make a statement non-read-only in Cypher + lbug.
// Matched as whole words, case-insensitive, AFTER comment/string stripping.
const FORBIDDEN = [
	"CREATE",
	"MERGE",
	"SET",
	"DELETE",
	"DETACH",
	"REMOVE",
	"DROP",
	"ALTER",
	"COPY",
	"CALL",
	"LOAD",
	"INSTALL",
	"ATTACH",
	"USE",
	"BEGIN",
	"COMMIT",
	"ROLLBACK",
] as const;

// Strip /* */ and // and -- comments and single/double-quoted string literals so a
// keyword inside a comment or string value cannot trip (or evade) the guard.
function stripCommentsAndStrings(cypher: string): string {
	return cypher
		.replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
		.replace(/\/\/[^\n]*/g, " ") // // line comments
		.replace(/--[^\n]*/g, " ") // -- line comments
		.replace(/'(?:[^'\\]|\\.)*'/g, "''") // single-quoted strings
		.replace(/"(?:[^"\\]|\\.)*"/g, '""'); // double-quoted strings
}

export interface CypherGuardResult {
	ok: boolean;
	reason?: string;
}

// Pure, exported for tests. Read-only guard: a single statement that contains no
// forbidden write/DDL keyword. Empty statements and multi-statement payloads (a `;`
// separating two statements) are rejected.
export function validateReadOnlyCypher(cypher: string): CypherGuardResult {
	const trimmed = cypher.trim();
	if (!trimmed) return { ok: false, reason: "Empty query." };
	const stripped = stripCommentsAndStrings(trimmed);
	// Reject multiple statements (a trailing `;` is allowed, an interior one is not).
	const withoutTrailing = stripped.replace(/;\s*$/, "");
	if (withoutTrailing.includes(";")) {
		return { ok: false, reason: "Multiple statements are not allowed; submit a single read-only query." };
	}
	for (const kw of FORBIDDEN) {
		const re = new RegExp(`\\b${kw}\\b`, "i");
		if (re.test(stripped)) {
			return { ok: false, reason: `Read-only: the '${kw}' keyword is not permitted. Curated kg_* tools cover writes.` };
		}
	}
	return { ok: true };
}

// SIO-968: gate on the server's startup config (passed in), not a per-call
// process.env re-read; loud-fail wording so the model never substitutes prose.
function makeResolveStore(enabled: boolean): () => Promise<GraphStore | string> {
	return async () => {
		if (!enabled)
			return (
				"KNOWLEDGE GRAPH UNAVAILABLE (disabled for this process). Do NOT answer from memory, specs, " +
				"or runbooks -- you have no graph evidence. Tell the user the graph is disabled and the answer is unverified."
			);
		try {
			return await getGraphStore();
		} catch {
			return (
				"KNOWLEDGE GRAPH UNAVAILABLE (store could not be opened). Do NOT answer from memory, specs, " +
				"or runbooks -- you have no graph evidence. Tell the user the graph is unavailable and the answer is unverified."
			);
		}
	};
}

// Schema card embedded in the kg_run_cypher description so the agent can write
// correct queries WITHOUT a memory round-trip. Mirrors packages/knowledge-graph/
// src/schema.ts exactly -- keep in sync when the IaC subgraph changes. Scoped to the
// IaC layer the elastic-iac agent queries (the incident-side nodes are omitted).
const SCHEMA_CARD = [
	"GRAPH SCHEMA (lbug/Kuzu, table-typed). IaC subgraph:",
	"Nodes:",
	"  ElasticDeployment(name, ecId, region)   -- a cluster, e.g. eu-b2b. PK name.",
	"  Stack(name)                              -- a root module, e.g. slos. PK name.",
	"  Module(name, howto)                      -- reusable logic, e.g. slo. PK name.",
	"  StackInstance(id, deployment, stack)     -- a (deployment,stack) cell; id='<dep>/<stack>'. SPARSE. PK id.",
	"  ConfigChange(id, workflow, filePath, summary, createdAt, outcome)  -- one maker turn's edit. createdAt is ISO; outcome in {proposed,applied,...}.",
	"  MergeRequest(url)  Workflow(name)  Session(threadId)  Pipeline(id, status, url)",
	"Relationships (direction matters):",
	"  (Stack)-[:USES_MODULE]->(Module)",
	"  (StackInstance)-[:OF_STACK]->(Stack)        (StackInstance)-[:ON_DEPLOYMENT]->(ElasticDeployment)",
	"  (ElasticDeployment)-[:CHANGED_BY]->(ConfigChange)   (ConfigChange)-[:TARGETS]->(StackInstance)",
	"  (ConfigChange)-[:PROPOSED_IN]->(MergeRequest)  (ConfigChange)-[:VIA_WORKFLOW]->(Workflow)  (ConfigChange)-[:IN_SESSION]->(Session)",
	"  (MergeRequest)-[:RAN]->(Pipeline)",
	"lbug binder quirks: a variable does NOT carry across two separate MATCH clauses -- chain patterns in ONE MATCH;",
	"  ORDER BY after RETURN DISTINCT must reference the PROJECTED alias, not the source property;",
	"  and a node's label is label(n) (singular, a STRING) -- labels(n)[0] silently returns empty (it's a Neo4j idiom).",
	"Examples:",
	"  Which deployments run a stack:  MATCH (d:ElasticDeployment)<-[:ON_DEPLOYMENT]-(:StackInstance)-[:OF_STACK]->(s:Stack {name:$stack}) RETURN DISTINCT d.name AS deployment ORDER BY deployment",
	"  Change history for a cell:      MATCH (c:ConfigChange)-[:TARGETS]->(:StackInstance {id:$sid}) RETURN c.summary, c.outcome, c.createdAt ORDER BY c.createdAt DESC LIMIT 5",
].join("\n");

export function registerCypherTool(server: McpServer, enabled: boolean): void {
	const resolveStore = makeResolveStore(enabled);
	server.tool(
		"kg_run_cypher",
		"Run a READ-ONLY Cypher query against the infrastructure knowledge graph. " +
			"Prefer the curated kg_* tools for common questions; use this for ad-hoc graph queries. " +
			"Pass values via the params object as bound $name placeholders -- never string-interpolate. " +
			"Write/DDL keywords (CREATE/MERGE/SET/DELETE/...) and multi-statement payloads are rejected.\n\n" +
			SCHEMA_CARD,
		{
			cypher: z.string().min(1).describe("A single read-only Cypher statement using $param placeholders."),
			params: z
				.record(z.string(), z.unknown())
				.optional()
				.describe("Bound parameter values for the $placeholders in the query."),
		},
		async ({ cypher, params }) => {
			const guard = validateReadOnlyCypher(cypher);
			if (!guard.ok) return errText(guard.reason ?? "Rejected.");
			const store = await resolveStore();
			if (typeof store === "string") return text(store);
			try {
				const rows = await store.run(cypher, params ?? {});
				return text(
					rows.length > 0
						? JSON.stringify(rows, null, 2)
						: "Graph queried: 0 rows. This is the authoritative result -- report it as-is; do not substitute an answer from specs or memory.",
				);
			} catch (err) {
				return errText(`Query failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	);
}
