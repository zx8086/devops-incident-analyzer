/* src/tools/getSchemaForCollection.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { isNoIndexError } from "../lib/classifyCouchbaseError";
import { resolveBucket } from "../lib/resolveBucket";
import { logger } from "../utils/logger";

interface SchemaParams {
	scope_name: string;
	collection_name: string;
	bucket_name?: string;
}

interface SchemaResponse {
	[x: string]: unknown;
	content: Array<{
		type: "text";
		text: string;
	}>;
}

interface Document {
	[key: string]: unknown;
}

// Exported for unit testing (SIO-1168).
export const formatSchema = (doc: Document): string => {
	let formattedText = "📋 Collection Schema:\n\n";

	const formatField = (key: string, value: unknown, indent: number = 0): string => {
		const padding = "  ".repeat(indent);
		const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

		// Backtick-wrap so a reserved-word field (e.g. `option`) is never copied
		// unescaped from schema output straight into a N1QL query.
		let fieldText = `${padding}\`${key}\`: ${type}`;

		if (typeof value === "object" && value !== null) {
			if (Array.isArray(value)) {
				if (value.length > 0) {
					fieldText += `\n${padding}  Example: ${JSON.stringify(value)}`;
				}
			} else if (Object.keys(value as object).length > 0) {
				fieldText +=
					"\n" +
					Object.entries(value as object)
						.map(([k, v]) => formatField(k, v, indent + 1))
						.join("\n");
			}
		} else if (value !== null) {
			fieldText += ` (Example: ${JSON.stringify(value)})`;
		}

		return fieldText;
	};

	formattedText += Object.entries(doc)
		.map(([key, value]) => formatField(key, value))
		.join("\n");

	return formattedText;
};

// SIO-1107: render INFER output (an array of schema "flavors", each with #docs
// and a properties map). Returns null on shape drift so the caller falls back
// to single-document sampling instead of asserting a wrong schema.
export const formatInferSchema = (rows: unknown): string | null => {
	if (!Array.isArray(rows) || rows.length === 0) return null;
	const flavors = Array.isArray(rows[0]) ? rows[0] : rows;
	if (!Array.isArray(flavors) || flavors.length === 0) return null;

	const renderType = (type: unknown): string => {
		if (typeof type === "string") return type;
		if (Array.isArray(type)) return type.filter((t) => typeof t === "string").join(" | ") || "unknown";
		return "unknown";
	};

	let text = "Collection Schema (INFER, sampled):\n";
	let renderedAny = false;
	flavors.forEach((flavor, i) => {
		if (flavor === null || typeof flavor !== "object") return;
		const record = flavor as Record<string, unknown>;
		const properties = record.properties;
		if (properties === null || typeof properties !== "object") return;
		renderedAny = true;

		const docs = typeof record["#docs"] === "number" ? ` (~${record["#docs"]} docs sampled)` : "";
		const flavorName = typeof record.Flavor === "string" && record.Flavor.length > 0 ? ` [${record.Flavor}]` : "";
		text += `\nFlavor ${i + 1}${flavorName}${docs}:\n`;

		for (const [field, spec] of Object.entries(properties as Record<string, unknown>)) {
			// Backtick-wrap so a reserved-word field (e.g. `option`) is never copied
			// unescaped from schema output straight into a N1QL query.
			if (spec === null || typeof spec !== "object") {
				text += `  \`${field}\`: unknown\n`;
				continue;
			}
			const specRecord = spec as Record<string, unknown>;
			const samples = Array.isArray(specRecord.samples) ? specRecord.samples.slice(0, 2) : [];
			const sampleText = samples.length > 0 ? ` (samples: ${JSON.stringify(samples)})` : "";
			text += `  \`${field}\`: ${renderType(specRecord.type)}${sampleText}\n`;
		}
	});
	return renderedAny ? text : null;
};

const getSchemaHandler = async (params: SchemaParams, bucket: Bucket): Promise<SchemaResponse> => {
	const { scope_name, collection_name, bucket_name } = params;
	logger.info(
		`getSchemaHandler called with scope_name=${scope_name}, collection_name=${collection_name}, bucket_name=${bucket_name ?? "(default)"}`,
	);

	const resolved = resolveBucket(bucket, bucket_name);
	const collectionMgr = resolved.collections();
	const scopes = await collectionMgr.getAllScopes();
	const foundScope = scopes.find((s) => s.name === scope_name);
	if (!foundScope) {
		throw new Error(`Scope "${scope_name}" does not exist`);
	}
	const foundCollection = foundScope.collections.find((c) => c.name === collection_name);
	if (!foundCollection) {
		throw new Error(`Collection "${collection_name}" does not exist in scope "${scope_name}"`);
	}

	// SIO-1107: INFER first -- it samples via KV (no index required) and captures
	// multiple document flavors. The collection name splice is guarded by the
	// existence allowlist above (must match a real collection), not the identifier
	// regex, so hyphenated collection names keep working.
	try {
		const inferResult = await resolved
			.scope(scope_name)
			.query(`INFER \`${collection_name}\` WITH {"sample_size": 100, "num_sample_values": 2}`);
		const inferRows = await inferResult.rows;
		const inferText = formatInferSchema(inferRows);
		if (inferText !== null) {
			return {
				content: [
					{
						type: "text" as const,
						text: inferText,
					},
				],
			};
		}
		logger.debug({ collection: collection_name }, "INFER returned an unexpected shape; falling back to sampling");
	} catch (inferErr: unknown) {
		logger.debug(
			{ error: inferErr instanceof Error ? inferErr.message : String(inferErr), collection: collection_name },
			"INFER unavailable; falling back to single-document sampling",
		);
	}

	try {
		const result = await resolved.scope(scope_name).query(`SELECT * FROM \`${collection_name}\` LIMIT 1`);
		const rows = await result.rows;

		if (rows.length === 0) {
			return {
				content: [
					{
						type: "text" as const,
						text: "❌ No documents found in collection to infer schema",
					},
				],
			};
		}

		return {
			content: [
				{
					type: "text" as const,
					text: formatSchema(rows[0] as Document),
				},
			],
		};
	} catch (err: unknown) {
		// SIO-1087: classify on the SDK error class / N1QL code, not err.message.includes("index").
		if (isNoIndexError(err)) {
			return {
				content: [
					{
						type: "text" as const,
						text: "❌ Database error: index failure. Please create a primary index on this collection to enable schema inference. Example:\n\nCREATE PRIMARY INDEX ON `bucket`.`scope`.`collection`;",
					},
				],
			};
		}
		throw err;
	}
};

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"capella_get_schema_for_collection",
		"Get the schema for a collection via INFER (samples many documents, no index required), falling back to single-document sampling",
		{
			scope_name: z.string().describe("Name of the scope"),
			collection_name: z.string().describe("Name of the collection"),
			bucket_name: z.string().optional().describe("Optional bucket name (defaults to the configured bucket)"),
		},
		async (params: SchemaParams) => {
			return getSchemaHandler(params, bucket);
		},
	);
};
