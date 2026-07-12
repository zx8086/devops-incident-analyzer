// src/lib/validateRangeQuery.ts
// SIO-1087 (Fix B): pre-emptively catch the specific malformed `range` clause a small model emits
// -- a range object with MORE THAN ONE field, or bound operators (gte/lte/gt/lt/format) hoisted as
// siblings of the field object. Elasticsearch rejects these with
//   "[range] malformed query, expected [END_OBJECT] but found [FIELD_NAME]"
// AFTER the query is sent, burning a retry. Detecting it here lets us return a corrective message
// with the known-good single-field shape so the model fixes the query instead of looping.

// Bound operators that belong INSIDE a single field object, e.g. range.@timestamp.{gte,lte}.
const RANGE_BOUND_OPS = new Set(["gte", "lte", "gt", "lt", "format", "time_zone", "boost", "relation"]);

// The known-good shape, quoted verbatim in the corrective error so the model can copy it.
export const CORRECT_RANGE_SHAPE = '{ "range": { "@timestamp": { "gte": "<start>", "lte": "<end>" } } }';

// Returns a corrective error message if the query contains a malformed range clause, else null.
// Recursive: range can appear nested inside bool.must/filter/should arrays.
export function validateRangeQuery(node: unknown): string | null {
	if (node == null || typeof node !== "object") return null;

	if (Array.isArray(node)) {
		for (const child of node) {
			const err = validateRangeQuery(child);
			if (err) return err;
		}
		return null;
	}

	const obj = node as Record<string, unknown>;
	for (const [key, value] of Object.entries(obj)) {
		if (key === "range" && value != null && typeof value === "object" && !Array.isArray(value)) {
			const rangeObj = value as Record<string, unknown>;
			const keys = Object.keys(rangeObj);

			// A valid range clause names exactly ONE field, whose value is the bounds object.
			const boundOpsAtTop = keys.filter((k) => RANGE_BOUND_OPS.has(k));
			if (boundOpsAtTop.length > 0) {
				return (
					`Malformed 'range' clause: bound operators (${boundOpsAtTop.join(", ")}) are directly under 'range' ` +
					`instead of under a field name. A range clause names exactly one field; put the bounds inside it. ` +
					`Correct shape: ${CORRECT_RANGE_SHAPE}`
				);
			}
			const fieldKeys = keys.filter((k) => !RANGE_BOUND_OPS.has(k));
			if (fieldKeys.length > 1) {
				return (
					`Malformed 'range' clause: it references ${fieldKeys.length} fields (${fieldKeys.join(", ")}) in a ` +
					`single range object. A range clause takes exactly ONE field. To bound two fields, use two separate ` +
					`range clauses inside a bool.filter array. Correct single-field shape: ${CORRECT_RANGE_SHAPE}`
				);
			}
		}
		// Recurse into nested structures (bool.filter, bool.must, etc.).
		const err = validateRangeQuery(value);
		if (err) return err;
	}
	return null;
}
