// packages/agent/src/correlation/extractors/couchbase.ts
import type { CouchbaseFindings, CouchbaseSlowQuery, ToolOutput } from "@devops-agent/shared";
import { CouchbaseSlowQuerySchema } from "@devops-agent/shared";

export function extractCouchbaseFindings(outputs: ToolOutput[]): CouchbaseFindings {
	const slowQueries: CouchbaseSlowQuery[] = [];

	for (const o of outputs) {
		if (o.toolName !== "capella_get_longest_running_queries") continue;
		if (!Array.isArray(o.rawJson)) continue;
		for (const q of o.rawJson) {
			const parsed = CouchbaseSlowQuerySchema.safeParse(q);
			if (parsed.success) slowQueries.push(parsed.data);
		}
	}

	return slowQueries.length > 0 ? { slowQueries } : {};
}
