// shared/src/__tests__/bootstrap-stream-cancel.test.ts
import { describe, expect, test } from "bun:test";
import { isBenignStreamCancel } from "../bootstrap.ts";

// SIO-869: an SSE client disconnecting mid-stream cancels the response reader and
// throws AbortError("Stream reader cancelled via releaseLock()"). That must be treated
// as benign so the unhandledRejection handler does not process.exit() the server.
describe("isBenignStreamCancel (SIO-869)", () => {
	test("matches the releaseLock stream-cancel AbortError", () => {
		const err = new Error("Stream reader cancelled via releaseLock()");
		err.name = "AbortError";
		expect(isBenignStreamCancel(err)).toBe(true);
	});

	test("matches the 'stream reader was cancelled' phrasing", () => {
		const err = new Error("The stream reader was cancelled");
		err.name = "AbortError";
		expect(isBenignStreamCancel(err)).toBe(true);
	});

	test("does not swallow a releaseLock message that is not an AbortError", () => {
		expect(isBenignStreamCancel(new Error("releaseLock failed"))).toBe(false);
	});

	test("does not swallow an unrelated AbortError (real cancellation we want surfaced)", () => {
		const err = new Error("The operation was aborted");
		err.name = "AbortError";
		expect(isBenignStreamCancel(err)).toBe(false);
	});

	test("handles non-Error reasons without throwing", () => {
		expect(isBenignStreamCancel("releaseLock")).toBe(false);
		expect(isBenignStreamCancel(undefined)).toBe(false);
		expect(isBenignStreamCancel(null)).toBe(false);
	});
});
