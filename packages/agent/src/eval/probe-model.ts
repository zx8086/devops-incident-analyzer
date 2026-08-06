// packages/agent/src/eval/probe-model.ts
//
// SIO-1224: the pre-merge model-conformance probe. SIO-1213 bumped two manifests to Sonnet 5
// / Opus 4.8 and five production failures followed in a single day -- temperature rejected
// (SIO-1214), a reasoning-block null crash (SIO-1216), [object Object] and mid-word newlines
// in the stream (SIO-1217/1218), unescaped control chars breaking JSON.parse (SIO-1219), and
// an aggregation abort with zero output (SIO-1220). Every one of those was a CAPABILITY
// assumption this codebase held silently. This script makes them explicit and measurable
// BEFORE a bump merges.
//
// Deliberately a standalone `bun run` script and NOT a *.test.ts: CI runs `bun test` in every
// workspace package, so a test file would bill Bedrock on every pull request.
//
// It probes the PRODUCTION path (ChatBedrockConverse via @langchain/aws), not the raw AWS
// SDK, because five of the six failures lived in the langchain->app boundary -- including one
// that was a @langchain/aws bug. A raw ConverseCommand probe would have missed all of them.
//
//   bun run model:probe -- <model-name> [--agent <name>] [--discover|--verify]
//                          [--report] [--samples N] [--yes]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveBedrockConfig } from "@devops-agent/gitagent-bridge";
import { ChatBedrockConverse } from "@langchain/aws";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { type LlmRole, LONG_FORM_ROLES, ROLE_OVERRIDES } from "../llm.ts";
import { parseLlmJson, sanitizeJsonControlChars } from "../llm-json.ts";
import { extractStreamDeltaText, extractTextFromContent } from "../message-utils.ts";
import { getWorkspaceRoot } from "../paths.ts";
import { getAgentByName } from "../prompt-context.ts";

// ---------------------------------------------------------------- CLI

const argv = process.argv.slice(2);
function flag(name: string): boolean {
	return argv.includes(`--${name}`);
}
function opt(name: string): string | undefined {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
}

const VALUE_FLAGS = new Set(["--agent", "--samples"]);
const positionals = argv.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(argv[i - 1] ?? ""));
const target = positionals[0];
if (!target) {
	console.error("usage: bun run model:probe -- <model-name> [--agent <name>] [--verify] [--discover] [--report]");
	process.exit(2);
}
const agentName = opt("agent");
const samples = Number(opt("samples") ?? 3);
const wantReport = flag("report");

const REGION = process.env.AWS_REGION ?? "eu-central-1";

// --------------------------------------------------------------- types

interface ProbeResult {
	modelName: string;
	bedrockId: string;
	acceptsTemperature: boolean;
	temperatureRejection: string | null;
	contentShapeWithoutTools: "string" | "blocks";
	contentShapeWithTools: "string" | "blocks";
	observedBlockTypes: string[];
	emitsReasoningContent: boolean;
	reasoningHits: string;
	observedRawControlCharsInJson: boolean;
	controlCharHitRate: string;
	stopReasons: Array<{ maxTokens: number; roles: string[]; prompt: string; stopReason: string; outputTokens: number }>;
	longFormMinTokens: number;
	truncatedLongFormRoles: string[];
	// SIO-1428: P6L, the same floor measured against a ~40K-input-token prompt.
	largeLongFormRows: Array<{
		maxTokens: number;
		roles: string[];
		sample: number;
		stopReason: string;
		outputTokens: number;
		inputTokens: number;
	}>;
	largeLongFormMinTokens: number;
	largeLongFormInputTokens: number;
	latencyMs: { p50: number; max: number };
	extractionSafe: boolean;
	streamMultiBlockChunks: number;
	streamExtractionSafe: boolean;
}

const latencies: number[] = [];

function build(bedrockId: string, maxTokens: number, temperature?: number): ChatBedrockConverse {
	return new ChatBedrockConverse({
		model: bedrockId,
		region: REGION,
		maxTokens,
		...(temperature === undefined ? {} : { temperature }),
	});
}

// Every call goes through here so P7's latency numbers cover the whole run, not a subset.
async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
	const start = performance.now();
	const value = await fn();
	const ms = performance.now() - start;
	latencies.push(ms);
	return { value, ms };
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0);
}

function shapeOf(content: unknown): "string" | "blocks" {
	return typeof content === "string" ? "string" : "blocks";
}

