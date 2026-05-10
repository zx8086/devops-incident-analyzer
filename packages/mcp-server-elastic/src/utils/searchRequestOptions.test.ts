// packages/mcp-server-elastic/src/utils/searchRequestOptions.test.ts
import { describe, expect, test } from "bun:test";
import { getSearchRequestOptions } from "./searchRequestOptions.ts";

describe("getSearchRequestOptions", () => {
	test("returns 60000ms timeout / 0 retries when env unset", () => {
		expect(getSearchRequestOptions({})).toEqual({ requestTimeout: 60000, maxRetries: 0 });
	});

	test("honors ELASTIC_SEARCH_REQUEST_TIMEOUT_MS override", () => {
		expect(getSearchRequestOptions({ ELASTIC_SEARCH_REQUEST_TIMEOUT_MS: "90000" })).toEqual({
			requestTimeout: 90000,
			maxRetries: 0,
		});
	});

	test("honors ELASTIC_SEARCH_MAX_RETRIES override", () => {
		expect(getSearchRequestOptions({ ELASTIC_SEARCH_MAX_RETRIES: "1" })).toEqual({
			requestTimeout: 60000,
			maxRetries: 1,
		});
	});

	test("falls back to default on invalid timeout values", () => {
		for (const raw of ["abc", "0", "-5", ""]) {
			expect(getSearchRequestOptions({ ELASTIC_SEARCH_REQUEST_TIMEOUT_MS: raw })).toEqual({
				requestTimeout: 60000,
				maxRetries: 0,
			});
		}
	});

	test("falls back to default on invalid retry values, but accepts 0 explicitly", () => {
		for (const raw of ["abc", "-1"]) {
			expect(getSearchRequestOptions({ ELASTIC_SEARCH_MAX_RETRIES: raw })).toEqual({
				requestTimeout: 60000,
				maxRetries: 0,
			});
		}
		expect(getSearchRequestOptions({ ELASTIC_SEARCH_MAX_RETRIES: "0" })).toEqual({
			requestTimeout: 60000,
			maxRetries: 0,
		});
	});

	test("floors fractional env values", () => {
		expect(
			getSearchRequestOptions({
				ELASTIC_SEARCH_REQUEST_TIMEOUT_MS: "75500.7",
				ELASTIC_SEARCH_MAX_RETRIES: "1.9",
			}),
		).toEqual({ requestTimeout: 75500, maxRetries: 1 });
	});
});
