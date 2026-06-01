// src/tools/estate-schema.ts
import { type ZodRawShape, z } from "zod";
import type { AwsConfig } from "../config/schemas.ts";

// Build the estate field from the loaded estate config. SIO-853: a plain string,
// NOT a z.enum (the function was renamed from estateEnum for that reason). The enum
// baked the estate-ID list into every tool schema, so any drift between the agent's
// AWS_ESTATES and this server's (e.g. a freshly-added estate the agent dispatches to
// but this runtime hasn't been redeployed with) made EVERY estate-scoped tool reject
// the call with an opaque "did not match expected schema" instead of one clear error.
// resolveEstate in client-factory.ts already validates the estate at call time
// (`Unknown estate "x". Known: ...`), so the enum added no safety -- only brittleness.
// This mirrors the elastic MCP's `deployment` field (a string with runtime validation,
// not an enum). The describe text still lists the current IDs for LLM/operator visibility.
export function estateField(config: AwsConfig) {
	const ids = Object.keys(config.estates);
	if (ids.length === 0) {
		throw new Error("No estates configured");
	}
	return z
		.string()
		.min(1)
		.describe(
			`AWS estate to query. One of: ${ids.join(", ")}. ` +
				"The supervisor injects this from awsTargetEstates; the sub-agent LLM does not choose.",
		);
}

// Merge the estate field (a permissive z.string from estateField, SIO-853 -- not a
// z.enum) into an existing tool's ZodRawShape. The resulting ZodRawShape is what
// register*Tools passes to server.tool(name, desc, shape, fn). Tool functions read
// params.estate as a string; resolveEstate (client-factory.ts) validates the value.
export function withEstate(config: AwsConfig, shape: ZodRawShape): ZodRawShape {
	// Spread shape first so a tool that accidentally declared `estate` cannot
	// override the enforced string field. The estate field always wins.
	return {
		...shape,
		estate: estateField(config),
	};
}

// Helper for tool *Params types: every tool's params now carries `estate: string`.
// Use Omit to strip any sentinel index-signature from an empty z.object({}) so the
// intersection with `{ estate: string }` is satisfiable.
export type WithEstate<T> = Omit<T, "estate"> & { estate: string };
