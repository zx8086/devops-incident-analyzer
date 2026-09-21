// agent/src/decision-recorder.ts
// SIO-1839: one fire-and-forget writer for the SIO-1858 decision-metrics table.
//
// Extracted when the second Jev seam needed it: the Atlassian rerank had this
// inline, and copying twenty lines of open-write-close-swallow per seam is how
// one of them quietly stops recording. Every later seam calls this instead.
//
// Best-effort by construction. The recorder is opened per call because the
// callers are graph nodes rather than long-lived services, DECISION_METRICS_DB_PATH
// is usually unset (then this is a no-op), and a metrics failure must never cost
// a turn.

import { getLogger } from "@devops-agent/observability";
import { createDecisionMetricsRecorder, type DecisionRecord, resolveDecisionMetricsDbPath } from "@devops-agent/shared";

const logger = getLogger("agent:decision-recorder");

export function recordDecision(entry: DecisionRecord): void {
	const dbPath = resolveDecisionMetricsDbPath();
	if (!dbPath) return;
	void createDecisionMetricsRecorder({ dbPath, logger: { warn: (m, meta) => logger.warn(meta ?? {}, m) } })
		.then((recorder) => {
			if (!recorder) return;
			recorder.record(entry);
			recorder.close();
		})
		.catch(() => {
			// createDecisionMetricsRecorder already warns on a failed open; a rejected
			// promise here must not surface as an unhandled rejection.
		});
}
