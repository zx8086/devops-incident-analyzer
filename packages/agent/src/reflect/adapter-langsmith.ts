// packages/agent/src/reflect/adapter-langsmith.ts
//
// SIO-1834 (A1): LangSmith traces -> RawSession. This repo stores no run transcripts
// locally (the checkpointer is in-memory, the daily log keeps failure CATEGORIES only by
// design, SIO-1687), so LangSmith is the only place a past turn survives.
//
// Shapes here were MEASURED on the live project (2026-09-20), not inferred from SDK types.
import { ToolErrorCategorySchema } from "@devops-agent/shared";
import { Client } from "langsmith";
import type { RawMessage, RawPart, RawSession } from "./schema.ts";
import { RawSessionSchema } from "./schema.ts";

export const ROOT_RUN_NAME = "agent.request";

export interface ListOptions {
	hours: number;
	limit?: number;
	projectName?: string;
	client?: Pick<Client, "listRuns">;
}

interface LangSmithRun {
	id?: unknown;
	name?: unknown;
	start_time?: unknown;
	tags?: unknown;
	inputs?: unknown;
	outputs?: unknown;
	extra?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

// SIO-1856: tools whose ENTIRE input is scalar, so the recorded args really do identify the
// call and a repeat is provable. Everything else takes a nested object somewhere (a query
// body, a filter, a document) that toolArgs never records, which makes two different calls
// look identical.
//
// An allowlist, not a heuristic: "no args recorded" is ambiguous on its own -- it means
// either "this tool takes none" or "this tool's input was dropped", and those need opposite
// treatment. Listing the first case is the only way to tell them apart from a trace.
//
// BEFORE ADDING ONE: open its MCP schema and confirm EVERY parameter is a scalar. One
// optional array is enough to break it -- kafka_list_consumer_groups was on this list until
// review found its `states: z.array(z.string())`, which the recorder drops, making two
// different state filters look like the same call.
const SCALAR_INPUT_TOOLS = new Set([
	"aws_ecs_list_clusters",
	"aws_sqs_list_queues",
	"aws_logs_describe_log_groups",
	"aws_ecs_list_services",
	"kafka_list_topics",
	"kafka_list_dlq_topics",
	// NOT kafka_list_consumer_groups: its schema takes `states: z.array(z.string())`
	// (mcp-server-kafka parameters.ts:60). The recorder drops arrays, so two calls
	// filtering different states record identically -- exactly the false repeat this
	// allowlist exists to prevent. Caught in review of this file's own first draft.
	"capella_get_buckets",
	"capella_get_scopes_and_collections",
	"capella_get_document_type_examples",
	"capella_get_schema_for_collection",
	"elasticsearch_list_indices",
	"elasticsearch_get_cluster_health",
	"gitlab_list_projects",
	"konnect_list_control_planes",
]);

export function argsCanIdentify(toolName: string, args: Record<string, unknown>): boolean {
	// The allowlist is AUTHORITATIVE, not a shortcut past a scalar check. "Every recorded
	// value is scalar" looked like a safe fallback and is not: elasticsearch_search records
	// {"index":"logs-*","size":10} -- all scalar, and the QUERY BODY still missing. Two
	// searches of the same index for different things pass that test identically, which is
	// exactly the false repeat this ticket exists to remove.
	//
	// So a tool earns trust by being known to take scalars ONLY, never by what one call
	// happened to record.
	if (!SCALAR_INPUT_TOOLS.has(toolName)) return false;
	// On the list, a nested value would mean the entry is wrong; refuse rather than trust it.
	return Object.values(args).every((v) => v === null || ["string", "number", "boolean"].includes(typeof v));
}

// A short, stable digest of a tool result, used only to tell "same call, same answer" from
// "same call, new answer". Never reversible into the payload and never shown: rawJson holds
// real log lines, hostnames and account ids.
function fingerprint(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
	return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16);
}