function blockTypesOf(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return [...new Set(content.map((b) => String((b as { type?: unknown })?.type ?? typeof b)))];
}

// ---------------------------------------------------------------- prompts

const SHORT_PROMPT = "Reply with exactly one word: ok";

// Thinking on these models is ADAPTIVE: a trivial prompt comes back as a plain string, while
// a prompt that needs reasoning comes back as [reasoning, text] blocks WITH a signature.
// Probing only the trivial prompt reports "string" and misses the shape that actually broke
// SIO-1216/1217 -- which is exactly how a raw-SDK probe of this can mislead.
const REASONING_MESSAGES = () => [
	new SystemMessage("Think carefully step by step before answering."),
	new HumanMessage("A train leaves at 3pm going 60mph, another at 4pm going 80mph. When do they meet?"),
];

// ~600 input tokens of realistic incident material. P6 uses this to find the truncation floor,
// so it must be representative of what aggregator/responder/iacReader actually answer.
const LONG_FORM_PROMPT = [
	"You are a DevOps incident analyst. Produce a full written analysis with these sections:",
	"Timeline, Findings per datasource, Correlation, Root-cause hypotheses (ranked), Mitigation, Gaps.",
	"End with a line 'Confidence: <0-1>'.",
	"",
	"Evidence:",
	"- Kafka: consumer group orders-v2-consumer lag 4,210,553 on topic orders-v2, 12 partitions, all lagging.",
	"- Elasticsearch APM: order-service 503 rate rose from 0.2% to 41% starting 12:04Z.",
	"- Elasticsearch logs: 'I/O error on GET request for api-gateway.internal.example/v3/catalog'",
	"  with 'Timeout deadline: 180000 MILLISECONDS, actual: 180000 MILLISECONDS', 8,412 occurrences.",
	"- GitLab: order-service deploy pipeline 44821 succeeded at 11:58Z, commit a1b2c3d, 14 files changed.",
	"- Couchbase: bucket orders resident ratio 12%, 3 slow N1QL queries over 30s on system:indexes.",
	"- Kong Konnect: route seasons-v3 upstream latency p99 rose 180ms -> 180000ms at 12:03Z.",
	"- AWS CloudWatch: ECS service order-service running 4/6 desired tasks, 2 stopped OOM.",
].join("\n");

// SIO-1428: the small LONG_FORM_PROMPT above (~600 input tokens) never puts an adaptive-
// thinking model's reasoning block and its answer text in competition for the same output
// budget -- the exact failure the 32-incident replay eval exposed on Sonnet 5 (30-49K-token
// aggregator prompts, max_tokens on 13/64 calls at the then-configured 16384, twice with the
// reasoning block alone consuming the whole budget; SIO-1375). P6L probes that regime with a
// synthetic prompt tiled to a realistic size: content authenticity is irrelevant, input SCALE
// is what triggers long reasoning plus a long answer.
const LARGE_LONG_FORM_TARGET_TOKENS = 40_000;

function buildLargeLongFormPrompt(): string {
	const sections: string[] = [LONG_FORM_PROMPT, "", "Additional evidence collected across services and windows:"];
	// ~4 chars/token heuristic; tile numbered, varied evidence lines until the target size so
	// the model cannot compress-by-omission the way it could with one repeated block.
	const targetChars = LARGE_LONG_FORM_TARGET_TOKENS * 4;
	let charCount = sections.join("\n").length;
	let i = 0;
	while (charCount < targetChars) {
		i += 1;
		const line =
			`- Service checkout-svc-${i}: APM 5xx rate ${(i % 37) + 1}.${i % 10}% between 1${i % 10}:0${i % 6}Z and 1${i % 10}:4${i % 6}Z; ` +
			`ECS tasks ${(i % 5) + 1}/6 healthy; consumer group cg-${i} lag ${100_000 + i * 917}; ` +
			`N1QL scan on bucket b${i % 8} averaged ${(i % 20) + 1}s; deploy pipeline ${40_000 + i} ${i % 3 === 0 ? "succeeded" : "not found"}; ` +
			`log sample: 'Timeout deadline: ${180 - (i % 90)}s exceeded on GET /v${(i % 4) + 1}/inventory/${i}'.`;
		sections.push(line);
		charCount += line.length + 1;
	}
	return sections.join("\n");
}

