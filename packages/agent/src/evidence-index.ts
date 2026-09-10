// agent/src/evidence-index.ts
//
// SIO-1688: a searchable, full-fidelity copy of what a tool actually returned.
//
// The SIO-1248 split already keeps raw bytes out of the model: the LLM sees a
// JSON-aware truncated copy (sub-agent-truncate-tool-output.ts) while the full
// payload is captured into ctx.rawOutputs. What was missing is RECOVERY -- once
// the loop's copy is cut to 3 hits of 1,204, the other 1,201 are unreachable to
// the model for the rest of the run, so a follow-up question about them can only
// be answered by re-issuing the query.
//
// This module indexes the pre-truncation bytes into a per-run FTS5 table and
// hands the sub-agent a search_evidence tool. Truncation is UNCHANGED: this is
// additive, and deliberately so. sub-agent-context-budget.ts:36-40 records that
// a deliberately harsh budget elided a live search result mid-investigation and
// scored 0.15, so nothing here tightens a cap to force search traffic.
//
// The chunking approach (walk JSON structurally, cap each row, title each row by
// its key path) follows context-mode (github.com/badlogic/context-mode,
// src/store.ts), used here under the Elastic License 2.0 and reimplemented
// against bun:sqlite.
//
// Storage is per RUN, in memory, never on disk: an evidence index is a within-turn
// recovery aid, not durable memory. AgentCore gives each container its own
// filesystem (docs/runbooks/mcp-agentcore-image-deployment.md), so an on-disk
// index would be unreadable by the next turn's container anyway.

import { getLogger } from "@devops-agent/observability";
import { tool as createTool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

const logger = getLogger("agent:evidence-index");

// Kill switch, default ON (same idiom as isHilLearningEnabled).
export function isEvidenceIndexEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.EVIDENCE_INDEX_ENABLED?.toLowerCase();
	return v !== "false" && v !== "0";
}

// One row's ceiling. Rows are retrieval units: too large and a hit returns mostly
// irrelevant text, too small and a record gets split across rows so no single hit
// is self-contained. 4KB holds a typical ES hit or an AWS resource description.
const MAX_ROW_BYTES = 4_096;
// Longest title kept, since a title is a locator and not content.
const TITLE_MAX = 120;
// Rows one tool call may contribute. A 40MB result would otherwise spend seconds
// in SQLite for evidence nobody asked for.
const MAX_ROWS_PER_CALL = 400;
// Bytes of one tool result to index. Past this, indexing costs more than the
// recovery is worth.
const MAX_INDEXED_BYTES_PER_CALL = 4_194_304;

export interface EvidenceHit {
	title: string;
	tool: string;
	snippet: string;
}

interface Row {
	title: string;
	content: string;
}

// Splits a JSON value into retrieval-sized rows titled by key path. Arrays are
// split per element (an element is the natural record), objects are split per key
// when the whole object is too large, and anything still oversized falls back to
// byte slices so no content is silently dropped.
function chunkValue(value: unknown, path: string, out: Row[]): void {
	if (out.length >= MAX_ROWS_PER_CALL) return;

	if (value == null) return;

	if (typeof value !== "object") {
		pushText(String(value), path, out);
		return;
	}

	let serialized: string;
	try {
		serialized = JSON.stringify(value) ?? "";
	} catch {
		// Circular structures cannot be indexed; skip rather than throw. The raw
		// copy in state is unaffected.
		return;
	}
	if (serialized === "") return;

	if (Buffer.byteLength(serialized, "utf8") <= MAX_ROW_BYTES) {
		out.push({ title: truncateTitle(path), content: serialized });
		return;
	}

	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			if (out.length >= MAX_ROWS_PER_CALL) return;
			chunkValue(value[i], `${path}[${i}]`, out);
		}
		return;
	}

	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (out.length >= MAX_ROWS_PER_CALL) return;
		chunkValue(child, path ? `${path}.${key}` : key, out);
	}
}

