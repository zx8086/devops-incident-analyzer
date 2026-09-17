// shared/src/sandbox-core.mjs
// SIO-1776: evaluates model-authored JavaScript inside QuickJS compiled to WebAssembly.
//
// Plain .mjs, not TypeScript, on purpose: sandbox-worker.mjs imports this file and a
// worker_threads Worker under Node (the web app's `vite dev` host) cannot load .ts.
//
// The guest has NO ambient authority. QuickJS exposes no process, require, fetch, fs, env,
// timers or module loader; the only host surface is what is injected below: `print`, and an
// `evidence` object built INSIDE the guest from a JSON string. No host object handle and no
// host callback that accepts a guest function ever crosses the boundary.
import variant from "@jitl/quickjs-singlefile-cjs-release-sync";
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline } from "quickjs-emscripten-core";

const TRUNCATION_MARKER = "\n[output truncated]";

// Built in the guest so evidence values are guest objects. JSON.parse per get(): a transform
// that mutates what it was given cannot affect a later get() in the same call.
const PRELUDE = `
const __items = JSON.parse(__evidenceJson);
delete globalThis.__evidenceJson;
globalThis.evidence = Object.freeze({
	list: () => __items.map((x) => ({ id: x.id, tool: x.tool, bytes: x.json.length })),
	get: (id) => { const x = __items.find((y) => y.id === id); return x ? JSON.parse(x.json) : undefined; },
});
`;

function capOutput(text, maxBytes) {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return { stdout: text, truncated: false };
	const budget = Math.max(0, maxBytes - Buffer.byteLength(TRUNCATION_MARKER, "utf8"));
	let cut = Buffer.from(text, "utf8").subarray(0, budget).toString("utf8");
	// Prefer a line boundary; a half line of JSON reads as a complete value to a model.
	const lastNewline = cut.lastIndexOf("\n");
	if (lastNewline > 0) cut = cut.slice(0, lastNewline);
	return { stdout: cut + TRUNCATION_MARKER, truncated: true };
}

function describeGuestError(dumped) {
	if (dumped && typeof dumped === "object") return `${dumped.name ?? "Error"}: ${dumped.message ?? ""}`.trim();
	return String(dumped);
}

// `code` is a function BODY. Returns { stdout, truncated, error?, interrupted?, outOfMemory? }.
export async function evalGuest({ code, evidenceJson, limits }) {
	// A FRESH module per call. A host-side failure during a guest run (a native stack
	// overflow thrown through the WASM, a QuickJS assertion on cleanup) poisons the module it
	// happened in; with a shared module one bad guest would break every later call. Measured
	// cost is single-digit milliseconds. The await also lands the eval on a shallow host stack.
	const QuickJS = await newQuickJSWASMModuleFromVariant(variant);
	const runtime = QuickJS.newRuntime();
	runtime.setMemoryLimit(limits.memoryBytes);
	// Must stay far below the HOST engine's native stack: past that the host overflows first
	// and QuickJS is left mid-execution. Node failed at 512 KB shallow and 128 KB from 6000
	// frames deep; 64 KB was clean at every depth on Node and Bun.
	runtime.setMaxStackSize(limits.stackBytes);
	runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + limits.wallMs));
	const ctx = runtime.newContext();
	let out = "";
	try {
		const print = ctx.newFunction("print", (...args) => {
			// Stop accumulating well past the cap: the guest must not grow HOST memory.
			if (out.length > limits.stdoutBytes * 2) return;
			out += `${args
				.map((a) => {
					const v = ctx.dump(a);
					return typeof v === "string" ? v : JSON.stringify(v);
				})
				.join(" ")}\n`;
		});
		ctx.setProp(ctx.global, "print", print);
		print.dispose();
		const json = ctx.newString(evidenceJson);
		ctx.setProp(ctx.global, "__evidenceJson", json);
		json.dispose();

		const prelude = ctx.evalCode(PRELUDE);
		if (prelude.error) {
			const message = describeGuestError(ctx.dump(prelude.error));
			if (prelude.error.alive) prelude.error.dispose();
			return { stdout: "", truncated: false, error: `evidence could not be loaded: ${message}` };
		}
		if (prelude.value.alive) prelude.value.dispose();

		const result = ctx.evalCode(`(function () {\n${code}\n})()`);
		if (result.error) {
			const message = describeGuestError(ctx.dump(result.error));
			if (result.error.alive) result.error.dispose();
			return {
				...capOutput(out, limits.stdoutBytes),
				error: message,
				interrupted: /interrupted/i.test(message),
				outOfMemory: /out of memory/i.test(message),
			};
		}
		const value = ctx.dump(result.value);
		if (result.value.alive) result.value.dispose();
		if (value !== undefined) out += typeof value === "string" ? value : JSON.stringify(value);
		return capOutput(out, limits.stdoutBytes);
	} finally {
		ctx.dispose();
		runtime.dispose();
	}
}