// P5 asks for the shape that broke SIO-1219: a JSON envelope with a string value that must
// carry a multi-line document verbatim.
//
// IMPORTANT: this is a STOCHASTIC detector and a negative result proves nothing. SIO-1219 was
// a real production failure on Sonnet 5 that this probe does NOT reliably reproduce on demand.
// So the field it feeds is named "observed...", not "emits...", and parseLlmJson sanitizes
// UNCONDITIONALLY at all thirteen call sites (SIO-1221) regardless of what this reports. A
// "not observed" here must never be used to justify removing the sanitizer.
const CONTROL_CHAR_PROMPT = [
	'Return ONLY a JSON object of the form {"summary": string, "raw": string}.',
	'Put this text into "raw" EXACTLY as given, preserving its line breaks and indentation:',
	"",
	"xpack.security:",
	"\tenabled: true",
	"\trealms:",
	"\t\tnative1:",
	"\t\t\torder: 0",
	"",
	'Put a one-sentence description into "summary".',
].join("\n");

// ---------------------------------------------------------------- probes

async function probeTemperature(bedrockId: string): Promise<{ accepts: boolean; rejection: string | null }> {
	try {
		await timed(() => build(bedrockId, 16, 0).invoke([new HumanMessage(SHORT_PROMPT)]));
		return { accepts: true, rejection: null };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// Only a temperature-specific rejection counts. Anything else is a real failure and
		// must not be silently recorded as "this model rejects temperature".
		if (!/temperature/i.test(message)) throw error;
		// Confirm the same call succeeds WITHOUT temperature, so we are not mislabelling an
		// unrelated outage as a capability.
		await timed(() => build(bedrockId, 16).invoke([new HumanMessage(SHORT_PROMPT)]));
		return { accepts: false, rejection: message.split("\n")[0]?.trim() ?? message };
	}
}

async function probeContentShape(bedrockId: string): Promise<{
	withoutTools: "string" | "blocks";
	withTools: "string" | "blocks";
	blockTypes: string[];
	extractionSafe: boolean;
	streamMultiBlockChunks: number;
	streamExtractionSafe: boolean;
}> {
	const trivial = await timed(() => build(bedrockId, 256).invoke([new HumanMessage(SHORT_PROMPT)]));
	const reasoning = await timed(() => build(bedrockId, 1024).invoke(REASONING_MESSAGES()));

	const tool = {
		name: "kafka_get_consumer_group_lag",
		description: "Get consumer group lag for a Kafka topic",
		schema: z.object({ topic: z.string().describe("topic name") }),
	};
	const bound = build(bedrockId, 512).bindTools([tool]);
	const withTools = await timed(() =>
		bound.invoke([new HumanMessage("Get the consumer lag for topic orders-v2. Use the tool.")]),
	);

	const noToolContents = [trivial.value.content, reasoning.value.content];
	const blockTypes = [...new Set([...noToolContents.flatMap(blockTypesOf), ...blockTypesOf(withTools.value.content)])];
	// The guarantee that matters downstream: the real helper must never emit the SIO-1217 string.
	const extracted = [...noToolContents, withTools.value.content].map(extractTextFromContent);
	const extractionSafe = !extracted.some((t) => t.includes("[object Object]"));

	// SIO-1217/1218 bit on the STREAMING path (AIMessageChunk), not on invoke -- sse-pump.ts is
	// the only delta consumer. A chunk carrying more than one block is what the "\n" join
	// garbled mid-word, so count those explicitly instead of inferring from the invoke shape.
	let streamMultiBlockChunks = 0;
	let streamText = "";
	// Timed like every other probe call: timed() wraps the WHOLE drain, not just the initial
	// stream() handshake, so P7's p50/max genuinely covers this call too.
	await timed(async () => {
		const stream = await build(bedrockId, 1024).stream(REASONING_MESSAGES());
		for await (const chunk of stream) {
			if (Array.isArray(chunk.content) && chunk.content.length > 1) streamMultiBlockChunks++;
			streamText += extractStreamDeltaText(chunk.content);
		}
	});

	return {
		// "blocks" if ANY no-tool prompt returned blocks -- adaptive thinking makes this a union.
		withoutTools: noToolContents.some((c) => Array.isArray(c)) ? "blocks" : "string",
		withTools: shapeOf(withTools.value.content),
		blockTypes,
		extractionSafe,
		streamMultiBlockChunks,
		streamExtractionSafe: !streamText.includes("[object Object]"),
	};
}

