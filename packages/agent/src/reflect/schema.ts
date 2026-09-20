// packages/agent/src/reflect/schema.ts
//
// SIO-1834: the data contracts for the skill-reflection pipeline. Three shapes, each the
// output of one stage: RawSession (adapter) -> NormalizedSession (normalize) -> Scan (scan).
//
// Ported from xskills@cded11d skills/x-autoreflection, with the target's own conventions:
// failure is the structured ToolErrorCategory enum rather than exit-code text matching, and
// a signal's suspects are DATASOURCES, not skill names. The probe recorded on SIO-1834 found
// no per-skill signal in a trace -- sub-agents appear as generic LangGraph nodes -- so
// attributing to a skill would mean inventing the attribution. Datasource is real and
// present on every tool run, so that is what a signal names until a skill signal exists.
import { ToolErrorCategorySchema } from "@devops-agent/shared";
import { z } from "zod";

export const SIGNAL_KINDS = [
	"tool-failure",
	"expected-outcome",
	"repeat-call",
	"user-correction",
	"user-reprompt",
	"user-redo",
	"user-handoff",
	"user-abandon",
] as const;
export const SignalKindSchema = z.enum(SIGNAL_KINDS);
export type SignalKind = z.infer<typeof SignalKindSchema>;

export const SeveritySchema = z.enum(["high", "medium", "low"]);
export type Severity = z.infer<typeof SeveritySchema>;

// SIO-1087's categories split three ways for reflection. A category that indicts the CALLER
// (the query was malformed, or nothing classified it) can become a finding; the rest cannot.
// not-found and no-data are documented at agent-state.ts:20-24 as normal findings rather than
// malfunctions, and auth/session/transient/server-error are environment failures -- xskills'
// gap-taxonomy lists both classes under "not a gap".
export const INDICTING_CATEGORIES = ["bad-query", "unknown"] as const;
export const EXPECTED_CATEGORIES = ["not-found", "no-data"] as const;
export const ENVIRONMENT_CATEGORIES = ["auth", "session", "transient", "server-error"] as const;

export type ToolFailureVerdict = "indicting" | "expected" | "environment";

export function verdictForCategory(category: string | null | undefined): ToolFailureVerdict {
	if (category && (EXPECTED_CATEGORIES as readonly string[]).includes(category)) return "expected";
	if (category && (ENVIRONMENT_CATEGORIES as readonly string[]).includes(category)) return "environment";
	return "indicting";
}

// --- Stage 1: what an adapter returns -------------------------------------------------

export const RawPartSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("text"), text: z.string() }),
	z.object({
		type: z.literal("tool_call"),
		toolCallId: z.string().nullable(),
		name: z.string(),
		input: z.string().describe("JSON-encoded tool arguments, kept whole for repeat-call comparison"),
	}),
	z.object({
		type: z.literal("tool_result"),
		toolCallId: z.string().nullable(),
		name: z.string().nullable(),
		content: z.string(),
		failed: z.boolean().describe("the run errored; category says whether that indicts the caller"),
		category: ToolErrorCategorySchema.nullable(),
	}),
]);
export type RawPart = z.infer<typeof RawPartSchema>;

export const RawMessageSchema = z.object({
	role: z.enum(["user", "assistant"]),
	created: z.string().nullable(),
	parts: z.array(RawPartSchema),
});
export type RawMessage = z.infer<typeof RawMessageSchema>;

export const RawSessionSchema = z.object({
	meta: z.object({
		host: z.string(),
		id: z.string().describe("the LangSmith root run id"),
		threadId: z.string().nullable(),
		created: z.string().nullable(),
		headless: z.boolean().describe("an eval or replay run, excluded from user-reaction signals"),
		datasources: z.array(z.string()).describe("from the run's datasources: tag"),
	}),
	messages: z.array(RawMessageSchema),
});
export type RawSession = z.infer<typeof RawSessionSchema>;

// --- Stage 2: normalized (scanner input) ----------------------------------------------

export const NormalizedMessageSchema = RawMessageSchema.extend({ index: z.number() });
export type NormalizedMessage = z.infer<typeof NormalizedMessageSchema>;

export const NormalizedSessionSchema = z.object({
	source: RawSessionSchema.shape.meta,
	messages: z.array(NormalizedMessageSchema),
});
export type NormalizedSession = z.infer<typeof NormalizedSessionSchema>;

// --- Stage 3: scan (one per session) --------------------------------------------------

export const EvidenceSchema = z.object({
	message: z.number().describe("index into the normalized messages"),
	tool: z.string().nullable(),
	excerpt: z.string(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const SignalSchema = z.object({
	id: z.string().regex(/^S\d+$/),
	kind: SignalKindSchema,
	severity: SeveritySchema,
	summary: z.string(),
	count: z.number(),
	suspects: z.array(z.string()).describe("datasource ids; empty means no datasource owns this gap"),
	evidence: z.array(EvidenceSchema).max(3),
});
export type Signal = z.infer<typeof SignalSchema>;

// A closed vocabulary rather than Record<string, number>: every counter is known at compile
// time, so a typo reads as a type error instead of silently creating a new stat.
export const ScanStatsSchema = z.object({
	messages: z.number(),
	userMessages: z.number(),
	assistantMessages: z.number(),
	toolCalls: z.number(),
	toolResults: z.number(),
	toolFailures: z.number().describe("indicting failures only; see verdictForCategory"),
	expectedOutcomes: z.number(),
	environmentFailures: z.number().describe("counted for context, never a finding"),
	repeats: z.number(),
	corrections: z.number(),
	reprompts: z.number(),
	redoRequests: z.number(),
	handoffs: z.number(),
});
export type ScanStats = z.infer<typeof ScanStatsSchema>;

export const ScanSchema = z.object({
	source: NormalizedSessionSchema.shape.source,
	request: z
		.object({ message: z.number(), created: z.string().nullable(), text: z.string() })
		.nullable()
		.describe("first user turn of >= 8 words; the handle for cross-session retry matching"),
	stats: ScanStatsSchema,
	signals: z.array(SignalSchema),
	notes: z.array(z.string()),
});
export type Scan = z.infer<typeof ScanSchema>;
