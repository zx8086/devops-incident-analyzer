// src/tools/estate-schema.ts
import { type ZodRawShape, z } from "zod";
import type { AwsConfig } from "../config/schemas.ts";

// Build a Zod enum from the loaded estate config. Used at tool-registration
// time so the LLM sees the actual valid estate IDs in its schema view.
export function estateEnum(config: AwsConfig) {
	const ids = Object.keys(config.estates);
	if (ids.length === 0) {
		throw new Error("No estates configured");
	}
	return z
		.enum(ids as [string, ...string[]])
		.describe(
			`AWS estate to query. One of: ${ids.join(", ")}. ` +
				"The supervisor injects this from awsTargetEstates; the sub-agent LLM does not choose.",
		);
}

// Merge `{ estate: <enum> }` into an existing tool schema's raw shape. The
// resulting shape is what register*Tools passes to server.tool(name, desc, shape, fn).
// Tool functions read params.estate (typed as string by the inferred shape).
export function withEstate(config: AwsConfig, shape: ZodRawShape): ZodRawShape {
	return {
		estate: estateEnum(config),
		...shape,
	};
}

// Helper for tool *Params types: every tool's params now carries `estate: string`.
// Use Omit to strip any sentinel index-signature from an empty z.object({}) so the
// intersection with `{ estate: string }` is satisfiable.
export type WithEstate<T> = Omit<T, "estate"> & { estate: string };
