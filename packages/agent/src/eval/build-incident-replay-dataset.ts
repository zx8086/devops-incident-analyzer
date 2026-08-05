// packages/agent/src/eval/build-incident-replay-dataset.ts
//
// SIO-1371: uploads INCIDENT_REPLAY_DATASET as its own LangSmith dataset, separate from
// build-dataset.ts's synthetic "devops-incident-eval" -- kept as an independent script rather
// than parameterizing build-dataset.ts so neither dataset's upload path can regress the other.
//
// SIO-1378: switched from the `langsmith` CLI to the SDK. The CLI (0.1.7) cannot carry
// per-example metadata, and its failure path forced a delete-and-reupload flow that churned the
// dataset id, orphaning prior experiments' version history. This path syncs examples IN PLACE:
// the dataset (and its id) survives, so asOf/version comparisons keep resolving.

import { Client } from "langsmith";
import type { Example } from "langsmith/schemas";
import { INCIDENT_REPLAY_DATASET } from "./incident-replay-dataset.ts";

const DATASET_NAME = "incident-replay-eval";

const client = new Client();

let datasetId: string;
try {
	const existing = await client.readDataset({ datasetName: DATASET_NAME });
	datasetId = existing.id;
	console.log(`Dataset ${DATASET_NAME} exists (${datasetId}) -- syncing examples in place, id preserved.`);
} catch {
	const created = await client.createDataset(DATASET_NAME, {
		description: "32 real incident replays from Jira epic DEVOPS-1354 (SIO-1371/SIO-1378)",
	});
	datasetId = created.id;
	console.log(`Created dataset ${DATASET_NAME} (${datasetId}).`);
}

// Replace-all sync from the TS source of truth. Deleting EXAMPLES (never the dataset)
// preserves the dataset id and its version history.
const stale: Example[] = [];
for await (const example of client.listExamples({ datasetId })) stale.push(example);
for (const example of stale) await client.deleteExample(example.id);
if (stale.length > 0) console.log(`Deleted ${stale.length} existing examples.`);

const created = await client.createExamples(
	INCIDENT_REPLAY_DATASET.map((entry) => ({
		dataset_id: datasetId,
		inputs: entry.inputs,
		outputs: entry.outputs,
		metadata: entry.metadata,
	})),
);
console.log(`Uploaded ${created.length} examples to ${DATASET_NAME} (${datasetId}).`);
