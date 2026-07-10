/**
 * BLOCKED OPERATION HANDLER TEST
 *
 * Test that the createBlockedOperationHandler properly catches KongOperationBlockedError
 * and returns structured elicitation responses instead of plain errors.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { MandatoryElicitationGate } from "../src/enforcement/mandatory-elicitation-gate.js";
import { createBlockedOperationHandler } from "../src/enforcement/mcp-server-integration.js";

// Empty stub for the MCP RequestHandlerExtra parameter; this test does not
// exercise the extra channel.
const fakeExtra = {} as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;

describe("INFO: Blocked Operation Handler", () => {
	// SIO-1045: MandatoryElicitationGate is a process-wide singleton keyed by a
	// deterministic hash of (operation, userMessage). A prior test file that completed
	// elicitation for the same "create_service" + userMessage combo would leave this
	// operation's context cached as elicitationComplete, so the handler falls through
	// to the real (non-blocked) branch and the test flips to CI-only-fail depending on
	// bun's file execution order. Clear the singleton's session state before this test
	// runs so it never depends on what ran before it in the process.
	beforeEach(() => {
		const gate = MandatoryElicitationGate.getInstance();
		for (const [sessionId] of gate.getActiveSessions()) {
			gate.clearSession(sessionId);
		}
	});

	it("should catch KongOperationBlockedError and return structured elicitation response", async () => {
		console.log("INFO: Testing blocked operation handler...");

		// Create a blocked operation handler for create_service
		const handler = createBlockedOperationHandler("create_service", "Test deployment without context", [], []);

		let result: Record<string, unknown> | undefined;
		let wasStructuredResponse = false;

		try {
			result = (await handler(
				{
					controlPlaneId: "test-cp-123",
					name: "test-service",
					host: "test-host",
				},
				fakeExtra,
			)) as Record<string, unknown>;

			console.log("INFO: Handler result:", JSON.stringify(result, null, 2));

			// Check if result is a structured elicitation response
			if (result && typeof result === "object" && result.error === "KONG_OPERATION_BLOCKED") {
				wasStructuredResponse = true;
				console.log("SUCCESS: Got structured elicitation response");
				console.log("Session ID:", result.sessionId);
				console.log("Missing fields:", result.missingFields);
				console.log("Next steps:", result.nextSteps);
			} else {
				console.log("ERROR: Expected structured elicitation response but got:", typeof result);
			}
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			console.log(
				"ERROR: Handler threw error instead of returning structured response:",
				err.constructor.name,
				err.message,
			);
		}

		expect(wasStructuredResponse).toBe(true);
		expect(result).toHaveProperty("error", "KONG_OPERATION_BLOCKED");
		expect(result).toHaveProperty("sessionId");
		expect(result).toHaveProperty("missingFields");
		expect(result).toHaveProperty("nextSteps");
	});
});
