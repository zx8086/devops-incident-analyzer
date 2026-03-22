/**
 * DEBUG ENFORCEMENT TEST
 *
 * Simple test to debug why blocking isn't working
 */

import { describe, expect, it } from "bun:test";
import {
  ElicitationBlockedError,
  MandatoryElicitationGate,
} from "../enforcement/mandatory-elicitation-gate.js";

describe("INFO: Debug Enforcement", () => {
  it("should test gate directly", async () => {
    const gate = MandatoryElicitationGate.getInstance();

    // Clear sessions
    const sessions = gate.getActiveSessions();
    for (const [sessionId] of sessions) {
      gate.clearSession(sessionId);
    }

    let wasBlocked = false;
    let errorMessage = "";

    try {
      console.log("INFO: Testing direct gate validation...");

      await gate.validateMandatoryContext({
        operationName: "create_service",
        parameters: { controlPlaneId: "test-cp-123" },
        requestContext: {
          userMessage: "Test deployment without context",
          files: [],
          configs: [],
        },
      });

      console.log("ERROR: Gate did NOT block - this is wrong!");
    } catch (error) {
      wasBlocked = true;
      errorMessage = error.message;
      console.log(
        "SUCCESS: Gate blocked correctly:",
        error.constructor.name,
        error.message,
      );

      if (error instanceof ElicitationBlockedError) {
        console.log("SUCCESS: Correct error type - ElicitationBlockedError");
        console.log("Missing fields:", error.missingFields);
      } else {
        console.log("ERROR: Wrong error type:", error.constructor.name);
      }
    }

    expect(wasBlocked).toBe(true);
    expect(errorMessage).toContain("KONG OPERATION BLOCKED");
  });
});
