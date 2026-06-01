// agent/src/aws-estate-router.ts
// SIO-828: classifies the user prompt into an estate subset for the AWS fan-out.
// Ambiguous prompts fan out to all configured estates (option B from design
// brainstorming). Skipped when AWS isn't in the supervisor's target set.

import { getLogger } from "@devops-agent/observability";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { createLlm } from "./llm.ts";
import { getToolsForDataSource } from "./mcp-bridge.ts";
import { extractTextFromContent } from "./message-utils.ts";
import type { AgentStateType } from "./state.ts";
import { normalizeToolContent } from "./sub-agent.ts";
import { withRetry } from "./tool-retry.ts";

interface RouterLogSink {
	info: (...args: unknown[]) => unknown;
	warn: (...args: unknown[]) => unknown;
}

const defaultLogger: RouterLogSink = getLogger("agent:awsEstateRouter") as unknown as RouterLogSink;
let currentLogger: RouterLogSink = defaultLogger;
const logger: RouterLogSink = {
	info: (...args) => currentLogger.info(...args),
	warn: (...args) => currentLogger.warn(...args),
};

// SIO-854: test seam so the drift WARN can be asserted. Pass null to reset.
export function _setAwsEstateRouterLoggerForTesting(sink: RouterLogSink | null): void {
	currentLogger = sink ?? defaultLogger;
}

// Read AWS_ESTATES once at module load. The agent process and the AWS MCP runtime
// share the same .env file in local dev; in AgentCore deployment the agent gets
// AWS_ESTATES via its own env injection (see deploy.sh, Section 5 of design).
//
// SIO-854: the agent's AWS_ESTATES is reconciled against the server's actual estate
// list (aws_list_estates) on the first AWS-in-scope dispatch (reconcileEstatesWithServer
// below). Divergence is surfaced as a single WARN and server-unknown estates are dropped
// from `available`, so drift no longer first manifests as a per-query runtime "Unknown
// estate" error (the clearer-but-still-late SIO-853 failure mode).
let cachedEstateIds: string[] | undefined;

export function _resetEstateCacheForTests(): void {
	cachedEstateIds = undefined;
}

// SIO-854: cached result of the one-shot server reconciliation. `undefined` = not yet
// run; once set it holds the server's estate-id list (or null when the server list
// could not be fetched, in which case we fall back to the agent's configured estates).
let cachedServerEstateIds: string[] | null | undefined;

export function _resetEstateReconcileForTests(): void {
	cachedServerEstateIds = undefined;
}

const ListEstatesResponseSchema = z.object({
	estates: z.array(z.object({ id: z.string() })),
});

// Call aws_list_estates once and reconcile against the agent's configured estates.
// WARNs on divergence (estates present on only one side) and returns `configured`
// filtered to the server's set. Non-fatal: if the tool is absent or errors, the
// agent's configured estates are returned unchanged.
async function reconcileEstatesWithServer(configured: string[]): Promise<string[]> {
	if (cachedServerEstateIds === undefined) {
		cachedServerEstateIds = await fetchServerEstateIds();
		if (cachedServerEstateIds !== null) {
			const serverSet = new Set(cachedServerEstateIds);
			const agentSet = new Set(configured);
			const onlyInAgent = configured.filter((id) => !serverSet.has(id));
			const onlyInServer = cachedServerEstateIds.filter((id) => !agentSet.has(id));
			if (onlyInAgent.length > 0 || onlyInServer.length > 0) {
				logger.warn(
					{ onlyInAgent, onlyInServer, agentEstates: configured, serverEstates: cachedServerEstateIds },
					"AWS estate config drift between agent and server",
				);
			}
		}
	}
	if (cachedServerEstateIds === null) return configured;
	const serverSet = new Set(cachedServerEstateIds);
	return configured.filter((id) => serverSet.has(id));
}

async function fetchServerEstateIds(): Promise<string[] | null> {
	const tool = getToolsForDataSource("aws").find((t) => t.name === "aws_list_estates");
	if (!tool) {
		logger.warn("aws_list_estates tool unavailable; skipping estate drift reconciliation");
		return null;
	}
	try {
		const raw = await tool.invoke({});
		const parsed = JSON.parse(normalizeToolContent(raw));
		const validation = ListEstatesResponseSchema.safeParse(parsed);
		if (!validation.success) {
			logger.warn(
				{ error: validation.error.message },
				"aws_list_estates returned an unexpected shape; skipping drift check",
			);
			return null;
		}
		return validation.data.estates.map((e) => e.id);
	} catch (err) {
		logger.warn(
			{ error: err instanceof Error ? err.message : String(err) },
			"aws_list_estates call failed; skipping estate drift reconciliation",
		);
		return null;
	}
}

// AWS_ESTATES must be a JSON object (not an array or primitive). The runtime's
// full schema is in mcp-server-aws; here we only need the top-level shape +
// keys, so a minimal record schema is enough to reject arrays / strings / nulls
// that would otherwise pass `JSON.parse` and silently return [] or [..indices..].
const EstatesEnvSchema = z.record(z.string(), z.unknown());

