// packages/agent/src/aws-tool-estate-wrapper.ts

import { tool as createTool, type StructuredToolInterface } from "@langchain/core/tools";
import { currentAwsEstate } from "./mcp-bridge.ts";
import { stripToolSchemaField } from "./strip-tool-schema-field.ts";

// SIO-828: AWS routes by tool *args*, so we strip `estate` from each tool schema
// (hide it from the LLM) and inject it from ALS at call time. See SIO-832 for why
// the schema strip must duck-type JSON Schema as well as Zod.
export function wrapAwsToolsWithEstate(awsTools: StructuredToolInterface[]): StructuredToolInterface[] {
	return awsTools.map((original) => {
		const strippedSchema = stripToolSchemaField(original.schema, "estate");

		return createTool(
			async (args: unknown) => {
				const estate = currentAwsEstate();
				if (!estate) {
					// The fan-out wrapper in queryDataSource is the only legitimate
					// caller path; missing context is a programming error worth surfacing.
					throw new Error(
						`AWS tool "${original.name}" invoked outside withAwsEstate scope. ` +
							"This indicates a bug in the AWS sub-agent fan-out.",
					);
				}
				const withEstate = { ...(args as Record<string, unknown>), estate };
				return original.invoke(withEstate);
			},
			{
				name: original.name,
				description: original.description ?? `${original.name} tool`,
				// biome-ignore lint/suspicious/noExplicitAny: SIO-832 - createTool's union of Zod/JsonSchema7Type is too tight to satisfy with a runtime-branched schema
				schema: strippedSchema as any,
				// SIO-853: surface the exact schema-mismatch field to the LLM + logs instead of
				// the bare "did not match expected schema". Cheap permanent diagnostic so a future
				// estate/schema drift names the offending field rather than failing opaquely.
				// The AWS and elastic wrappers are the agent's only createTool calls; every other
				// datasource returns the raw MultiServerMCPClient tools (mcp-bridge.ts
				// getToolsForDataSource), constructed inside @langchain/mcp-adapters where we can't
				// pass this option. Not an inconsistency to "fix" by re-creating every datasource.
				verboseParsingErrors: true,
			},
		) as unknown as StructuredToolInterface;
	});
}