async function probeReasoning(bedrockId: string): Promise<{ emits: boolean; hits: string }> {
	const REASONING_KEYS = ["reasoning_content", "reasoningContent", "thinking", "redacted_thinking", "reasoning"];
	const hasReasoning = (content: unknown, kwargs: unknown): boolean => {
		if (Array.isArray(content) && blockTypesOf(content).some((t) => REASONING_KEYS.includes(t))) return true;
		return typeof kwargs === "object" && kwargs !== null && REASONING_KEYS.some((k) => k in kwargs);
	};

	const cases: Array<[string, () => Promise<{ content: unknown; additional_kwargs?: unknown }>]> = [
		["plain", () => build(bedrockId, 512).invoke([new HumanMessage(SHORT_PROMPT)])],
		[
			"think-step-by-step",
			() =>
				build(bedrockId, 1024).invoke([
					new SystemMessage("Think carefully step by step before answering."),
					new HumanMessage("A train leaves at 3pm going 60mph, another at 4pm going 80mph. When do they meet?"),
				]),
		],
		[
			"with-tools",
			() =>
				build(bedrockId, 512)
					.bindTools([{ name: "get_lag", description: "get lag", schema: z.object({ topic: z.string() }) }])
					.invoke([new HumanMessage("Get the lag for orders-v2 using the tool.")]),
		],
	];

	let count = 0;
	for (const [, invoke] of cases) {
		const { value } = await timed(invoke);
		if (hasReasoning(value.content, value.additional_kwargs)) count++;
	}
	return { emits: count > 0, hits: `${count}/${cases.length}` };
}

async function probeControlChars(bedrockId: string): Promise<{ emits: boolean; hitRate: string }> {
	const schema = z.object({ summary: z.string(), raw: z.string() });
	let bareFailures = 0;
	let sanitizedSuccesses = 0;
	for (let i = 0; i < samples; i++) {
		const { value } = await timed(() => build(bedrockId, 1024).invoke([new HumanMessage(CONTROL_CHAR_PROMPT)]));
		const text = extractTextFromContent(value.content);
		const block = text.match(/\{[\s\S]*\}/)?.[0];
		if (!block) continue;
		try {
			JSON.parse(block);
		} catch {
			bareFailures++;
			try {
				JSON.parse(sanitizeJsonControlChars(block));
				sanitizedSuccesses++;
			} catch {
				// malformed for a reason the sanitizer cannot fix; not a control-char case
			}
		}
		// Also confirm the production helper handles it end to end.
		parseLlmJson(text, schema);
	}
	return {
		emits: sanitizedSuccesses > 0,
		hitRate: `bare parse failed ${bareFailures}/${samples}, sanitizer rescued ${sanitizedSuccesses}/${bareFailures || 0}`,
	};
}

async function probeStopReasons(bedrockId: string, manifestMaxTokens: number) {
	// Derive the budgets from the real table so this can never drift from production.
	const byTokens = new Map<number, string[]>();
	for (const role of Object.keys(ROLE_OVERRIDES) as LlmRole[]) {
		const effective = ROLE_OVERRIDES[role].maxTokens ?? manifestMaxTokens;
		byTokens.set(effective, [...(byTokens.get(effective) ?? []), role]);
	}
	const budgets = [...byTokens.keys()].sort((a, b) => a - b);

	const rows: ProbeResult["stopReasons"] = [];
	for (const maxTokens of budgets) {
		const roles = (byTokens.get(maxTokens) ?? []).sort();
		const anyLongForm = roles.some((r) => LONG_FORM_ROLES.has(r as LlmRole));
		// A 16-token budget cannot answer the long-form prompt and is not meant to; only probe
		// long-form where at least one role on that budget actually produces long output.
		const promptLabel = anyLongForm ? "long-form" : "short";
		const messages = anyLongForm ? [new HumanMessage(LONG_FORM_PROMPT)] : [new HumanMessage(SHORT_PROMPT)];
		const { value } = await timed(() => build(bedrockId, maxTokens).invoke(messages));
		const meta = value.response_metadata as { stopReason?: string } | undefined;
		const usage = value.usage_metadata as { output_tokens?: number } | undefined;
		rows.push({
			maxTokens,
			roles,
			prompt: promptLabel,
			stopReason: meta?.stopReason ?? "unknown",
			outputTokens: usage?.output_tokens ?? 0,
		});
	}

	const longFormOk = rows.filter((r) => r.prompt === "long-form" && r.stopReason === "end_turn");
	const longFormMinTokens = longFormOk.length > 0 ? Math.min(...longFormOk.map((r) => r.maxTokens)) : 0;
	const truncated = rows
		.filter((r) => r.prompt === "long-form" && r.stopReason === "max_tokens")
		.flatMap((r) => r.roles.filter((role) => LONG_FORM_ROLES.has(role as LlmRole)));

	return { rows, longFormMinTokens, truncated };
}

