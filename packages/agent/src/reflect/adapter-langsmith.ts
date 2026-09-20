// packages/agent/src/reflect/adapter-langsmith.ts
//
// SIO-1834 (A1): LangSmith traces -> RawSession. This repo stores no run transcripts
// locally (the checkpointer is in-memory, the daily log keeps failure CATEGORIES only by
// design, SIO-1687), so LangSmith is the only place a past turn survives.
//
// SHAPE, as measured on the live project 2026-09-20 (do not infer it from the SDK types):
//
//   root run: name="agent.request", isRoot, tags ["chat","thread:<id>","datasources:a,b"]
//     inputs.messages[]        LangChain-serialized: {id,kwargs:{content},lc,type}
//     outputs.messages[]       either {type:"ai",content} or an unresolved {type:"constructor"}
//     outputs.dataSourceResults[]  {dataSourceId,status,duration,toolOutputs[],toolErrors[]?}
//       toolErrors[]           {toolName,category,message,retryable} -- the TYPED failure,
//                              carrying a real ToolErrorCategory
//       toolOutputs[]          {toolName,rawJson,toolArgs}
//
// Why the root's own outputs rather than the child runs: a trace has 300-400 children, and a
// tool child's `error` is a free-text string whose category is only sometimes embedded (2 of
// 5 sampled). dataSourceResults is what the app already built -- typed, deduped, and one
// fetch instead of hundreds. Child runs are never listed here, which is also what keeps a
// 230-run window affordable.
//
// listRuns is deprecated in favour of client.runs.query() after Jan 2027, but that method
// does NOT exist in the installed langsmith@0.6.3 (verified: typeof c.runs?.query ===
// "undefined"). Revisit when the dependency is upgraded.
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

export function runToRawSession(run: LangSmithRun): RawSession {
	const inputs = asRecord(run.inputs);
	const outputs = asRecord(run.outputs);
	const tags = run.tags;
	const messages: RawMessage[] = [];

	const created = asString(run.start_time) ?? (run.start_time instanceof Date ? run.start_time.toISOString() : null);

	for (const message of asArray(inputs.messages)) {
		const text = messageContent(message);
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
			parts.push({
				type: "tool_call",
				toolCallId: null,
				name,
				input: JSON.stringify({
					args: tool.toolArgs ?? {},
					result: fingerprint(tool.rawJson),
				}),
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
