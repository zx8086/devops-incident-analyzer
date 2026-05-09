// packages/mcp-server-elastic/src/utils/discoveryRequestOptions.test.ts
import { describe, expect, test } from "bun:test";
import { getDiscoveryRequestOptions } from "./discoveryRequestOptions.ts";

describe("getDiscoveryRequestOptions", () => {
	test("returns 8000ms timeout / 0 retries when env unset", () => {
		expect(getDiscoveryRequestOptions({})).toEqual({ requestTimeout: 8000, maxRetries: 0 });
	});

	test("honors ELASTIC_DISCOVERY_REQUEST_TIMEOUT_MS override", () => {
		expect(getDiscoveryRequestOptions({ ELASTIC_DISCOVERY_REQUEST_TIMEOUT_MS: "12000" })).toEqual({
			requestTimeout: 12000,
			maxRetries: 0,
		});
	});

	test("honors ELASTIC_DISCOVERY_MAX_RETRIES override", () => {
		expect(getDiscoveryRequestOptions({ ELASTIC_DISCOVERY_MAX_RETRIES: "1" })).toEqual({
			requestTimeout: 8000,
			maxRetries: 1,
		});
	});

	test("falls back to defaults on invalid timeout values", () => {
		for (const raw of ["abc", "0", "-5", ""]) {
			expect(getDiscoveryRequestOptions({ ELASTIC_DISCOVERY_REQUEST_TIMEOUT_MS: raw })).toEqual({
				requestTimeout: 8000,
				maxRetries: 0,
			});
		}
	});

	test("falls back to default on invalid retry values, but accepts 0 explicitly", () => {
		// Negative + non-numeric clamp back to default 0; explicit "0" stays 0.
		for (const raw of ["abc", "-1"]) {
			expect(getDiscoveryRequestOptions({ ELASTIC_DISCOVERY_MAX_RETRIES: raw })).toEqual({
				requestTimeout: 8000,
				maxRetries: 0,
			});
		}
		expect(getDiscoveryRequestOptions({ ELASTIC_DISCOVERY_MAX_RETRIES: "0" })).toEqual({
			requestTimeout: 8000,
			maxRetries: 0,
		});
	});

	test("floors fractional env values", () => {
		expect(
			getDiscoveryRequestOptions({
				ELASTIC_DISCOVERY_REQUEST_TIMEOUT_MS: "8500.7",
				ELASTIC_DISCOVERY_MAX_RETRIES: "2.9",
			}),
		).toEqual({ requestTimeout: 8500, maxRetries: 2 });
	});
});