// SIO-1428: P6L -- the LARGE-prompt long-form floor. Only long-form budgets are probed (a
// short budget cannot answer and is not meant to), each with `samples` attempts because
// reasoning emission is stochastic on these models: one clean sample proves nothing, so the
// floor is the smallest budget where EVERY sample ended with end_turn. Derived from the same
// ROLE_OVERRIDES table as P6 so it cannot drift from production.
async function probeLargeLongForm(bedrockId: string, manifestMaxTokens: number) {
	const prompt = buildLargeLongFormPrompt();
	const byTokens = new Map<number, string[]>();
	for (const role of Object.keys(ROLE_OVERRIDES) as LlmRole[]) {
		if (!LONG_FORM_ROLES.has(role)) continue;
		const effective = ROLE_OVERRIDES[role].maxTokens ?? manifestMaxTokens;
		byTokens.set(effective, [...(byTokens.get(effective) ?? []), role]);
	}
	const budgets = [...byTokens.keys()].sort((a, b) => a - b);

	const rows: Array<{
		maxTokens: number;
		roles: string[];
		sample: number;
		stopReason: string;
		outputTokens: number;
		inputTokens: number;
	}> = [];
	for (const maxTokens of budgets) {
		const roles = (byTokens.get(maxTokens) ?? []).sort();
		for (let sample = 1; sample <= samples; sample++) {
			const { value } = await timed(() => build(bedrockId, maxTokens).invoke([new HumanMessage(prompt)]));
			const meta = value.response_metadata as { stopReason?: string } | undefined;
			const usage = value.usage_metadata as { output_tokens?: number; input_tokens?: number } | undefined;
			rows.push({
				maxTokens,
				roles,
				sample,
				stopReason: meta?.stopReason ?? "unknown",
				outputTokens: usage?.output_tokens ?? 0,
				inputTokens: usage?.input_tokens ?? 0,
			});
		}
	}

	const cleanBudgets = budgets.filter((b) =>
		rows.filter((r) => r.maxTokens === b).every((r) => r.stopReason === "end_turn"),
	);
	const largeLongFormMinTokens = cleanBudgets.length > 0 ? Math.min(...cleanBudgets) : 0;
	const inputTokens = rows.length > 0 ? Math.max(...rows.map((r) => r.inputTokens)) : 0;
	return { rows, largeLongFormMinTokens, inputTokens };
}

// ---------------------------------------------------------------- run

