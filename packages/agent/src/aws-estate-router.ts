// agent/src/aws-estate-router.ts
// SIO-828: classifies the user prompt into an estate subset for the AWS fan-out.
// Ambiguous prompts fan out to all configured estates (option B from design
// brainstorming). Skipped when AWS isn't in the supervisor's target set.

import { getLogger } from "@devops-agent/observability";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { createLlm } from "./llm.ts";
import { withRetry } from "./tool-retry.ts";
import { extractTextFromContent } from "./message-utils.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:awsEstateRouter");

// Read AWS_ESTATES once at module load. The agent process and the AWS MCP runtime
// share the same .env file in local dev; in AgentCore deployment the agent gets
// AWS_ESTATES via its own env injection (see deploy.sh, Section 5 of design).
let cachedEstateIds: string[] | undefined;

export function _resetEstateCacheForTests(): void {
	cachedEstateIds = undefined;
}

function loadConfiguredEstates(): string[] {
	if (cachedEstateIds !== undefined) return cachedEstateIds;
	const raw = process.env.AWS_ESTATES;
	if (!raw) {
		cachedEstateIds = [];
		return cachedEstateIds;
	}
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		cachedEstateIds = Object.keys(parsed);
	} catch (err) {
		logger.warn(
			{ error: err instanceof Error ? err.message : String(err) },
			"AWS_ESTATES env is set but not valid JSON; treating as zero estates",
		);
		cachedEstateIds = [];
	}
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

	const text = String(response.content);
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

	const available = loadConfiguredEstates();
	if (available.length === 0) {
		logger.warn("AWS in scope but no estates configured (AWS_ESTATES missing/empty)");
		return { awsTargetEstates: [] };
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
