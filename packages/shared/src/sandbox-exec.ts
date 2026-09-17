// shared/src/sandbox-exec.ts
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { SandboxGuestResult, SandboxLimits } from "./sandbox-core.mjs";

// SIO-1776: ctx_execute-style execution for sub-agents. Model-authored JavaScript runs over
// tool results the run has ALREADY captured, so a fat result can be reduced to a derived
// answer instead of entering the model's context. The engine is QuickJS in WebAssembly
// (see sandbox-core.mjs for the boundary); this file decides WHERE it runs.
//
// Worker first: in-thread, a guest blocks the event loop for up to its deadline, and one
// giant native operation (`new Array(1e6).fill(...)`) never polls the interrupt handler, so
// only the memory limit ends it -- measured at 2.3-3.0 s of a stalled loop that every
// user's SSE stream shares. In a worker the main loop lag stayed at 1-2 ms throughout.
//
// The in-guest limits are kept INSIDE the worker as well, because worker.terminate() is
// not a portable kill: under Bun 1.4.2 it never returns while the worker is stuck in
// synchronous WASM (Node kills it on time). So the guest deadline and memory limit are what
// actually stop a runaway on both runtimes, and terminate() -- never awaited -- is only a
// backstop.

export interface SandboxEvidence {
	id: string;
	tool: string;
	// The captured tool result, as JSON text. Parsed inside the guest, never on the host side
	// of the boundary as an object the guest could reach.
	json: string;
}

export interface SandboxResult extends SandboxGuestResult {
	durationMs: number;
	mode: "worker" | "in-thread";
	// The engine itself failed (a host exception or a killed worker), as opposed to the guest
	// code throwing. Never retried in-thread: the guest may be what caused it.
	hostFailure?: boolean;
}

export const SANDBOX_MAX_CODE_BYTES = 16 * 1024;

export const WORKER_LIMITS: SandboxLimits = {
	memoryBytes: 64 * 1024 * 1024,
	stackBytes: 64 * 1024,
	wallMs: 2_000,
	stdoutBytes: 8 * 1024,
};

// Tighter, because here a runaway guest DOES stall the event loop until a limit trips.
export const IN_THREAD_LIMITS: SandboxLimits = {
	memoryBytes: 16 * 1024 * 1024,
	stackBytes: 64 * 1024,
	wallMs: 1_000,
	stdoutBytes: 8 * 1024,
};

// How long past the guest deadline the host waits before giving up on a worker.
const HARD_KILL_GRACE_MS = 1_500;

// A variable, not a literal inside `new URL(...)`: Vite pattern-matches the literal form as
// an asset reference, and this is a server-only file it must leave alone.
const WORKER_FILE = "./sandbox-worker.mjs";
const WORKER_PACKAGE_PATH = "@devops-agent/shared/src/sandbox-worker.mjs";

function existingFileUrl(candidate: string | URL): URL | null {
	try {
		const url = candidate instanceof URL ? candidate : new URL(candidate);
		return url.protocol === "file:" && existsSync(fileURLToPath(url)) ? url : null;
	} catch {
		return null;
	}
}

// Next to this module in dev and tests. In a bundled build (`vite build` with
// ssr.noExternal leaves the reference verbatim and does not emit the file) the package
// subpath still resolves when node_modules is present. Neither -> in-thread.
let cachedWorkerUrl: URL | null | undefined;
export function resolveSandboxWorkerUrl(): URL | null {
	if (cachedWorkerUrl !== undefined) return cachedWorkerUrl;
	let viaPackage: URL | null = null;
	try {
		viaPackage = existingFileUrl(import.meta.resolve(WORKER_PACKAGE_PATH));
	} catch {
		viaPackage = null;
	}
	cachedWorkerUrl = existingFileUrl(new URL(WORKER_FILE, import.meta.url)) ?? viaPackage;
	return cachedWorkerUrl;
}

type WorkerReply = { ok: true; result: SandboxGuestResult } | { ok: false; error: string };

function runInWorker(
	workerUrl: URL,
	input: { code: string; evidenceJson: string },
): Promise<SandboxGuestResult & { hostFailure?: boolean }> {
	return new Promise((resolve) => {
		const worker = new Worker(workerUrl, {
			workerData: { ...input, limits: WORKER_LIMITS },
			// Node only (Bun ignores it): bounds the worker's own heap, which holds the
			// evidence JSON and the WASM instance, independently of the guest's limit.
			resourceLimits: { maxOldGenerationSizeMb: 256 },
		});
		let settled = false;
		const finish = (result: SandboxGuestResult & { hostFailure?: boolean }) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			// Never awaited: see the header. A thread that will not die is still bounded by the
			// guest limits running inside it.
			void worker.terminate();
			resolve(result);
		};
		const failed = (error: string) => finish({ stdout: "", truncated: false, error, hostFailure: true });
		const timer = setTimeout(
			() => failed(`sandbox killed: no result within ${WORKER_LIMITS.wallMs + HARD_KILL_GRACE_MS} ms`),
			WORKER_LIMITS.wallMs + HARD_KILL_GRACE_MS,
		);
		worker.once("message", (reply: WorkerReply) =>
			reply.ok ? finish(reply.result) : failed(`sandbox host failure: ${reply.error}`),
		);
		worker.once("error", (error) =>
			failed(`sandbox host failure: ${error instanceof Error ? error.constructor.name : "Error"}`),
		);
	});
}

export interface RunInSandboxOptions {
	// Tests, and callers that know no worker can be loaded.
	forceInThread?: boolean;
	onFallback?: (reason: string) => void;
}

let fallbackReported = false;

// `code` is a function BODY: `return evidence.get("e1").hits.length`. Whatever it returns
// (stringified unless already a string), after anything it print()ed, is the output.
export async function runInSandbox(
	code: string,
	evidence: SandboxEvidence[],
	options: RunInSandboxOptions = {},
): Promise<SandboxResult> {
	const started = performance.now();
	const workerUrl = options.forceInThread ? null : resolveSandboxWorkerUrl();
	const mode: SandboxResult["mode"] = workerUrl ? "worker" : "in-thread";
	const done = (result: SandboxGuestResult & { hostFailure?: boolean }): SandboxResult => ({
		...result,
		durationMs: Math.round(performance.now() - started),
		mode,
	});

	if (Buffer.byteLength(code, "utf8") > SANDBOX_MAX_CODE_BYTES) {
		return done({ stdout: "", truncated: false, error: `code exceeds ${SANDBOX_MAX_CODE_BYTES} bytes` });
	}
	const evidenceJson = JSON.stringify(evidence.map(({ id, tool, json }) => ({ id, tool, json })));

	if (workerUrl) return done(await runInWorker(workerUrl, { code, evidenceJson }));

	if (!options.forceInThread && !fallbackReported) {
		fallbackReported = true;
		options.onFallback?.("sandbox worker file could not be resolved; running in-thread with tighter limits");
	}
	try {
		// Imported lazily: on the worker path the main thread never loads the 3 MB QuickJS
		// module at all. Deliberately NOT re-exported from the package barrel for the same
		// reason -- consumers deep-import this file.
		const { evalGuest } = await import("./sandbox-core.mjs");
		return done(await evalGuest({ code, evidenceJson, limits: IN_THREAD_LIMITS }));
	} catch (error) {
		// A host exception poisons only this call's module; the next call builds a new one.
		return done({
			stdout: "",
			truncated: false,
			error: `sandbox host failure: ${error instanceof Error ? error.constructor.name : "Error"}`,
			hostFailure: true,
		});
	}
}