async function probeOne(modelName: string): Promise<ProbeResult> {
	const cfg = resolveBedrockConfig({ preferred: modelName });
	const bedrockId = cfg.model;
	console.log(`\nProbing ${modelName} (${bedrockId}) in ${REGION}\n`);

	const temp = await probeTemperature(bedrockId);
	console.log(
		`P1 temperature ................. ${temp.accepts ? "ACCEPTED" : "REJECTED"}   acceptsTemperature: ${temp.accepts}`,
	);
	if (temp.rejection) console.log(`   |- "${temp.rejection}"`);

	const shape = await probeContentShape(bedrockId);
	console.log(`P2 content, no tools ........... ${shape.withoutTools}`);
	console.log(
		`P3 content, tools bound ........ ${shape.withTools}   blocks: [${shape.blockTypes.join(", ")}]   extract ${
			shape.extractionSafe ? "ok" : "PRODUCED [object Object]"
		}`,
	);

	console.log(
		`P3b streaming deltas ........... ${shape.streamMultiBlockChunks} multi-block chunk(s)   extract ${
			shape.streamExtractionSafe ? "ok" : "PRODUCED [object Object]"
		}`,
	);

	const reasoning = await probeReasoning(bedrockId);
	console.log(`P4 reasoningContent ............ ${reasoning.emits ? "PRESENT" : "ABSENT"}   ${reasoning.hits}`);

	const control = await probeControlChars(bedrockId);
	console.log(`P5 raw control chars in JSON ... ${control.emits ? "OBSERVED" : "not observed"}   ${control.hitRate}`);

	const stop = await probeStopReasons(bedrockId, cfg.maxTokens);
	console.log("P6 stopReason x maxTokens");
	console.log("   maxTokens  prompt      stopReason   outTok  roles");
	for (const r of stop.rows) {
		const bad = r.prompt === "long-form" && r.stopReason === "max_tokens" ? "  <-- TRUNCATES" : "";
		console.log(
			`   ${String(r.maxTokens).padStart(9)}  ${r.prompt.padEnd(10)}  ${r.stopReason.padEnd(11)} ${String(
				r.outputTokens,
			).padStart(6)}  ${r.roles.join(", ")}${bad}`,
		);
	}
	console.log(`   longFormMinTokens = ${stop.longFormMinTokens}`);

	const large = await probeLargeLongForm(bedrockId, cfg.maxTokens);
	console.log(`P6L stopReason x maxTokens, LARGE prompt (~${large.inputTokens} input tokens)`);
	console.log("   maxTokens  sample  stopReason   outTok  roles");
	for (const r of large.rows) {
		const bad = r.stopReason === "max_tokens" ? "  <-- TRUNCATES" : "";
		console.log(
			`   ${String(r.maxTokens).padStart(9)}  ${String(r.sample).padStart(6)}  ${r.stopReason.padEnd(11)} ${String(
				r.outputTokens,
			).padStart(6)}  ${r.roles.join(", ")}${bad}`,
		);
	}
	console.log(`   largeLongFormMinTokens = ${large.largeLongFormMinTokens}`);

	const latencyMs = { p50: percentile(latencies, 50), max: Math.max(...latencies.map((n) => Math.round(n))) };
	console.log(`P7 latency ..................... p50 ${latencyMs.p50}ms / max ${latencyMs.max}ms`);

	return {
		modelName,
		bedrockId,
		acceptsTemperature: temp.accepts,
		temperatureRejection: temp.rejection,
		contentShapeWithoutTools: shape.withoutTools,
		contentShapeWithTools: shape.withTools,
		observedBlockTypes: shape.blockTypes,
		emitsReasoningContent: reasoning.emits,
		reasoningHits: reasoning.hits,
		observedRawControlCharsInJson: control.emits,
		controlCharHitRate: control.hitRate,
		stopReasons: stop.rows,
		longFormMinTokens: stop.longFormMinTokens,
		truncatedLongFormRoles: [...new Set(stop.truncated)],
		largeLongFormRows: large.rows,
		largeLongFormMinTokens: large.largeLongFormMinTokens,
		largeLongFormInputTokens: large.inputTokens,
		latencyMs,
		extractionSafe: shape.extractionSafe,
		streamMultiBlockChunks: shape.streamMultiBlockChunks,
		streamExtractionSafe: shape.streamExtractionSafe,
	};
}

function registryLiteral(r: ProbeResult, verifiedAt: string): string {
	return [
		`\t"${r.modelName}": {`,
		`\t\tbedrockId: "${r.bedrockId}",`,
		`\t\tacceptsTemperature: ${r.acceptsTemperature},`,
		`\t\tcontentShapeWithoutTools: "${r.contentShapeWithoutTools}",`,
		`\t\tcontentShapeWithTools: "${r.contentShapeWithTools}",`,
		`\t\tobservedBlockTypes: [${r.observedBlockTypes.map((t) => `"${t}"`).join(", ")}],`,
		`\t\temitsReasoningContent: ${r.emitsReasoningContent},`,
		`\t\tobservedRawControlCharsInJson: ${r.observedRawControlCharsInJson},`,
		// SIO-1428: the registry figure is the CONSERVATIVE floor -- the worse of the small-prompt
		// P6 floor and the large-prompt P6L floor (llm.role-max-tokens.test.ts enforces it).
		// CodeRabbit (PR #613): a P6L floor of 0 means NO probed budget survived the large prompt
		// -- publishing the P6 floor then would mark an unsafe budget as safe, so the snippet
		// deliberately emits a non-compiling line that forces a human to raise budgets and re-run.
		r.largeLongFormMinTokens > 0
			? `\t\tlongFormMinTokens: ${Math.max(r.longFormMinTokens, r.largeLongFormMinTokens)},`
			: "\t\t// longFormMinTokens: UNSAFE -- no probed budget survived the P6L large prompt; raise role budgets and re-run before registering.",
		`\t\tobservedLatencyMs: { p50: ${r.latencyMs.p50}, max: ${r.latencyMs.max} },`,
		`\t\tverifiedAt: "${verifiedAt}",`,
		`\t\tverifiedRegion: "${REGION}",`,
		`\t\tprobeReport: "docs/reference/model-probes/${r.modelName}.md",`,
		`\t},`,
	].join("\n");
}

