// shared/src/sandbox-worker.mjs
// SIO-1776: runs one guest evaluation off the main thread, so a slow or hostile transform
// cannot stall the web app's event loop (every user's SSE stream shares it). Plain .mjs so
// Node can load it as a Worker. One message out, then the parent terminates this thread.
import { parentPort, workerData } from "node:worker_threads";
import { evalGuest } from "./sandbox-core.mjs";

try {
	parentPort?.postMessage({ ok: true, result: await evalGuest(workerData) });
} catch (error) {
	parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.constructor.name : "Error" });
}
