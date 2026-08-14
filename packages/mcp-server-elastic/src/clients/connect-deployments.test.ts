// src/clients/connect-deployments.test.ts
import { describe, expect, mock, test } from "bun:test";
import { errors } from "@elastic/elasticsearch";
import {
	connectDeployments,
	DeploymentAuthError,
	DeploymentConfigError,
	isAuthProbeFailure,
} from "./connect-deployments.js";

interface Spec {
	id: string;
}

function makeLogger() {
	return { warn: mock(() => {}), info: mock(() => {}) };
}

// A fake client is just a tagged object; connectDeployments never inspects it.
const fakeClient = (id: string) => ({ id }) as unknown;

describe("connectDeployments", () => {
	const specs: Spec[] = [{ id: "eu-cld" }, { id: "us-cld" }, { id: "eu-b2b" }];

	test("all deployments succeed -> all registered, default unchanged, no failures", async () => {
		const log = makeLogger();
		const res = await connectDeployments(specs, "eu-cld", async (s) => fakeClient(s.id), log);

		expect([...res.clients.keys()]).toEqual(["eu-cld", "us-cld", "eu-b2b"]);
		expect(res.defaultId).toBe("eu-cld");
		expect(res.failures).toEqual([]);
		expect(log.warn).not.toHaveBeenCalled();
	});

	test("one non-default deployment fails -> skipped with warn, others registered, default kept", async () => {
		const log = makeLogger();
		const res = await connectDeployments(
			specs,
			"eu-cld",
			async (s) => {
				if (s.id === "us-cld") throw new Error("connect ECONNRESET");
				return fakeClient(s.id);
			},
			log,
		);

		expect([...res.clients.keys()]).toEqual(["eu-cld", "eu-b2b"]);
		expect(res.defaultId).toBe("eu-cld");
		expect(res.failures).toEqual([{ id: "us-cld", error: "connect ECONNRESET" }]);
		// one per-deployment warn + a partial-availability info
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(log.info).toHaveBeenCalledTimes(1);
	});

	test("the DEFAULT deployment fails -> default re-points to first surviving deployment", async () => {
		const log = makeLogger();
		const res = await connectDeployments(
			specs,
			"eu-cld",
			async (s) => {
				if (s.id === "eu-cld") throw new Error("Was there a typo in the url or port?");
				return fakeClient(s.id);
			},
			log,
		);

		expect(res.clients.has("eu-cld")).toBe(false);
		expect([...res.clients.keys()]).toEqual(["us-cld", "eu-b2b"]);
		expect(res.defaultId).toBe("us-cld"); // re-pointed
		expect(res.failures.map((f) => f.id)).toEqual(["eu-cld"]);
		// a per-deployment warn AND a re-point warn
		expect(log.warn).toHaveBeenCalledTimes(2);
	});

	test("ALL deployments fail -> throws with a summary listing each failure", async () => {
		const log = makeLogger();
		await expect(
			connectDeployments(
				specs,
				"eu-cld",
				async (s) => {
					throw new Error(`boom-${s.id}`);
				},
				log,
			),
		).rejects.toThrow(/All 3 Elasticsearch deployment\(s\) failed to connect/);
	});

	test("non-Error throws are stringified, not swallowed", async () => {
		const log = makeLogger();
		const res = await connectDeployments(
			[{ id: "a" }, { id: "b" }],
			"a",
			async (s) => {
				if (s.id === "a") throw "string failure"; // non-Error
				return fakeClient(s.id);
			},
			log,
		);
		expect(res.failures).toEqual([{ id: "a", error: "string failure" }]);
		expect(res.defaultId).toBe("b");
	});

	// Greptile #659 Issue 3: a local misconfiguration must NOT be silently tolerated as a
	// transient outage -- it has to fail loudly so operators fix the config rather than have
	// requests silently routed through a different surviving cluster.
	test("a DeploymentConfigError propagates (throws), even when later deployments would succeed", async () => {
		const log = makeLogger();
		await expect(
			connectDeployments(
				specs,
				"eu-cld",
				async (s) => {
					if (s.id === "eu-cld") throw new DeploymentConfigError(s.id, new Error("ENOENT: bad caCert path"));
					return fakeClient(s.id);
				},
				log,
			),
		).rejects.toThrow(/invalid configuration.*bad caCert path/);
		// It must not be recorded as a tolerable skip.
		expect(log.warn).not.toHaveBeenCalled();
	});

	test("DeploymentConfigError carries the deploymentId and wraps the original cause", () => {
		const cause = new Error("permission denied");
		const err = new DeploymentConfigError("eu-b2b", cause);
		expect(err.deploymentId).toBe("eu-b2b");
		expect(err.cause).toBe(cause);
		expect(err.name).toBe("DeploymentConfigError");
	});

	// CodeRabbit #659: a non-Error cause must be preserved too, not dropped.
	test("DeploymentConfigError preserves a non-Error cause", () => {
		const err = new DeploymentConfigError("eu-b2b", "raw string failure");
		expect(err.cause).toBe("raw string failure");
		expect(err.message).toContain("raw string failure");
	});

	// SIO-1467: a DeploymentAuthError (401/403 during the probe) is fatal, like a config error --
	// it must propagate, not be tolerated as a transient skip, even when other deployments connect.
	test("a DeploymentAuthError propagates (throws), even when later deployments would succeed", async () => {
		const log = makeLogger();
		await expect(
			connectDeployments(
				specs,
				"eu-cld",
				async (s) => {
					if (s.id === "eu-cld") throw new DeploymentAuthError(s.id, 401, new Error("security_exception"));
					return fakeClient(s.id);
				},
				log,
			),
		).rejects.toThrow(DeploymentAuthError);
		expect(log.warn).not.toHaveBeenCalled();
	});

	test("DeploymentAuthError carries deploymentId + statusCode and preserves the cause", () => {
		const cause = new Error("action [cluster:monitor/main] is unauthorized");
		const err = new DeploymentAuthError("eu-b2b", 403, cause);
		expect(err.deploymentId).toBe("eu-b2b");
		expect(err.statusCode).toBe(403);
		expect(err.cause).toBe(cause);
		expect(err.name).toBe("DeploymentAuthError");
		expect(err.message).toContain("403");
	});

	// CodeRabbit #660: a fatal failure part-way through must close the pools already opened for
	// earlier successful deployments, not leak them.
	test("on a fatal rethrow, closeOne is called for every already-connected client", async () => {
		const log = makeLogger();
		const closed: string[] = [];
		const closeOne = mock(async (client: { id: string }) => {
			closed.push(client.id);
		});
		await expect(
			connectDeployments<Spec, { id: string }>(
				specs, // eu-cld, us-cld, eu-b2b
				"eu-cld",
				async (s) => {
					if (s.id === "eu-b2b") throw new DeploymentAuthError(s.id, 401, new Error("security_exception"));
					return { id: s.id };
				},
				log,
				closeOne,
			),
		).rejects.toThrow(DeploymentAuthError);
		// eu-cld + us-cld connected before eu-b2b failed fatally -> both must be closed.
		expect(closed.sort()).toEqual(["eu-cld", "us-cld"]);
	});

	test("a close failure during fatal unwind is logged and does not mask the fatal error", async () => {
		const log = makeLogger();
		await expect(
			connectDeployments<Spec, { id: string }>(
				specs,
				"eu-cld",
				async (s) => {
					if (s.id === "us-cld") throw new DeploymentConfigError(s.id, new Error("bad caCert"));
					return { id: s.id };
				},
				log,
				async () => {
					throw new Error("close failed");
				},
			),
		).rejects.toThrow(DeploymentConfigError); // the fatal error, not the close error
		expect(log.warn).toHaveBeenCalled(); // the close failure was logged
	});
});

