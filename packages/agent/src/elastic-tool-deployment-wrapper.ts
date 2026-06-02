// packages/agent/src/elastic-tool-deployment-wrapper.ts

import { getLogger } from "@devops-agent/observability";
import { tool as createTool, type StructuredToolInterface } from "@langchain/core/tools";
import { stripToolSchemaField } from "./strip-tool-schema-field.ts";

const logger = getLogger("elastic-tool-deployment-wrapper");

// SIO-649/SIO-675: the elastic MCP server augments every cluster tool with an optional,
// model-visible `deployment` arg whose description enumerates all registered deployment
// IDs, and an explicit value overrides the x-elastic-deployment header ("explicit wins").
// The per-deployment fan-out (queryDataSource -> withElasticDeployment) sets that header
// to scope each branch, so leaving `deployment` visible lets the LLM broaden past the
// user's selection -- e.g. answering "how are my clusters doing?" against all deployments
// even when only one was selected in the UI. Mirror the SIO-828 AWS estate fix: strip
// `deployment` so the header is the sole authority. Routing stays header-based
// (injectElasticHeaders), so -- unlike AWS -- we inject nothing and tolerate the no-header
// fallback (the non-fan-out path runs without a scope and uses ELASTIC_DEFAULT_DEPLOYMENT).
export function wrapElasticToolsWithDeployment(elasticTools: StructuredToolInterface[]): StructuredToolInterface[] {
	return elasticTools.map((original) => {
		const strippedSchema = stripToolSchemaField(original.schema, "deployment");

		return createTool(
			async (args: unknown) => {
				// Defensive: the field is gone from the schema, so the LLM can't set it, but if a
				// stale arg ever slips through, drop it before forwarding so it can't shadow the
				// fan-out header at the MCP server (where explicit `deployment` wins over the header).
				if (args && typeof args === "object" && "deployment" in (args as Record<string, unknown>)) {
					const { deployment: _dropped, ...rest } = args as Record<string, unknown>;
					logger.debug(
						{ tool: original.name },
						"Dropped model-supplied 'deployment' arg; fan-out header scope is authoritative",
					);
					return original.invoke(rest);
				}
				return original.invoke(args);
			},
			{
				name: original.name,
				description: original.description ?? `${original.name} tool`,
				// biome-ignore lint/suspicious/noExplicitAny: SIO-832 - createTool's union of Zod/JsonSchema7Type is too tight to satisfy with a runtime-branched schema
				schema: strippedSchema as any,
				verboseParsingErrors: true,
			},
		) as unknown as StructuredToolInterface;
	});
}
