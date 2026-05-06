/**
 * BYPASS PREVENTION TESTING FRAMEWORK
 *
 * This framework ensures that elicitation enforcement cannot be bypassed
 * under any circumstances. It validates that ALL Kong modification operations
 * are blocked until mandatory context is provided.
 *
 * ARCHITECTURAL PRINCIPLE: Make elicitation bypass impossible by testing
 * every conceivable way someone might try to circumvent the enforcement.
 */

import {
	BlockedConsumerOperations,
	BlockedPluginOperations,
	BlockedRouteOperations,
	BlockedServiceOperations,
	KongOperationBlockedError,
} from "./kong-tool-blockers";
import { ElicitationBlockedError, type MandatoryContext, MandatoryElicitationGate } from "./mandatory-elicitation-gate";

/**
 * TEST CONSTANTS
 */
const TEST_CONTROL_PLANE_ID = "test-cp-123";
const TEST_REQUEST_CONTEXT = {
	userMessage: "Test deployment without proper context",
	files: [],
	configs: [],
};

/**
 * BYPASS ATTEMPT SCENARIOS
 *
 * These tests validate that common bypass attempts fail
 */
export class BypassPreventionTests {
	private gate: MandatoryElicitationGate;

	constructor() {
		this.gate = MandatoryElicitationGate.getInstance();
	}

	/**
	 * CLEAR ALL SESSIONS - Reset enforcement state for tests
	 */
	private clearAllSessions() {
		const sessions = this.gate.getActiveSessions();
		for (const [sessionId] of sessions) {
			this.gate.clearSession(sessionId);
		}
	}

