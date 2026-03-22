/**
 * BLOCKED OPERATION HANDLER TEST
 *
 * Test that the createBlockedOperationHandler properly catches KongOperationBlockedError
 * and returns structured elicitation responses instead of plain errors.
 */

import { describe, expect, it } from "bun:test";
import { createBlockedOperationHandler } from "../enforcement/mcp-server-integration.js";

describe("INFO: Blocked Operation Handler", () => {
  it("should catch KongOperationBlockedError and return structured elicitation response", async () => {
    console.log("INFO: Testing blocked operation handler...");

    // Create a blocked operation handler for create_service
    const handler = createBlockedOperationHandler(
      "create_service",
      "Test deployment without context",
      [],
      [],
    );

    let result;
    let wasStructuredResponse = false;

    try {
      result = await handler(
        {
          controlPlaneId: "test-cp-123",
          name: "test-service",
          host: "test-host",
        },
        {} as any,
      );

      console.log("INFO: Handler result:", JSON.stringify(result, null, 2));

      // Check if result is a structured elicitation response
      if (
        result &&
        typeof result === "object" &&
        result.error === "KONG_OPERATION_BLOCKED"
      ) {
        wasStructuredResponse = true;
        console.log("SUCCESS: Got structured elicitation response");
        console.log("Session ID:", result.sessionId);
        console.log("Missing fields:", result.missingFields);
        console.log("Next steps:", result.nextSteps);
      } else {
        console.log(
          "ERROR: Expected structured elicitation response but got:",
          typeof result,
        );
      }
    } catch (error) {
      console.log(
        "ERROR: Handler threw error instead of returning structured response:",
        error.constructor.name,
        error.message,
      );
    }

    expect(wasStructuredResponse).toBe(true);
    expect(result).toHaveProperty("error", "KONG_OPERATION_BLOCKED");
    expect(result).toHaveProperty("sessionId");
    expect(result).toHaveProperty("missingFields");
    expect(result).toHaveProperty("nextSteps");
  });
});
