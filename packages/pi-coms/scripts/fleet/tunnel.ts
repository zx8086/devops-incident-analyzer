// scripts/fleet/tunnel.ts
// SIO-1792: the SSM port-forward the fleet CLI opens to a hub. Extracted from fleet.ts so it can
// be tested, and rebuilt around three failures the old inline version allowed:
//   - a /health connect that never settled hung the command (fetch had no signal);
//   - 30 failed attempts fell through and ran `fn` against a tunnel that never opened;
//   - proc.kill() signalled `aws` only. `aws ssm start-session` runs session-manager-plugin as a
//     CHILD, which kept the local port and was reparented to launchd (the orphans that blocked
//     the operator's own `just hub-tunnel`).

export type TunnelProcess = { pid: number; exited: Promise<number> };

export type TunnelDeps = {
	spawn: (command: string[]) => TunnelProcess;
	fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean }>;
	sleep: (ms: number) => Promise<void>;
	killGroup: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
	log: (line: string) => void;
};

export type TunnelOptions = {
	label: string;
	command: string[];
	baseUrl: string;
	attempts?: number;
	attemptTimeoutMs?: number;
};

const TEARDOWN_GRACE_MS = 5_000;

const realDeps: TunnelDeps = {
	// detached: the tunnel leads its OWN process group, so the whole group (aws + the plugin it
	// starts) can be signalled through -pid without listing processes. The cost: a detached
	// group no longer receives the terminal's Ctrl-C, hence the signal handlers below.
	spawn: (command) => Bun.spawn(command, { stdout: "ignore", stderr: "inherit", detached: true }),
	fetch: (url, init) => fetch(url, init),
	sleep: (ms) => Bun.sleep(ms),
	killGroup: (pid, signal) => {
		try {
			process.kill(-pid, signal);
		} catch {
			// ESRCH: the group is already gone.
		}
	},
	log: (line) => console.log(line),
};

export async function withTunnel<T>(
	options: TunnelOptions,
	fn: (baseUrl: string) => Promise<T>,
	overrides: Partial<TunnelDeps> = {},
): Promise<T> {
	const deps = { ...realDeps, ...overrides };
	const { label, command, baseUrl } = options;
	const attempts = options.attempts ?? 30;
	const attemptTimeoutMs = options.attemptTimeoutMs ?? 2_000;

	// Bounded per attempt: Bun.sleep between attempts bounds the GAP, not the attempt.
	const healthy = async (): Promise<boolean> => {
		try {
			return (await deps.fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(attemptTimeoutMs) })).ok;
		} catch {
			return false;
		}
	};

	// A hub already answering here is the operator's own `just hub-tunnel` (local_port is per
	// hub). Use it and leave it alone: spawning a second tunnel onto a bound port cannot work,
	// and tearing down must never touch a tunnel this command did not open.
	if (await healthy()) {
		deps.log(`${label}: using the tunnel already open on ${baseUrl}`);
		return await fn(baseUrl);
	}

	const tunnel = deps.spawn(command);
	let exitCode: number | undefined;
	void tunnel.exited.then((code) => {
		exitCode = code;
	});

	const teardown = async () => {
		deps.killGroup(tunnel.pid, "SIGTERM");
		const gone = () => tunnel.exited.then(() => true);
		const grace = () => deps.sleep(TEARDOWN_GRACE_MS).then(() => false);
		if (await Promise.race([gone(), grace()])) return;
		deps.killGroup(tunnel.pid, "SIGKILL");
		await Promise.race([gone(), grace()]);
	};
	// `finally` does not run when this process is signalled, which is exactly when the old CLI
	// left its tunnels behind (a tool timeout, a stopped task).
	const onSignal = () => {
		deps.killGroup(tunnel.pid, "SIGKILL");
		process.exit(130);
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);

	try {
		for (let i = 0; i < attempts; i++) {
			if (exitCode !== undefined) {
				throw new Error(
					`tunnel to ${label} exited with code ${exitCode} before the hub answered ` +
						`(expired credentials, or ${baseUrl} held by a process that is not a hub tunnel?)`,
				);
			}
			if (await healthy()) return await fn(baseUrl);
			await deps.sleep(1_000);
		}
		throw new Error(`tunnel to ${label} did not answer /health after ${attempts} attempts on ${baseUrl}`);
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		await teardown();
	}
}
