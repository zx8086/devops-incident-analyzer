// tests/fleet-tunnel.test.ts
// SIO-1792: the hub tunnel must be bounded, say why it failed, and leave nothing behind.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { HubHttpError, listAgents } from "../scripts/fleet/hub.ts";
import { type TunnelDeps, type TunnelProcess, withTunnel } from "../scripts/fleet/tunnel.ts";

const opts = {
	label: "hub-x",
	command: ["fake-aws"],
	baseUrl: "http://127.0.0.1:1",
	attempts: 3,
	attemptTimeoutMs: 50,
};

function fakeProcess(exitCode?: number): TunnelProcess & { resolveExit: (code: number) => void } {
	let resolveExit: (code: number) => void = () => undefined;
	const exited = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});
	if (exitCode !== undefined) resolveExit(exitCode);
	return { pid: 4242, exited, resolveExit };
}

// A fetch stand-in: each call answers with the next value (the last one repeats).
function answers(...oks: boolean[]): TunnelDeps["fetch"] {
	let i = 0;
	return async () => ({ ok: oks[Math.min(i++, oks.length - 1)] ?? false });
}

type Harness = TunnelDeps & { killed: number[]; signals: string[]; spawned: number };

// `diesOn`: the signal the fake process exits on. "never" models one that ignores SIGTERM.
function deps(over: Partial<TunnelDeps>, diesOn: "SIGTERM" | "SIGKILL" | "never" = "SIGTERM"): Harness {
	const state = { killed: [] as number[], signals: [] as string[], spawned: 0 };
	let current: ReturnType<typeof fakeProcess> | undefined;
	const base: TunnelDeps = {
		spawn: () => {
			state.spawned += 1;
			current = fakeProcess();
			return current;
		},
		fetch: answers(false),
		sleep: async () => undefined,
		killGroup: (pid, signal) => {
			state.killed.push(pid);
			state.signals.push(signal);
			if (signal === diesOn) current?.resolveExit(143);
		},
		log: () => undefined,
	};
	return Object.assign(state, base, over);
}