function writeReport(r: ProbeResult, verifiedAt: string, gitSha: string, langchainAwsVersion: string): string {
	const rel = `docs/reference/model-probes/${r.modelName}.md`;
	const path = join(getWorkspaceRoot(), rel);
	mkdirSync(dirname(path), { recursive: true });
	const lines = [
		`# Model conformance probe: ${r.modelName}`,
		"",
		"Generated by `bun run model:probe` (SIO-1224). Every capability declared for this model in",
		"`packages/gitagent-bridge/src/model-registry.ts` must be backed by a run of this probe.",
		"",
		`- **Bedrock id:** \`${r.bedrockId}\``,
		`- **Region:** ${REGION}`,
		`- **Probed at:** ${verifiedAt}`,
		`- **Repo SHA:** \`${gitSha}\``,
		`- **@langchain/aws:** ${langchainAwsVersion}`,
		`- **Samples (stochastic probes):** ${samples}`,
		"",
		"## Results",
		"",
		"| Probe | Result | Detail | Guards against |",
		"|---|---|---|---|",
		`| P1 temperature | ${r.acceptsTemperature ? "accepted" : "**rejected**"} | ${
			// Bedrock's rejection text itself contains backticks; strip them or they break the cell.
			r.temperatureRejection ? `\`${r.temperatureRejection.replace(/`/g, "")}\`` : "-"
		} | SIO-1214 |`,
		`| P2 content shape, no tools | \`${r.contentShapeWithoutTools}\` | - | SIO-1217 |`,
		`| P3 content shape, tools bound | \`${r.contentShapeWithTools}\` | blocks: ${r.observedBlockTypes
			.map((t) => `\`${t}\``)
			.join(", ")}; extractTextFromContent safe: ${r.extractionSafe} | SIO-1217 |`,
		`| P3b streaming multi-block chunks | ${r.streamMultiBlockChunks} | extractStreamDeltaText safe: ${r.streamExtractionSafe} | SIO-1218 |`,
		`| P4 reasoningContent | ${r.emitsReasoningContent ? "**present**" : "absent"} | ${r.reasoningHits} prompt shapes | SIO-1216 |`,
		`| P5 raw control chars in JSON | ${r.observedRawControlCharsInJson ? "**observed**" : "not observed"} | ${r.controlCharHitRate} | SIO-1219 |`,
		`| P6 long-form truncation floor | ${r.longFormMinTokens} tokens | ${
			r.truncatedLongFormRoles.length > 0
				? `**truncates:** ${r.truncatedLongFormRoles.join(", ")}`
				: "no long-form role truncates"
		} | SIO-649 verbosity |`,
		`| P6L LARGE-prompt long-form floor | ${
			r.largeLongFormMinTokens > 0 ? `${r.largeLongFormMinTokens} tokens` : "**no probed budget is clean**"
		} | ~${r.largeLongFormInputTokens} input tokens, ${samples} samples/budget, floor requires ALL samples end_turn | SIO-1375/SIO-1428 reasoning-vs-answer budget competition |`,
		`| P7 latency | p50 ${r.latencyMs.p50}ms / max ${r.latencyMs.max}ms | across ${latencies.length} calls | SIO-1220 budget |`,
		"",
		"## stopReason by configured maxTokens",
		"",
		"Budgets are derived from `ROLE_OVERRIDES` in `packages/agent/src/llm.ts`, so this table cannot",
		"drift from production configuration.",
		"",
		"| maxTokens | prompt | stopReason | output tokens | roles |",
		"|---|---|---|---|---|",
		...r.stopReasons.map(
			(s) =>
				`| ${s.maxTokens} | ${s.prompt} | ${s.stopReason === "max_tokens" && s.prompt === "long-form" ? `**${s.stopReason}**` : s.stopReason} | ${s.outputTokens} | ${s.roles.join(", ")} |`,
		),
		"",
		"## P6L: stopReason on the LARGE prompt (SIO-1428)",
		"",
		`Same long-form budgets, but against a ~${r.largeLongFormInputTokens}-input-token synthetic prompt that puts`,
		"reasoning and answer text in competition for one output budget -- the regime where the small",
		"P6 prompt cannot truncate but real 30-49K-token aggregator calls did (SIO-1375). The floor",
		`requires ALL ${samples} samples per budget to stop with end_turn.`,
		"",
		"| maxTokens | sample | stopReason | output tokens | input tokens | roles |",
		"|---|---|---|---|---|---|",
		...r.largeLongFormRows.map(
			(s) =>
				`| ${s.maxTokens} | ${s.sample} | ${s.stopReason === "max_tokens" ? `**${s.stopReason}**` : s.stopReason} | ${s.outputTokens} | ${s.inputTokens} | ${s.roles.join(", ")} |`,
		),
		"",
		"## Registry entry",
		"",
		"```ts",
		registryLiteral(r, verifiedAt),
		"```",
		"",
	];
	writeFileSync(path, lines.join("\n"));
	return rel;
}

