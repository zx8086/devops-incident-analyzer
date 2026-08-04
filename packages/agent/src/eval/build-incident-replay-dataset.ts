// packages/agent/src/eval/build-incident-replay-dataset.ts
//
// SIO-1371: uploads INCIDENT_REPLAY_DATASET as its own LangSmith dataset, separate from
// build-dataset.ts's synthetic "devops-incident-eval" -- kept as an independent script rather
// than parameterizing build-dataset.ts so neither dataset's upload path can regress the other.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { INCIDENT_REPLAY_DATASET } from "./incident-replay-dataset.ts";

const TARGET = "/tmp/incident-replay-eval.json";
const DATASET_NAME = "incident-replay-eval";

writeFileSync(TARGET, JSON.stringify(INCIDENT_REPLAY_DATASET, null, 2));
console.log(`Wrote ${INCIDENT_REPLAY_DATASET.length} examples to ${TARGET}`);

const result = spawnSync("langsmith", ["dataset", "upload", TARGET, "--name", DATASET_NAME], {
	stdio: "inherit",
	env: process.env,
});

if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
	console.error("`langsmith` CLI not found on PATH. Install it:");
	console.error(
		"  curl -sSL https://raw.githubusercontent.com/langchain-ai/langsmith-cli/main/scripts/install.sh | sh",
	);
	process.exit(1);
}

if (result.status !== 0) {
	console.error(`langsmith dataset upload failed (exit ${result.status})`);
	console.error(`If the dataset already exists, delete it first: langsmith dataset delete ${DATASET_NAME}`);
	process.exit(result.status ?? 1);
}