function loadConfiguredEstates(): string[] {
	if (cachedEstateIds !== undefined) return cachedEstateIds;
	const raw = process.env.AWS_ESTATES;
	if (!raw) {
		cachedEstateIds = [];
		return cachedEstateIds;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		logger.warn(
			{ error: err instanceof Error ? err.message : String(err) },
			"AWS_ESTATES env is set but not valid JSON; treating as zero estates",
		);
		cachedEstateIds = [];
		return cachedEstateIds;
	}
	const validation = EstatesEnvSchema.safeParse(parsed);
	if (!validation.success) {
		logger.warn(
			{ error: validation.error.message },
			"AWS_ESTATES env did not validate as a JSON object; treating as zero estates",
		);
		cachedEstateIds = [];
		return cachedEstateIds;
	}
	cachedEstateIds = Object.keys(validation.data);
	return cachedEstateIds;
}

const ClassificationSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("explicit"), estates: z.array(z.string()).min(1) }),
	z.object({ kind: z.literal("ambiguous") }),
]);
type Classification = z.infer<typeof ClassificationSchema>;

async function classify(prompt: string, available: string[], config?: RunnableConfig): Promise<Classification> {
	const llm = createLlm("awsEstateRouter");
	const systemPrompt = `You decide which AWS estate(s) a user's incident query targets.

Available estates: ${available.join(", ")}

Return strict JSON in one of these two shapes:
- {"kind": "explicit", "estates": ["<id>", ...]}  -- when the prompt clearly names one or more estates
- {"kind": "ambiguous"}                            -- when no specific estate is mentioned

Rules:
- Be conservative: only return "ambiguous" when the prompt truly does not specify an estate.
- "production", "prod", "live" -> "prod" (if present in available estates)
- "staging", "stage", "preprod", "uat" -> "staging" (if present)
- "dev", "development", "test environment" -> "dev" (if present)
- "all environments", "all estates", "every estate" -> "ambiguous"
- The estate IDs returned MUST come from the available list. Never invent IDs.
- Respond with JSON only, no prose.`;

	const response = await withRetry(
		() =>
			llm.invoke(
				[
					{ role: "system", content: systemPrompt },
					{ role: "human", content: prompt },
				],
				config,
			),
		{ maxRetries: 2, baseDelayMs: 500, label: "awsEstateRouter:llm" },
	);

	const text = extractTextFromContent(response.content);
	const jsonMatch = text.match(/\{[\s\S]*\}/);
	if (!jsonMatch) {
		logger.warn({ rawResponse: text.slice(0, 200) }, "Router returned no JSON; defaulting to ambiguous");
		return { kind: "ambiguous" };
	}
	try {
		const parsed = ClassificationSchema.parse(JSON.parse(jsonMatch[0]));
		if (parsed.kind === "explicit") {
			// Filter to only known IDs -- the LLM is told not to invent, but trust+verify.
			const knownSet = new Set(available);
			const filtered = parsed.estates.filter((id) => knownSet.has(id));
			if (filtered.length === 0) {
				logger.warn(
					{ requested: parsed.estates, available },
					"Router returned only unknown estate IDs; falling back to ambiguous",
				);
				return { kind: "ambiguous" };
			}
			return { kind: "explicit", estates: filtered };
		}
		return parsed;
	} catch (err) {
		logger.warn(
			{ error: err instanceof Error ? err.message : String(err), rawResponse: text.slice(0, 200) },
			"Router JSON failed schema; defaulting to ambiguous",
		);
		return { kind: "ambiguous" };
	}
}

export async function awsEstateRouter(
	state: AgentStateType,
	config?: RunnableConfig,
): Promise<Partial<AgentStateType>> {
	// Skip when AWS isn't in the conversation's data-source scope.
	if (!state.targetDataSources.includes("aws") && !state.extractedEntities.dataSources.some((d) => d.id === "aws")) {
		return { awsTargetEstates: [] };
	}

	const configured = loadConfiguredEstates();
	if (configured.length === 0) {
		logger.warn("AWS in scope but no estates configured (AWS_ESTATES missing/empty)");
		return { awsTargetEstates: [] };
	}

	// SIO-854: reconcile against the server's source of truth once. Drops estates the
	// server doesn't know and WARNs on any divergence, so drift surfaces here rather
	// than as a per-query "Unknown estate" failure downstream.
	const available = await reconcileEstatesWithServer(configured);
	if (available.length === 0) {
		logger.warn({ configured }, "AWS in scope but no configured estate is known to the server; routing to none");
		return { awsTargetEstates: [] };
	}

	// SIO-836: UI selection wins over the LLM classifier. Filter to known estates so a
	// stale selection (estate removed from AWS_ESTATES) is silently dropped, not failed.
	// All-unknown selection falls through to the classifier (today's behavior).
	const uiSelected = state.uiAwsEstates.filter((id) => available.includes(id));
	if (uiSelected.length > 0) {
		logger.info({ awsTargetEstates: uiSelected, available }, "awsEstateRouter using UI selection");
		return { awsTargetEstates: uiSelected };
	}

	const lastMessage = state.messages.at(-1);
	const prompt = lastMessage ? extractTextFromContent(lastMessage.content) : "";
	if (!prompt) {
		logger.info({ targets: available }, "No prompt content; routing to all estates");
		return { awsTargetEstates: available };
	}

	const decision = await classify(prompt, available, config);
	const targets = decision.kind === "explicit" ? decision.estates : available;
	logger.info(
		{ decisionKind: decision.kind, awsTargetEstates: targets, available, promptPreview: prompt.slice(0, 120) },
		"awsEstateRouter resolved",
	);
	return { awsTargetEstates: targets };
}
