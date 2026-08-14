// src/clients/connect-deployments.test.ts
import { describe, expect, mock, test } from "bun:test";
import { connectDeployments } from "./connect-deployments.js";

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
});
