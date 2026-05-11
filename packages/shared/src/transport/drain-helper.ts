// shared/src/transport/drain-helper.ts
//
// SIO-727: graceful shutdown drain for Bun HTTP servers. Used by both the
// kafka MCP's http transport and the shared AgentCore transport.
//
// Bun's server.stop() with no arg waits for active connections to finish
// before returning. We race that against a bounded deadline so we never hang
// past the container orchestrator's terminationGracePeriodSeconds (default
// 30s for both k8s and AgentCore -- 25s drain leaves 5s headroom for the
// remaining shutdown steps before SIGKILL cuts us off).
//
// Pair this with a shuttingDown flag check at the top of each request handler
// so requests that race in during the brief stop() propagation window get a
// clean JSON-RPC 503 envelope rather than an ECONNRESET.

import type { BootstrapLogger } from "../bootstrap.ts";

interface BunServerLike {
	stop(closeActiveConnections?: boolean): Promise<void> | void;
}

// drainBunServer never rejects. Shutdown paths must never throw -- a thrown
// drain error during SIGTERM handling would leak past the bootstrap.ts catch
// and confuse the operator. Force-close on any unexpected failure.
export async function drainBunServer(
	server: BunServerLike,
	deadlineMs: number,
	logger: BootstrapLogger,
): Promise<void> {
	const startedAt = Date.now();

	// SIO-727: an operator-set deadlineMs of 0 means "skip the drain, force-close
	// immediately" -- parity with pre-SIO-727 behaviour for anyone who needs it.
	if (deadlineMs <= 0) {
		try {
			await server.stop(true);
		} catch (err) {
			logger.error("Force-close threw during deadlineMs=0 drain", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		return;
	}

	let timer: ReturnType<typeof setTimeout> | null = null;
	let timedOut = false;

	const timeoutPromise = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => {
			timedOut = true;
			resolve("timeout");
		}, deadlineMs);
	});

	const stopPromise: Promise<"stopped"> = Promise.resolve()
		.then(() => server.stop())
		.then(() => "stopped" as const);

	try {
		const outcome = await Promise.race([stopPromise, timeoutPromise]);
		if (outcome === "stopped") {
			if (timer) clearTimeout(timer);
			logger.info("HTTP server drained gracefully", { elapsedMs: Date.now() - startedAt });
			return;
		}
		// Timeout won the race -- force-close to release the container.
		logger.warn("HTTP server drain exceeded deadline; force-closing", {
			deadlineMs,
			elapsedMs: Date.now() - startedAt,
		});
		try {
			await server.stop(true);
		} catch (err) {
			logger.error("Force-close threw after drain timeout", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	} catch (err) {
		if (timer) clearTimeout(timer);
		// If the graceful stop() itself rejected, try a force-close so we still
		// release the container. Swallow any further errors.
		logger.error("Graceful drain rejected; attempting force-close", {
			error: err instanceof Error ? err.message : String(err),
			timedOut,
		});
		try {
			await server.stop(true);
		} catch (forceErr) {
			logger.error("Force-close after graceful-drain failure also threw", {
				error: forceErr instanceof Error ? forceErr.message : String(forceErr),
			});
		}
	}
}