describe("withTunnel", () => {
	test("a hub that never answers is an error, and fn never runs against it", async () => {
		let ran = false;
		const d = deps({});
		await expect(
			withTunnel(
				opts,
				async () => {
					ran = true;
				},
				d,
			),
		).rejects.toThrow("tunnel to hub-x did not answer /health after 3 attempts");
		expect(ran).toBe(false);
		// Torn down even though it failed.
		expect(d.killed).toEqual([4242]);
	});

	test("each health attempt is bounded, so a connect that never settles cannot hang the command", async () => {
		// A connect that neither resolves nor rejects by itself: it ends only when its signal aborts.
		const signals: (AbortSignal | undefined)[] = [];
		const hangs: TunnelDeps["fetch"] = (_url, init) =>
			new Promise((_resolve, reject) => {
				signals.push(init?.signal);
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		const started = Date.now();
		await expect(
			withTunnel({ ...opts, attempts: 2, attemptTimeoutMs: 100 }, async () => 1, deps({ fetch: hangs })),
		).rejects.toThrow("did not answer /health");
		// 1 reuse probe + 2 attempts, 100 ms each. Without a signal this test would never return.
		expect(signals).toHaveLength(3);
		expect(signals.every((sig) => sig !== undefined)).toBe(true);
		expect(Date.now() - started).toBeLessThan(3000);
	});

	test("a tunnel process that exits early fails fast and names the likely cause", async () => {
		let attempts = 0;
		const d = deps({
			spawn: () => fakeProcess(255),
			fetch: async () => {
				attempts += 1;
				return { ok: false };
			},
		});
		await expect(withTunnel({ ...opts, attempts: 30 }, async () => 1, d)).rejects.toThrow(
			"tunnel to hub-x exited with code 255 before the hub answered",
		);
		// The reuse probe plus at most one wait-loop attempt: not 30 seconds of waiting on a dead process.
		expect(attempts).toBeLessThanOrEqual(2);
	});

	test("a hub already answering on the local port is reused: nothing is spawned, nothing is killed", async () => {
		const d = deps({ fetch: answers(true) });
		expect(await withTunnel(opts, async (baseUrl) => baseUrl, d)).toBe(opts.baseUrl);
		expect(d.spawned).toBe(0);
		// The operator's own tunnel must survive this command.
		expect(d.killed).toEqual([]);
	});

	test("the happy path runs fn once the hub answers, then tears the tunnel down", async () => {
		// reuse probe: no; first attempt: no; second attempt: yes
		const d = deps({ fetch: answers(false, false, true) });
		expect(await withTunnel(opts, async () => "done", d)).toBe("done");
		expect(d.spawned).toBe(1);
		expect(d.killed).toEqual([4242]);
	});

	test("fn throwing still tears the tunnel down", async () => {
		const d = deps({ fetch: answers(false, true) });
		await expect(
			withTunnel(
				opts,
				async () => {
					throw new Error("boom");
				},
				d,
			),
		).rejects.toThrow("boom");
		expect(d.killed).toEqual([4242]);
	});

	// Today's `finally` awaited tunnel.exited with no bound: a process that ignores SIGTERM hung
	// the command at the very end, after the work was done.
	test("a tunnel that ignores SIGTERM is killed, and teardown still returns", async () => {
		const d = deps({ fetch: answers(false, true) }, "SIGKILL");
		expect(await withTunnel(opts, async () => "done", d)).toBe("done");
		expect(d.signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	test("teardown gives up on a process that survives SIGKILL too, instead of hanging", async () => {
		const d = deps({ fetch: answers(false, true) }, "never");
		expect(await withTunnel(opts, async () => "done", d)).toBe("done");
		expect(d.signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	// The defect itself. `aws ssm start-session` runs session-manager-plugin as a CHILD, and
	// proc.kill() signalled only the aws process: the plugin kept the local port and was
	// reparented to launchd. Real processes, real teardown; only the health check is faked.
	test("tearing down kills the tunnel's child process too, not just the process that was spawned", async () => {
		const pidFile = path.join(mkdtempSync(path.join(tmpdir(), "sio1792-")), "child.pid");
		await withTunnel(
			{ ...opts, command: ["bash", "-c", `sleep 60 & echo $! > ${pidFile}; wait`] },
			async () => {
				// Give bash a moment to have written the child's pid.
				for (let i = 0; i < 50 && !Bun.file(pidFile).size; i++) await Bun.sleep(20);
			},
			{ fetch: answers(false, true), log: () => undefined },
		);
		const childPid = Number(readFileSync(pidFile, "utf-8").trim());
		expect(childPid).toBeGreaterThan(0);
		await Bun.sleep(200);
		let alive = true;
		try {
			process.kill(childPid, 0);
		} catch {
			alive = false;
		}
		if (alive) process.kill(childPid, "SIGKILL"); // never leave the stand-in behind, even on failure
		expect(alive).toBe(false);
	});
});

// The rollout poll retries a transport failure and fails fast on an HTTP answer, so the two must
// be distinguishable. globalThis.fetch is restored in `finally`: bun runs every test file in one
// process, and a leaked stub hangs whichever file runs next.
describe("listAgents", () => {
	const withFetch = async (stub: typeof fetch, run: () => Promise<void>) => {
		const real = globalThis.fetch;
		globalThis.fetch = stub;
		try {
			await run();
		} finally {
			globalThis.fetch = real;
		}
	};

	test("passes an abort signal, so a stalled hub cannot hang the caller", async () => {
		let signal: AbortSignal | null | undefined;
		const stub = (async (_url: string, init?: RequestInit) => {
			signal = init?.signal;
			return new Response(JSON.stringify({ agents: [] }));
		}) as unknown as typeof fetch;
		await withFetch(stub, async () => {
			expect(await listAgents("http://127.0.0.1:1", "t")).toEqual([]);
		});
		expect(signal).toBeInstanceOf(AbortSignal);
	});

	test("an HTTP refusal is a HubHttpError; a transport failure is not", async () => {
		const refused = (async () => new Response("bad token", { status: 401 })) as unknown as typeof fetch;
		await withFetch(refused, async () => {
			await expect(listAgents("http://127.0.0.1:1", "t")).rejects.toBeInstanceOf(HubHttpError);
		});
		const stalled = (async () => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		}) as unknown as typeof fetch;
		await withFetch(stalled, async () => {
			const error = await listAgents("http://127.0.0.1:1", "t").catch((e: unknown) => e);
			expect(error).not.toBeInstanceOf(HubHttpError);
		});
	});
});