// LangChain serializes a message as {kwargs:{content}} when hydrated, and leaves a bare
// {type:"constructor"} when it could not resolve the class. Both appear in real traces.
function messageContent(message: unknown): string {
	const record = asRecord(message);
	const direct = asString(record.content);
	if (direct) return direct;
	const kwargs = asRecord(record.kwargs);
	const content = kwargs.content;
	if (typeof content === "string") return content;
	// A content array is the multi-part form: keep only the text blocks.
	return asArray(content)
		.map((block) => asString(asRecord(block).text) ?? "")
		.filter(Boolean)
		.join("\n");
}

export function datasourcesFromTags(tags: unknown): string[] {
	const tag = asArray(tags)
		.map((t) => asString(t) ?? "")
		.find((t) => t.startsWith("datasources:"));
	if (!tag) return [];
	const value = tag.slice("datasources:".length);
	return value && value !== "auto" ? value.split(",").filter(Boolean) : [];
}

export function threadFromTags(tags: unknown): string | null {
	const tag = asArray(tags)
		.map((t) => asString(t) ?? "")
		.find((t) => t.startsWith("thread:"));
	return tag ? tag.slice("thread:".length) : null;
}

// An eval or replay run has no human to react to, so user-reaction detectors must not read
// it. The eval harness runs through the same graph, so the tell is the absence of the UI's
// own "chat" tag.
function isHeadless(tags: unknown): boolean {
	return !asArray(tags)
		.map((t) => asString(t) ?? "")
		.includes("chat");
}