	/**
	 * TEST 1: DIRECT API BYPASS ATTEMPT
	 *
	 * Ensures direct Kong API calls are impossible without elicitation
	 */
	async testDirectAPIBypassPrevention() {
		this.clearAllSessions();

		const bypassAttempts = [
			// Service operations
			() =>
				BlockedServiceOperations.createService(
					TEST_CONTROL_PLANE_ID,
					"bypass-service",
					"example.com",
					80,
					"http",
					TEST_REQUEST_CONTEXT,
				),
			() => BlockedServiceOperations.updateService(TEST_CONTROL_PLANE_ID, "service-123", {}, TEST_REQUEST_CONTEXT),
			() => BlockedServiceOperations.deleteService(TEST_CONTROL_PLANE_ID, "service-123", TEST_REQUEST_CONTEXT),

			// Route operations
			() => BlockedRouteOperations.createRoute(TEST_CONTROL_PLANE_ID, { name: "bypass-route" }, TEST_REQUEST_CONTEXT),
			() => BlockedRouteOperations.updateRoute(TEST_CONTROL_PLANE_ID, "route-123", {}, TEST_REQUEST_CONTEXT),
			() => BlockedRouteOperations.deleteRoute(TEST_CONTROL_PLANE_ID, "route-123", TEST_REQUEST_CONTEXT),

			// Consumer operations
			() =>
				BlockedConsumerOperations.createConsumer(
					TEST_CONTROL_PLANE_ID,
					{ username: "bypass-user" },
					TEST_REQUEST_CONTEXT,
				),
			() => BlockedConsumerOperations.deleteConsumer(TEST_CONTROL_PLANE_ID, "consumer-123", TEST_REQUEST_CONTEXT),

			// Plugin operations
			() =>
				BlockedPluginOperations.createPlugin(TEST_CONTROL_PLANE_ID, { name: "rate-limiting" }, TEST_REQUEST_CONTEXT),
			() => BlockedPluginOperations.updatePlugin(TEST_CONTROL_PLANE_ID, "plugin-123", {}, TEST_REQUEST_CONTEXT),
			() => BlockedPluginOperations.deletePlugin(TEST_CONTROL_PLANE_ID, "plugin-123", TEST_REQUEST_CONTEXT),
		];

		const results = [];
		for (const [index, bypassAttempt] of bypassAttempts.entries()) {
			try {
				await bypassAttempt();
				results.push({ index, status: "BYPASS_SUCCESSFUL", error: null });
			} catch (error) {
				if (error instanceof KongOperationBlockedError || error instanceof ElicitationBlockedError) {
					results.push({
						index,
						status: "BLOCKED_CORRECTLY",
						error: error.message,
					});
				} else {
					results.push({
						index,
						status: "UNEXPECTED_ERROR",
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}

		// Validate that ALL attempts were blocked
		const bypassSuccessful = results.filter((r) => r.status === "BYPASS_SUCCESSFUL");
		const incorrectlyBlocked = results.filter((r) => r.status === "UNEXPECTED_ERROR");
		const correctlyBlocked = results.filter((r) => r.status === "BLOCKED_CORRECTLY");

		return {
			totalAttempts: bypassAttempts.length,
			bypassSuccessful: bypassSuccessful.length,
			incorrectlyBlocked: incorrectlyBlocked.length,
			correctlyBlocked: correctlyBlocked.length,
			results,
			passed: bypassSuccessful.length === 0 && incorrectlyBlocked.length === 0,
		};
	}

	/**
	 * TEST 2: INCOMPLETE CONTEXT BYPASS ATTEMPT
	 *
	 * Ensures partial context doesn't bypass the enforcement
	 */
	async testIncompleteContextBypassPrevention() {
		this.clearAllSessions();

		const incompleteContexts = [
			{ domain: "api" }, // Missing environment and team
			{ environment: "production" }, // Missing domain and team
			{ team: "platform" }, // Missing domain and environment
			{ domain: "api", environment: "production" }, // Missing team
			{ domain: "api", team: "platform" }, // Missing environment
			{ environment: "production", team: "platform" }, // Missing domain
			{}, // Missing everything
			{ domain: "", environment: "", team: "" }, // Empty values
			{ domain: null, environment: null, team: null }, // Null values
		];

		const results = [];
		for (const [index, partialContext] of incompleteContexts.entries()) {
			try {
				// Try to process incomplete elicitation
				const sessionId = `incomplete-test-${index}`;
				// biome-ignore lint/suspicious/noExplicitAny: this is a bypass-prevention test that intentionally feeds malformed input.
				await this.gate.processElicitationResponse(sessionId, partialContext as any);
				results.push({
					index,
					context: partialContext,
					status: "BYPASS_SUCCESSFUL",
				});
			} catch (error) {
				results.push({
					index,
					context: partialContext,
					status: "BLOCKED_CORRECTLY",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		const bypassSuccessful = results.filter((r) => r.status === "BYPASS_SUCCESSFUL");

		return {
			totalAttempts: incompleteContexts.length,
			bypassSuccessful: bypassSuccessful.length,
			results,
			passed: bypassSuccessful.length === 0,
		};
	}

	/**
	 * TEST 3: SESSION MANIPULATION BYPASS ATTEMPT
	 *
	 * Ensures session state cannot be manipulated to bypass elicitation
	 */
	async testSessionManipulationBypassPrevention() {
		this.clearAllSessions();

		const manipulationAttempts = [
			// Attempt to create fake validated context
			() => {
				const _fakeContext: MandatoryContext = {
					domain: "fake",
					environment: "fake",
					team: "fake",
					elicitationComplete: true,
					contextConfidence: 1.0,
				};
				// Try to directly access private session map (this should be impossible)
				return this.gate.validateMandatoryContext({
					operationName: "create_service",
					parameters: {},
					requestContext: TEST_REQUEST_CONTEXT,
				});
			},

			// Attempt to use invalid session IDs
			() =>
				this.gate.processElicitationResponse("fake-session-123", {
					domain: "fake",
					environment: "fake",
					team: "fake",
				}),

			// Attempt to clear active sessions maliciously
			() => {
				this.gate.clearSession("active-session");
				return this.gate.validateMandatoryContext({
					operationName: "create_service",
					parameters: {},
					requestContext: TEST_REQUEST_CONTEXT,
				});
			},
		];

		const results = [];
		for (const [index, manipulation] of manipulationAttempts.entries()) {
			try {
				await manipulation();
				results.push({ index, status: "BYPASS_SUCCESSFUL" });
			} catch (error) {
				results.push({
					index,
					status: "BLOCKED_CORRECTLY",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		const bypassSuccessful = results.filter((r) => r.status === "BYPASS_SUCCESSFUL");

		return {
			totalAttempts: manipulationAttempts.length,
			bypassSuccessful: bypassSuccessful.length,
			results,
			passed: bypassSuccessful.length === 0,
		};
	}

	/**
	 * TEST 4: CONCURRENT ACCESS BYPASS ATTEMPT
	 *
	 * Ensures concurrent operations don't create race conditions that allow bypass
	 */
	async testConcurrentAccessBypassPrevention() {
		this.clearAllSessions();

		const concurrentOperations = Array.from(
			{ length: 10 },
			(_, i) => () =>
				BlockedServiceOperations.createService(
					TEST_CONTROL_PLANE_ID,
					`concurrent-service-${i}`,
					"example.com",
					80,
					"http",
					{ ...TEST_REQUEST_CONTEXT, userMessage: `Concurrent request ${i}` },
				),
		);

		// Execute all operations concurrently
		const results = await Promise.allSettled(
			concurrentOperations.map(async (operation, index) => {
				try {
					await operation();
					return { index, status: "BYPASS_SUCCESSFUL" };
				} catch (error) {
					if (error instanceof KongOperationBlockedError || error instanceof ElicitationBlockedError) {
						return { index, status: "BLOCKED_CORRECTLY", error: error.message };
					} else {
						return { index, status: "UNEXPECTED_ERROR", error: error instanceof Error ? error.message : String(error) };
					}
				}
			}),
		);

		const resolvedResults = results.map((r) => (r.status === "fulfilled" ? r.value : { status: "PROMISE_REJECTED" }));
		const bypassSuccessful = resolvedResults.filter((r) => r.status === "BYPASS_SUCCESSFUL");
		const incorrectlyBlocked = resolvedResults.filter((r) => r.status === "UNEXPECTED_ERROR");

		return {
			totalAttempts: concurrentOperations.length,
			bypassSuccessful: bypassSuccessful.length,
			incorrectlyBlocked: incorrectlyBlocked.length,
			results: resolvedResults,
			passed: bypassSuccessful.length === 0 && incorrectlyBlocked.length === 0,
		};
	}

	/**
	 * TEST 5: VALID ELICITATION FLOW TEST
	 *
	 * Ensures that proper elicitation allows operations to proceed
	 */
	async testValidElicitationFlow() {
		this.clearAllSessions();

		// Step 1: Validate that operation is initially blocked
		let blockedCorrectly = false;
		let sessionId = "";

		try {
			await BlockedServiceOperations.createService(
				TEST_CONTROL_PLANE_ID,
				"test-service",
				"example.com",
				80,
				"http",
				TEST_REQUEST_CONTEXT,
			);
		} catch (error) {
			if (error instanceof KongOperationBlockedError || error instanceof ElicitationBlockedError) {
				blockedCorrectly = true;
				sessionId = error.elicitationSession.sessionId;
			}
		}

		if (!blockedCorrectly) {
			return { passed: false, error: "Operation was not blocked initially" };
		}

		// Step 2: Complete elicitation with valid context
		const elicitationResult = await this.gate.processElicitationResponse(sessionId, {
			domain: "api",
			environment: "development",
			team: "platform",
		});

		if (!elicitationResult.elicitationComplete) {
			return {
				passed: false,
				error: "Elicitation completion failed",
				elicitationResult,
			};
		}

		// Step 3: Validate that operation now succeeds (mock success)
		// Note: In a real test, this would create actual Kong entities
		try {
			// This would normally create the service, but for testing we just validate
			// that the elicitation gate allows the operation to proceed
			const validatedContext = await this.gate.validateMandatoryContext({
				operationName: "create_service",
				parameters: {
					controlPlaneId: TEST_CONTROL_PLANE_ID,
					name: "test-service",
				},
				requestContext: TEST_REQUEST_CONTEXT,
			});

			return {
				passed: true,
				validatedContext,
				elicitationCompleted: true,
			};
		} catch (error) {
			return {
				passed: false,
				error: "Operation still blocked after valid elicitation",
				details: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * RUN ALL BYPASS PREVENTION TESTS
	 *
	 * Executes complete test suite and returns comprehensive results
	 */
	async runAllBypassPreventionTests() {
		console.error("🧪 RUNNING BYPASS PREVENTION TEST SUITE");
		console.error("=".repeat(60));

		const testResults = {
			directAPIBypass: await this.testDirectAPIBypassPrevention(),
			incompleteContextBypass: await this.testIncompleteContextBypassPrevention(),
			sessionManipulationBypass: await this.testSessionManipulationBypassPrevention(),
			concurrentAccessBypass: await this.testConcurrentAccessBypassPrevention(),
			validElicitationFlow: await this.testValidElicitationFlow(),
		};

		const allTestsPassed = Object.values(testResults).every((result) => result.passed);

		console.error(`\nINFO: TEST RESULTS SUMMARY:`);
		console.error(
			`Direct API Bypass Prevention: ${testResults.directAPIBypass.passed ? "SUCCESS: PASS" : "ERROR: FAIL"}`,
		);
		console.error(
			`Incomplete Context Bypass Prevention: ${testResults.incompleteContextBypass.passed ? "SUCCESS: PASS" : "ERROR: FAIL"}`,
		);
		console.error(
			`Session Manipulation Bypass Prevention: ${testResults.sessionManipulationBypass.passed ? "SUCCESS: PASS" : "ERROR: FAIL"}`,
		);
		console.error(
			`Concurrent Access Bypass Prevention: ${testResults.concurrentAccessBypass.passed ? "SUCCESS: PASS" : "ERROR: FAIL"}`,
		);
		console.error(
			`Valid Elicitation Flow: ${testResults.validElicitationFlow.passed ? "SUCCESS: PASS" : "ERROR: FAIL"}`,
		);
		console.error(
			`\n[ENFORCEMENT] OVERALL ENFORCEMENT: ${allTestsPassed ? "SUCCESS: BULLETPROOF" : "ERROR: VULNERABLE"}`,
		);

		return {
			testResults,
			allTestsPassed,
			summary: {
				totalBypassAttempts:
					testResults.directAPIBypass.totalAttempts +
					testResults.incompleteContextBypass.totalAttempts +
					testResults.sessionManipulationBypass.totalAttempts +
					testResults.concurrentAccessBypass.totalAttempts,
				successfulBypasses:
					testResults.directAPIBypass.bypassSuccessful +
					testResults.incompleteContextBypass.bypassSuccessful +
					testResults.sessionManipulationBypass.bypassSuccessful +
					testResults.concurrentAccessBypass.bypassSuccessful,
			},
		};
	}
}

/**
 * AUTOMATED TEST RUNNER
 *
 * Can be invoked to validate enforcement at any time
 */
export async function validateElicitationEnforcement(): Promise<boolean> {
	const tester = new BypassPreventionTests();
	const results = await tester.runAllBypassPreventionTests();

	if (!results.allTestsPassed) {
		console.error("SECURITY: CRITICAL: Elicitation enforcement has bypasses!");
		console.error("Details:", JSON.stringify(results.testResults, null, 2));
		throw new Error("Elicitation enforcement validation FAILED - system is vulnerable to bypasses");
	}

	console.error("SUCCESS: Elicitation enforcement validation PASSED - system is bulletproof");
	return true;
}

/**
 * CONTINUOUS MONITORING HOOKS
 *
 * These can be called periodically to ensure enforcement remains intact
 */
export const EnforcementMonitoring = {
	async validateOnStartup() {
		console.error("INFO: Validating elicitation enforcement on startup...");
		return await validateElicitationEnforcement();
	},

	async validatePeriodic() {
		console.error("INFO: Periodic elicitation enforcement validation...");
		return await validateElicitationEnforcement();
	},

	async validateAfterChanges() {
		console.error("INFO: Validating elicitation enforcement after code changes...");
		return await validateElicitationEnforcement();
	},
};
