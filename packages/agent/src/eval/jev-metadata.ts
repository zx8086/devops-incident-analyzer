// packages/agent/src/eval/jev-metadata.ts
import { isActionSelectorEnabled } from "../action-selector.ts";
import { isAtlassianRerankEnabled } from "../atlassian-rerank.ts";
import { JEV_MODEL, resolveTypeSafeApiKey } from "../typesafe-client.ts";

// SIO-1919: Jev runs INSIDE the graph during live evals (action selector, Atlassian rerank), so
// two experiments can differ in Jev as well as in the model under test. Read through the same
// gates the seams use, never a second parser.
export function jevEvalMetadata(env: NodeJS.ProcessEnv = process.env) {
	const keyed = resolveTypeSafeApiKey(env) !== undefined;
	const jevActionSelector = keyed && isActionSelectorEnabled(env);
	const jevAtlassianRerank = keyed && isAtlassianRerankEnabled(env);
	return {
		jev: jevActionSelector || jevAtlassianRerank,
		jevModel: JEV_MODEL,
		jevActionSelector,
		jevAtlassianRerank,
	};
}
