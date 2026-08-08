// packages/agent/src/aws-tool-estate-wrapper.ts

import { tool as createTool, type StructuredToolInterface } from "@langchain/core/tools";
import { currentAwsEstate } from "./mcp-bridge.ts";
import { stripToolSchemaField } from "./strip-tool-schema-field.ts";

// SIO-1114: introspection tools that operate ON the estate registry itself take no
// estate and MUST be callable outside withAwsEstate. SIO-854 reconciliation calls
// aws_list_estates before any per-estate fan-out (it is what discovers the estates),
// and the design forbids a default estate to wrap it in. Exempt tools are returned
// untouched: no schema strip (they have no `estate` field) and no scope guard.
const ESTATE_INDEPENDENT_AWS_TOOLS = new Set(["aws_list_estates"]);

// SIO-828: AWS routes by tool *args*, so we strip `estate` from each tool schema
// (hide it from the LLM) and inject it from ALS at call time. See SIO-832 for why
// the schema strip must duck-type JSON Schema as well as Zod.
export function wrapAwsToolsWithEstate(awsTools: StructuredToolInterface[]): StructuredToolInterface[] {
	return awsTools.map((original) => {
		if (ESTATE_INDEPENDENT_AWS_TOOLS.has(original.name)) return original; // SIO-1114
		const strippedSchema = stripToolSchemaField(original.schema, "estate");

		return createTool(
			async (args: unknown) => {
				const estate = currentAwsEstate();
				if (!estate) {
					// SIO-1448: state the observable fact only -- currentAwsEstate() found no
					// scope -- rather than naming a specific caller. This error reaches the
					// LLM's own ReAct loop as a tool result, not just a human debugger, so an
					// incorrect diagnosis here (the prior wording named "the AWS sub-agent
					// fan-out" even when a different, non-fan-out caller was responsible)
					// misdirects both. Every AWS tool call must run inside
					// withAwsEstate(estate, ...); check whichever caller dispatched this
					// invocation (queryDataSource's fan-out is the primary one, but not the
					// only one -- see correlationFetch).
					throw new Error(
						`AWS tool "${original.name}" invoked with no estate scope established ` +
							"(currentAwsEstate() returned undefined). Every AWS tool call must run " +
							"inside withAwsEstate(estate, ...) -- check the caller that dispatched " +
							"this sub-agent invocation.",
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
