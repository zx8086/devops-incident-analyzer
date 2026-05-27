// agent/src/aws-tool-estate-wrapper.ts
// SIO-828: AWS tools require an `estate` arg at the MCP boundary, but the
// supervisor pins estate per fan-out branch -- the LLM should not choose it.
// This wrapper hides `estate` from the schema shown to the LLM and re-injects
// it at .invoke() time from AsyncLocalStorage (set by withAwsEstate).

import { getLogger } from "@devops-agent/observability";
import { type StructuredToolInterface, tool as createTool } from "@langchain/core/tools";
import { z } from "zod";
import { currentAwsEstate } from "./mcp-bridge.ts";

const logger = getLogger("aws-tool-estate-wrapper");

function stripEstateFromShape(schema: z.ZodTypeAny): z.ZodObject<z.ZodRawShape> {
	// MCP tools always come back as objects at the top level. If it's not, fall
	// back to a passthrough.
	if (!(schema instanceof z.ZodObject)) {
		logger.warn({ schemaType: schema?.constructor?.name }, "AWS tool schema is not ZodObject, skipping estate strip");
		return z.object({}).passthrough();
	}
	const shape = { ...(schema.shape as z.ZodRawShape) };
	delete shape.estate;
	return z.object(shape);
}

export function wrapAwsToolsWithEstate(awsTools: StructuredToolInterface[]): StructuredToolInterface[] {
	return awsTools.map((original) => {
		const strippedSchema = stripEstateFromShape(original.schema as z.ZodTypeAny);

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
				schema: strippedSchema,
			},
		) as unknown as StructuredToolInterface;
	});
}
