// src/tools/health/describe-events.ts
import { DescribeEventsCommand, type EventFilter } from "@aws-sdk/client-health";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getHealthClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

// SIO-1056: the SDK's DescribeEventsCommand serializes DateTimeRange.from/to via the
// Date->epoch-millis middleware, which THROWS "STRING_VALUE cannot be converted to
// milliseconds since epoch" on a raw ISO string. The previous opaque
// `z.record(z.string(), z.unknown())` filter passed strings straight through.
//
// The schema must stay JSON-Schema-representable -- the MCP SDK serializes every tool's input
// schema for tools/list, and a Zod `date` (z.coerce.date()) throws "Date cannot be represented
// in JSON Schema" there. So we accept the date bounds as string|number in the schema and coerce
// to real Date objects in the handler, just before the SDK call. Non-date filter fields stay
// permissive (passthrough) so callers can send any supported EventFilter key.
const dateBound = z.union([z.string(), z.number()]).describe("ISO 8601 string or epoch ms.");

const dateTimeRangeSchema = z
	.object({
		from: dateBound.optional().describe("Range start (ISO 8601 string or epoch ms)."),
		to: dateBound.optional().describe("Range end (ISO 8601 string or epoch ms)."),
	})
	.passthrough();

const eventFilterSchema = z
	.object({
		startTimes: z.array(dateTimeRangeSchema).optional().describe("Event begin-time ranges."),
		endTimes: z.array(dateTimeRangeSchema).optional().describe("Event end-time ranges."),
		lastUpdatedTimes: z.array(dateTimeRangeSchema).optional().describe("Event last-updated ranges."),
	})
	.passthrough();

export const describeEventsSchema = z.object({
	filter: eventFilterSchema
		.optional()
		.describe(
			"EventFilter criteria (services, regions, eventTypeCategories, eventStatusCodes, etc.). Date ranges (startTimes/endTimes/lastUpdatedTimes) accept ISO 8601 strings or epoch ms.",
		),
	maxResults: z.number().int().optional().describe("Max results per page (1-100). Alias: limit."),
	nextToken: z.string().optional().describe("Pagination token from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination aliases (-> maxResults / nextToken; SDK param wins).
	limit: z.number().int().optional().describe("Canonical page-size alias (-> maxResults)."),
	cursor: z
		.string()
		.optional()
		.describe("Canonical pagination-token alias (-> nextToken). Pass _truncated.cursor here."),
});

export type DescribeEventsParams = WithEstate<z.infer<typeof describeEventsSchema>>;

type EventFilterInput = z.infer<typeof eventFilterSchema>;
type DateTimeRangeInput = z.infer<typeof dateTimeRangeSchema>;

// SIO-1056: turn the schema-validated string|number bounds into real Date objects the SDK
// serializer accepts. Invalid dates are dropped rather than sent (an Invalid Date would re-throw
// the same serializer error we are fixing). Returns the SDK's DateTimeRange shape (Date bounds).
function coerceRange(range: DateTimeRangeInput): { from?: Date; to?: Date } {
	const { from, to, ...rest } = range;
	const out: { from?: Date; to?: Date; [k: string]: unknown } = { ...rest };
	for (const [key, value] of [
		["from", from],
		["to", to],
	] as const) {
		if (value === undefined) continue;
		const date = new Date(value);
		if (!Number.isNaN(date.getTime())) out[key] = date;
	}
	return out;
}

// Converts the JSON-Schema-safe input filter (string|number date bounds) into the SDK's
// EventFilter (Date bounds), leaving non-date keys untouched.
export function coerceFilterDates(filter: EventFilterInput | undefined): EventFilter | undefined {
	if (!filter) return undefined;
	const { startTimes, endTimes, lastUpdatedTimes, ...rest } = filter;
	const out: EventFilter = { ...rest };
	if (Array.isArray(startTimes)) out.startTimes = startTimes.map(coerceRange);
	if (Array.isArray(endTimes)) out.endTimes = endTimes.map(coerceRange);
	if (Array.isArray(lastUpdatedTimes)) out.lastUpdatedTimes = lastUpdatedTimes.map(coerceRange);
	return out;
}

export function describeEvents(config: AwsConfig) {
	return wrapListTool({
		name: "aws_health_describe_events",
		listField: "events",
		fn: async (params: DescribeEventsParams) => {
			const client = getHealthClient(config, params.estate);
			return client.send(
				new DescribeEventsCommand({
					// SIO-1056: coerce string|number date bounds to Date here (not in the schema, which
					// must stay JSON-Schema-safe for tools/list). Non-date keys pass through unchanged.
					filter: coerceFilterDates(params.filter),
					maxResults: preferSdkParam(params.maxResults, params.limit),
					nextToken: preferSdkParam(params.nextToken, params.cursor),
				}),
			);
		},
	});
}