// Byte-slices a long string into rows. The slice boundary prefers a newline so a
// row tends to start at a record boundary rather than mid-token.
function pushText(text: string, path: string, out: Row[]): void {
	if (text.length === 0) return;
	if (Buffer.byteLength(text, "utf8") <= MAX_ROW_BYTES) {
		out.push({ title: truncateTitle(path), content: text });
		return;
	}
	let offset = 0;
	let part = 0;
	while (offset < text.length && out.length < MAX_ROWS_PER_CALL) {
		// MAX_ROW_BYTES is a byte budget; slicing by chars over-counts for
		// multi-byte text, which is safe (rows come out smaller, never larger).
		let end = Math.min(text.length, offset + MAX_ROW_BYTES);
		if (end < text.length) {
			const nl = text.lastIndexOf("\n", end);
			if (nl > offset) end = nl;
		}
		out.push({ title: truncateTitle(`${path}#${part}`), content: text.slice(offset, end) });
		offset = end;
		part += 1;
	}
}

function truncateTitle(path: string): string {
	const t = path || "result";
	return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX) : t;
}

// Parses a tool result into rows. Tool output is usually a JSON string; when it
// does not parse it is indexed as text, which is the correct handling for the
// markdown/plain-text tools rather than a failure.
export function chunkToolOutput(text: string): Row[] {
	const rows: Row[] = [];
	const trimmed = text.trim();
	if (trimmed === "") return rows;
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			chunkValue(JSON.parse(trimmed), "", rows);
			if (rows.length > 0) return rows;
		} catch {
			// Not JSON after all (a truncated or JSON-ish payload); fall through.
		}
	}
	pushText(text, "text", rows);
	return rows;
}