// ---------------------------------------------------------------- main

const models = [target];
if (agentName) {
	// The elastic-iac chain is primary Opus 4.8 -> fallback Sonnet 5: BOTH new-generation, so the
	// fallback preserves every capability assumption that broke. Probing it is the point of --agent.
	const manifest = getAgentByName(agentName).manifest.model;
	for (const name of manifest?.fallback ?? []) {
		if (models.includes(name)) continue;
		try {
			resolveBedrockConfig({ preferred: name });
		} catch {
			console.warn(`  (skipping unmapped fallback "${name}")`);
			continue;
		}
		models.push(name);
	}
}

console.log("WARNING: this makes real Bedrock inference calls against the region in your .env.");
console.log(`Models to probe: ${models.join(", ")}`);
console.log("Estimated cost: $0.50-2.00 per model. Time: ~3-5min per model.");
if (!flag("yes")) {
	console.log("Continue in 5s or Ctrl-C.");
	await new Promise((r) => setTimeout(r, 5000));
}

const gitSha = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]).stdout.toString().trim() || "unknown";
const langchainAwsVersion = (() => {
	try {
		const p = join(getWorkspaceRoot(), "packages/agent/node_modules/@langchain/aws/package.json");
		if (!existsSync(p)) return "unknown";
		return JSON.parse(readFileSync(p, "utf-8")).version as string;
	} catch {
		return "unknown";
	}
})();
// Date.now() is fine here: this is an operator-run script, not a resumable workflow.
const verifiedAt = new Date().toISOString().slice(0, 10);

const results: ProbeResult[] = [];
for (const model of models) {
	latencies.length = 0;
	results.push(await probeOne(model));
}

let failed = false;
for (const r of results) {
	if (!r.extractionSafe) {
		console.error(`\nFAIL ${r.modelName}: extractTextFromContent produced "[object Object]".`);
		failed = true;
	}
	// ADVISORY, not a hard failure: P6 drives every budget with the SAME incident-report
	// prompt, which over-states the need for a role like iacPlanner (its output is an intent
	// JSON, not a report). Truncation here means "review this budget", and SIO-1223's offline
	// llm.role-max-tokens test is what actually enforces the floor against LONG_FORM_ROLES.
	if (r.truncatedLongFormRoles.length > 0) {
		console.warn(
			`\nADVISORY ${r.modelName}: these roles' budgets are below the long-form floor (${r.longFormMinTokens}): ` +
				`${r.truncatedLongFormRoles.join(", ")}. Judge per role whether its real output can be that long.`,
		);
	}
	if (!r.streamExtractionSafe) {
		console.error(`\nFAIL ${r.modelName}: extractStreamDeltaText produced "[object Object]" on the stream path.`);
		failed = true;
	}
	if (wantReport) {
		const rel = writeReport(r, verifiedAt, gitSha, langchainAwsVersion);
		console.log(`\nReport written: ${rel}`);
	}
}

if (flag("discover") || !flag("verify")) {
	console.log("\n// Paste into MODEL_REGISTRY (packages/gitagent-bridge/src/model-registry.ts):");
	for (const r of results) console.log(registryLiteral(r, verifiedAt));
}

process.exit(failed ? 1 : 0);
