// src/transport/__tests__/factory.test.ts
import { describe, expect, test } from "bun:test";
import { resolveTransportMode } from "../factory.ts";

describe("resolveTransportMode", () => {
	test("returns stdio for stdio mode", () => {
		expect(resolveTransportMode("stdio")).toEqual({ stdio: true, http: false, agentcore: false });
	});

	test("returns http for http mode", () => {
		expect(resolveTransportMode("http")).toEqual({ stdio: false, http: true, agentcore: false });
	});

	test("returns both for both mode", () => {
		expect(resolveTransportMode("both")).toEqual({ stdio: true, http: true, agentcore: false });
	});

	test("returns agentcore for agentcore mode", () => {
		expect(resolveTransportMode("agentcore")).toEqual({ stdio: false, http: false, agentcore: true });
	});

	test("defaults to stdio for unknown mode", () => {
		expect(resolveTransportMode("unknown")).toEqual({ stdio: true, http: false, agentcore: false });
	});
});