describe("isAuthProbeFailure", () => {
	const responseError = (statusCode: number) =>
		new errors.ResponseError({
			statusCode,
			body: { error: { type: "security_exception" } },
			warnings: [],
			meta: {},
		} as unknown as ConstructorParameters<typeof errors.ResponseError>[0]);

	test("401 ResponseError -> true", () => {
		expect(isAuthProbeFailure(responseError(401))).toBe(true);
	});

	test("403 ResponseError -> true", () => {
		expect(isAuthProbeFailure(responseError(403))).toBe(true);
	});

	test("other status codes (404, 500, 503) -> false", () => {
		expect(isAuthProbeFailure(responseError(404))).toBe(false);
		expect(isAuthProbeFailure(responseError(500))).toBe(false);
		expect(isAuthProbeFailure(responseError(503))).toBe(false);
	});

	test("transient connectivity errors -> false", () => {
		expect(isAuthProbeFailure(new errors.ConnectionError("ECONNREFUSED"))).toBe(false);
		expect(isAuthProbeFailure(new errors.TimeoutError("timed out"))).toBe(false);
		expect(isAuthProbeFailure(new Error("Was there a typo in the url or port?"))).toBe(false);
	});

	test("non-error values -> false", () => {
		expect(isAuthProbeFailure(undefined)).toBe(false);
		expect(isAuthProbeFailure("nope")).toBe(false);
		expect(isAuthProbeFailure({ statusCode: 401 })).toBe(false); // not a ResponseError instance
	});
});
