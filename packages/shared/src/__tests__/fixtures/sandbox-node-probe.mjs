// shared/src/__tests__/fixtures/sandbox-node-probe.mjs
// Executed by sandbox-exec.test.ts under a real `node` (the web app's dev host). Imports
// the TypeScript engine directly: Node >= 22.18 strips erasable types natively.
import { runInSandbox } from "../../sandbox-exec.ts";

let maxLagMs = 0;
let last = performance.now();
const lagProbe = setInterval(() => {
	const now = performance.now();
	maxLagMs = Math.max(maxLagMs, now - last - 20);
	last = now;
}, 20);

const viaWorker = await runInSandbox("return 1 + 1;", []);
const spin = await runInSandbox("while (true) {}", []);
clearInterval(lagProbe);
const inThread = await runInSandbox("return 1 + 1;", [], { forceInThread: true });
const recursion = await runInSandbox("const f = () => f(); f();", [], { forceInThread: true });

console.log(
	JSON.stringify({
		runtime: typeof Bun === "undefined" ? "node" : "bun",
		workerMode: viaWorker.mode,
		workerAnswer: viaWorker.stdout,
		inThreadAnswer: inThread.stdout,
		recursion: recursion.hostFailure
			? "HOST FAILURE"
			: recursion.error?.includes("stack overflow")
				? "clean"
				: String(recursion.error),
		spinInterrupted: spin.interrupted === true,
		maxLagMs: Math.round(maxLagMs),
	}),
);
process.exit(0);
