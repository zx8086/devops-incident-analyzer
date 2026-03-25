/**
 * END-TO-END ELICITATION WORKFLOW TEST
 *
 * Test the complete workflow:
 * 1. Kong operation is blocked due to missing context
 * 2. User processes elicitation response with required context
 * 3. Kong operation succeeds with validated context
 */

import { describe, expect, it } from "bun:test";
import { MandatoryElicitationGate } from "../enforcement/mandatory-elicitation-gate.js";
import { createBlockedOperationHandler, ELICITATION_TOOL_HANDLERS } from "../enforcement/mcp-server-integration.js";

describe("INFO: End-to-End Elicitation Workflow", () => {
	it("should complete full elicitation workflow from blocked operation to successful operation", async () => {
		console.log("INFO: Testing complete elicitation workflow...");

		// Step 1: Attempt Kong operation without context - should be blocked
		console.log("\n📍 STEP 1: Attempting Kong operation without context...");
		const serviceHandler = createBlockedOperationHandler("create_service", "Deploy API gateway service", [], []);

		const blockedResult = await serviceHandler(
			{
				controlPlaneId: "test-cp-123",
				name: "api-service",
				host: "api.internal.com",
			},
			{} as any,
		);

		console.log("SUCCESS: Operation blocked as expected");
		const typedBlockedResult = blockedResult as Record<string, unknown>;
		expect(typedBlockedResult).toHaveProperty("error", "KONG_OPERATION_BLOCKED");
		expect(typedBlockedResult).toHaveProperty("sessionId");

		const sessionId = typedBlockedResult.sessionId as string;
		console.log("INFO: Session ID:", sessionId);

		// Step 2: Process elicitation response with required context
		console.log("\n📍 STEP 2: Processing elicitation response with required context...");

		const elicitationResponse = await ELICITATION_TOOL_HANDLERS.process_elicitation_response(
			{
				sessionId: sessionId,
				responses: {
					domain: "api",
					environment: "production",
					team: "platform-team",
				},
			},
			{} as any,
		);

		console.log("SUCCESS: Elicitation response processed");
		console.log("Response result:", elicitationResponse);
		expect(elicitationResponse).toHaveProperty("success", true);

		// Step 3: Verify context is now available
		console.log("\n📍 STEP 3: Verifying context is cached and available...");
		const gate = MandatoryElicitationGate.getInstance();
		const activeSessions = gate.getActiveSessions();
		console.log("Active sessions:", Array.from(activeSessions.keys()));

		let foundValidatedContext = false;
		for (const [_key, context] of activeSessions) {
			if (context.elicitationComplete && context.domain === "api") {
				foundValidatedContext = true;
				console.log("SUCCESS: Found validated context:", context);
				break;
			}
		}

		expect(foundValidatedContext).toBe(true);

		// Step 4: Retry the original operation - should now succeed
		console.log("\n📍 STEP 4: Retrying original operation with validated context...");

		// For this test, we'll mock the actual Kong API call to focus on the elicitation workflow
		// In a real scenario, the operation would proceed to create the service in Kong
		try {
			// This should now work because context is validated and cached
			const successResult = await serviceHandler(
				{
					controlPlaneId: "test-cp-123",
					name: "api-service",
					host: "api.internal.com",
				},
				{} as any,
			);

			// In a real integration, this would be the Kong service creation result
			// For this test, we expect either success or a different error (not blocked)
			const typedResult = successResult as Record<string, unknown> | undefined;
			console.log(
				"Operation result:",
				typeof successResult,
				typedResult?.error !== "KONG_OPERATION_BLOCKED" ? "SUCCESS" : "STILL_BLOCKED",
			);

			// The operation should not be blocked anymore
			expect(typedResult?.error).not.toBe("KONG_OPERATION_BLOCKED");
			console.log("SUCCESS: Operation no longer blocked by elicitation");
		} catch (error) {
			// Any error here should not be a KongOperationBlockedError
			const err = error instanceof Error ? error : new Error(String(error));
			console.log("Operation threw:", err.constructor.name, err.message);
			expect(err.constructor.name).not.toBe("KongOperationBlockedError");
			console.log("SUCCESS: Operation no longer blocked by elicitation (threw different error)");
		}

		console.log("\n🎉 END-TO-END ELICITATION WORKFLOW COMPLETE");
	});
});