// Reads the ROOT run's own outputs, never its child runs. A trace has 300-400 children and
// a tool child's `error` is free text whose category is only sometimes embedded (2 of 5
// sampled), whereas outputs.dataSourceResults is what the app already built: typed
// toolErrors {toolName,category,message,retryable} plus toolOutputs {toolName,rawJson,
// toolArgs}. One fetch instead of hundreds, which is what keeps a 230-run window affordable.
export function runToRawSession(run: LangSmithRun): RawSession {
	const inputs = asRecord(run.inputs);
	const outputs = asRecord(run.outputs);
	const tags = run.tags;
	const messages: RawMessage[] = [];

	const created = asString(run.start_time) ?? (run.start_time instanceof Date ? run.start_time.toISOString() : null);

	// ONLY the turn this run introduced -- the LAST input message. `inputs.messages` carries
	// the thread's accumulated user history, so a follow-up run repeats the turns of the runs
	// before it (measured: one thread's two runs carried 1 then 2 messages, both `human`).
	// Taking them all would re-emit an earlier reaction as a fresh signal in every later run
	// of that thread, and aggregation would read one correction as a recurring gap.
	//
	// Nothing is lost: the earlier turn was already scanned as part of its own run.
	const inputMessages = asArray(inputs.messages);
	const ownTurn = inputMessages[inputMessages.length - 1];
	if (ownTurn !== undefined) {
		const text = messageContent(ownTurn);
		if (text) messages.push({ role: "user", created, parts: [{ type: "text", text }] });
	}

	// ONE assistant message PER dataSourceResult, not one for the whole turn. A turn holds
	// several entries for the same datasource -- one per sub-agent dispatch (measured: aws
	// x4 in a single turn, from the estate fan-out and per-deployment calls). Flattening
	// them into one message makes the same call in two dispatches look like a repeat, which
	// reported 78% of all calls as repeats on a real window. A message boundary here means
	// "one dispatch", so repeat-call only fires when a dispatch really did loop.
	for (const entry of asArray(outputs.dataSourceResults)) {
		const result = asRecord(entry);
		const dataSourceId = asString(result.dataSourceId) ?? "unknown";
		const parts: RawPart[] = [];

		for (const output of asArray(result.toolOutputs)) {
			const tool = asRecord(output);
			const name = asString(tool.toolName);
			if (!name) continue;
			// Identity is (args + a fingerprint of the RESULT), because toolArgs alone is too
			// coarse to tell a redundant call from a legitimate poll. Measured on one AWS
			// trace: of 48 same-arg pairs, 28 also returned an identical result (genuinely
			// redundant) and 20 returned different data -- aws_logs_get_query_results(queryId)
			// polling an async query, which must not read as a loop.
			//
			// A HASH, never the payload: rawJson carries real log lines, hostnames and account
			// ids, and an excerpt of it would reach a report.
			const args = asRecord(tool.toolArgs);
			parts.push({
				type: "tool_call",
				toolCallId: null,
				name,
				input: JSON.stringify({ args, result: fingerprint(tool.rawJson) }),
				// SIO-1856: toolArgs is scalars-only by construction (tool-trajectory.ts's
				// privacy invariant), so a tool whose real input is a nested object records
				// nothing that identifies the call. Measured: of 1084 elasticsearch_search
				// calls, 831 recorded NO args and the rest only [index,size] -- the query
				// body never appears. Two different searches are indistinguishable, and 31
				// dispatches had "identical" searches returning DIFFERENT results.
				//
				// Empty args are only trustworthy for a tool that genuinely takes none
				// (aws_ecs_list_clusters, kafka_list_topics), and those are exactly the ones
				// whose declared input is empty everywhere. We cannot tell the two cases
				// apart from one call, so the flag is set per tool below.
				argsIdentifyTheCall: argsCanIdentify(name, args),
			});
		}

		for (const error of asArray(result.toolErrors)) {
			const toolError = asRecord(error);
			// Validate against the enum rather than casting: an unrecognized category
			// degrades to null, which verdictForCategory treats as indicting rather than
			// silently excusing an unknown failure as environmental.
			const parsed = ToolErrorCategorySchema.safeParse(toolError.category);
			parts.push({
				type: "tool_result",
				toolCallId: null,
				name: asString(toolError.toolName) ?? `${dataSourceId}_tool`,
				content: asString(toolError.message) ?? "",
				failed: true,
				category: parsed.success ? parsed.data : null,
			});
		}

		if (parts.length) messages.push({ role: "assistant", created, parts });
	}

	for (const message of asArray(outputs.messages)) {
		const record = asRecord(message);
		const type = asString(record.type);
		if (type && type !== "ai" && type !== "constructor") continue;
		const text = messageContent(message);
		if (text) messages.push({ role: "assistant", created, parts: [{ type: "text", text }] });
	}

	return RawSessionSchema.parse({
		meta: {
			host: "langsmith",
			id: asString(run.id) ?? "",
			threadId: threadFromTags(tags),
			created,
			headless: isHeadless(tags),
			datasources: datasourcesFromTags(tags),
		},
		messages,
	});
}

export async function listSessions(options: ListOptions): Promise<{ sessions: RawSession[]; warnings: string[] }> {
	const client = options.client ?? new Client();
	const since = new Date(Date.now() - options.hours * 3600_000);
	const limit = options.limit ?? 200;
	const sessions: RawSession[] = [];
	const warnings: string[] = [];

	try {
		// listRuns is deprecated in favour of client.runs.query() after Jan 2027, but that
		// method does NOT exist in the installed langsmith@0.6.3 (verified: typeof
		// c.runs?.query === "undefined"). Revisit on upgrade.
		for await (const run of client.listRuns({
			projectName: options.projectName ?? process.env.LANGSMITH_PROJECT,
			isRoot: true,
			startTime: since,
		})) {
			const candidate = run as unknown as LangSmithRun;
			if (asString(candidate.name) !== ROOT_RUN_NAME) continue;
			try {
				sessions.push(runToRawSession(candidate));
			} catch (error) {
				// One malformed run must not lose the window. Report it rather than
				// silently returning a short list.
				warnings.push(
					`run ${asString(candidate.id) ?? "?"}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (sessions.length >= limit) break;
		}
	} catch (error) {
		warnings.push(`listRuns failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	return { sessions, warnings };
}