// FTS5 treats several characters as query syntax; a raw tool name or a user
// phrase containing them is a syntax error, not a search. Every term is quoted
// and internal quotes doubled, so the query is always a literal phrase match.
export function sanitizeQuery(query: string): string {
	const terms = query
		.split(/\s+/)
		.map((t) => t.replace(/["']/g, ""))
		.filter((t) => t.length > 0)
		.map((t) => `"${t}"`);
	return terms.join(" OR ");
}

interface EvidenceDb {
	run(sql: string): void;
	insert(rows: Array<{ title: string; content: string; tool: string }>): void;
	search(match: string, tool: string | undefined, limit: number): EvidenceHit[];
	close(): void;
	count(): number;
}

// bun:sqlite is imported lazily and with @vite-ignore: packages/agent is bundled
// as source into the web app's Vite SSR build, where a top-level "bun:" specifier
// is unresolvable (same constraint as tool-call-metrics.ts).
async function openDb(): Promise<EvidenceDb> {
	const { Database } = await import(/* @vite-ignore */ "bun:sqlite");
	const db = new Database(":memory:");
	db.run(
		`CREATE VIRTUAL TABLE evidence USING fts5(
			title, content, tool UNINDEXED, tokenize='porter unicode61'
		)`,
	);
	const insertStmt = db.query("INSERT INTO evidence (title, content, tool) VALUES ($title, $content, $tool)");
	return {
		run(sql) {
			db.run(sql);
		},
		insert(rows) {
			// One transaction per tool call: a per-row commit is what makes SQLite
			// slow, and this runs on the tool-result path.
			db.run("BEGIN");
			try {
				for (const r of rows) insertStmt.run({ $title: r.title, $content: r.content, $tool: r.tool });
				db.run("COMMIT");
			} catch (error) {
				db.run("ROLLBACK");
				throw error;
			}
		},
		search(match, tool, limit) {
			// bm25 weights title above content: a hit whose key path matches the
			// question is a better answer than one burying the term in a payload.
			const sql = tool
				? `SELECT title, tool, snippet(evidence, 1, '', '', ' ... ', 24) AS snippet
					FROM evidence WHERE evidence MATCH $match AND tool = $tool
					ORDER BY bm25(evidence, 5.0, 1.0) LIMIT $limit`
				: `SELECT title, tool, snippet(evidence, 1, '', '', ' ... ', 24) AS snippet
					FROM evidence WHERE evidence MATCH $match
					ORDER BY bm25(evidence, 5.0, 1.0) LIMIT $limit`;
			const params: Record<string, string | number> = { $match: match, $limit: limit };
			if (tool) params.$tool = tool;
			return db.query<EvidenceHit, typeof params>(sql).all(params);
		},
		count() {
			return db.query<{ n: number }, []>("SELECT count(*) AS n FROM evidence").get()?.n ?? 0;
		},
		close() {
			db.close(false);
		},
	};
}

// One index per sub-agent run. Created on first indexed output, closed by the
// caller's teardown. Not shared across runs: two datasources fanning out in
// parallel each get their own, so a search is always scoped to its own evidence.
export class EvidenceIndex {
	#db: EvidenceDb | null = null;
	#rows = 0;
	#failed = false;

	async index(toolName: string, text: string): Promise<number> {
		if (this.#failed) return 0;
		if (Buffer.byteLength(text, "utf8") > MAX_INDEXED_BYTES_PER_CALL) {
			text = text.slice(0, MAX_INDEXED_BYTES_PER_CALL);
		}
		const rows = chunkToolOutput(text);
		if (rows.length === 0) return 0;
		try {
			if (!this.#db) this.#db = await openDb();
			this.#db.insert(rows.map((r) => ({ ...r, tool: toolName })));
			this.#rows += rows.length;
			return rows.length;
		} catch (error) {
			// A broken index must never break an investigation: give up for the rest
			// of the run and let the loop proceed on the truncated copy alone.
			this.#failed = true;
			logger.warn(
				{ error: error instanceof Error ? error.message : String(error), toolName },
				"evidence index unavailable; continuing without it",
			);
			return 0;
		}
	}

	search(query: string, opts: { tool?: string; limit?: number } = {}): EvidenceHit[] {
		if (!this.#db || this.#failed) return [];
		const match = sanitizeQuery(query);
		if (match === "") return [];
		try {
			return this.#db.search(match, opts.tool, opts.limit ?? 3);
		} catch (error) {
			logger.warn({ error: error instanceof Error ? error.message : String(error) }, "evidence search failed");
			return [];
		}
	}

	get rowCount(): number {
		return this.#rows;
	}

	close(): void {
		try {
			this.#db?.close();
		} catch {
			// Closing a already-closed or half-open handle must not surface.
		}
		this.#db = null;
	}
}

// Longest snippet returned per hit. Wide enough to carry the matching record,
// narrow enough that three hits cannot themselves overflow the loop budget the
// truncation was protecting.
const SNIPPET_MAX = 1_500;
const DEFAULT_HIT_LIMIT = 3;

// The sub-agent's recovery tool. Bound only when an index exists for the run, so
// the model is never offered a search over nothing.
export function buildSearchEvidenceTool(index: EvidenceIndex): StructuredToolInterface {
	return createTool(
		({ query, tool }: { query: string; tool?: string }) => {
			const hits = index.search(query, { tool, limit: DEFAULT_HIT_LIMIT });
			if (hits.length === 0) {
				// Absence here is about the INDEX, not about the world. Saying so keeps
				// the model from reporting "no such errors exist" on a failed search.
				return `No indexed evidence matches "${query}"${tool ? ` for tool ${tool}` : ""}. This means the stored tool output does not contain those terms; it is not evidence that the underlying system lacks them. Re-run the tool with a different query if you need to widen the search.`;
			}
			return hits
				.map((h) => {
					const snippet = h.snippet.length > SNIPPET_MAX ? `${h.snippet.slice(0, SNIPPET_MAX)}...` : h.snippet;
					return `[${h.tool} ${h.title}]\n${snippet}`;
				})
				.join("\n\n");
		},
		{
			name: "search_evidence",
			description:
				"Search the FULL text of tool results already returned in this run, including the parts that were truncated out of the conversation. Use this when a result says it was truncated and you need a part that was cut, or to check whether a term appears anywhere in what a tool already returned, instead of re-running the tool. Returns the best-matching sections with the tool and key path each came from.",
			schema: z.object({
				query: z
					.string()
					.describe(
						"Words to search for, e.g. 'OutOfMemoryError checkout' or a service name. Plain terms, not a sentence.",
					),
				tool: z
					.string()
					.optional()
					.describe(
						"Restrict the search to one tool's output, e.g. 'elasticsearch_search'. Omit to search every tool result in this run.",
					),
			}),
		},
	);
}
