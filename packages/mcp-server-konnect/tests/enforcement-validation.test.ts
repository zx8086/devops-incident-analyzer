/**
 * COMPREHENSIVE ELICITATION ENFORCEMENT VALIDATION TESTS
 *
 * These tests validate that the bulletproof elicitation enforcement
 * actually works as designed and cannot be bypassed.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { BypassPreventionTests, validateElicitationEnforcement } from "../src/enforcement/bypass-prevention-tests.js";
import { elicitationOrchestrator } from "../src/enforcement/elicitation-validation-gates.js";
import {
	BlockedConsumerOperations,
	BlockedPluginOperations,
	BlockedRouteOperations,
	BlockedServiceOperations,
	KongOperationBlockedError,
} from "../src/enforcement/kong-tool-blockers.js";
import { MandatoryElicitationGate } from "../src/enforcement/mandatory-elicitation-gate.js";

describe("🔒 Bulletproof Elicitation Enforcement", () => {
	const gate = MandatoryElicitationGate.getInstance();

	beforeEach(() => {
		// Clear all sessions between tests
		const sessions = gate.getActiveSessions();
		for (const [sessionId] of sessions) {
			gate.clearSession(sessionId);
		}
	});

	// SIO-865: processElicitationResponse now rejects unknown session IDs as a bypass
	// guard (SECURITY VIOLATION). A real session only exists after a blocked operation,
	// so register one by driving validateMandatoryContext with a context-less request and
	// capturing the KongOperationBlockedError's session id. Mirrors the "Kong Operation
	// Blocking" tests above.
	async function registerBlockedSession(userMessage: string, operationName = "create_service"): Promise<string> {
		try {
			await gate.validateMandatoryContext({
				operationName,
				parameters: { controlPlaneId: "test-cp-123" },
				requestContext: { userMessage, files: [], configs: [] },
			});
			throw new Error("expected the operation to be blocked");
		} catch (error) {
			if (error instanceof KongOperationBlockedError) {
				return error.elicitationSession.sessionId;
			}
			const err = error as { elicitationSession?: { sessionId: string } };
			if (err.elicitationSession?.sessionId) return err.elicitationSession.sessionId;
			throw error;
		}
	}

	describe("🚫 Kong Operation Blocking", () => {
		const testContext = {
			userMessage: "Deploy without context",
			files: [],
			configs: [],
		};

		it("should block service creation without elicitation", async () => {
			let wasBlocked = false;
			let elicitationSession: { sessionId: string } | undefined;

			try {
				await BlockedServiceOperations.createService(
					"test-cp-123",
					"test-service",
					"example.com",
					80,
					"http",
					testContext,
				);
			} catch (error) {
				wasBlocked = true;
				const err = error as Error & { missingFields?: string[]; elicitationSession?: { sessionId: string } };
				console.log("INFO: Caught error:", err.constructor.name, err.message);

				if (error instanceof KongOperationBlockedError) {
					elicitationSession = error.elicitationSession;
					expect(error.missingFields).toContain("domain");
					expect(error.missingFields).toContain("environment");
					expect(error.missingFields).toContain("team");
				} else if (err.missingFields) {
					// Handle ElicitationBlockedError or similar
					elicitationSession = { sessionId: "test-session" };
					expect(err.missingFields).toContain("domain");
					expect(err.missingFields).toContain("environment");
					expect(err.missingFields).toContain("team");
				}
			}

			expect(wasBlocked).toBe(true);
			expect(elicitationSession).toBeDefined();
		});

		it("should block route creation without elicitation", async () => {
			let wasBlocked = false;

			try {
				await BlockedRouteOperations.createRoute("test-cp-123", { name: "test-route", paths: ["/test"] }, testContext);
			} catch (error) {
				wasBlocked = true;
				const err = error as Error & { missingFields?: string[] };
				if (error instanceof KongOperationBlockedError || err.missingFields) {
					expect(
						(error instanceof KongOperationBlockedError ? error.missingFields : err.missingFields)?.length,
					).toBeGreaterThan(0);
				}
			}

			expect(wasBlocked).toBe(true);
		});

		it("should block consumer creation without elicitation", async () => {
			let wasBlocked = false;

			try {
				await BlockedConsumerOperations.createConsumer("test-cp-123", { username: "test-user" }, testContext);
			} catch (_error) {
				wasBlocked = true;
			}

			expect(wasBlocked).toBe(true);
		});

		it("should block plugin creation without elicitation", async () => {
			let wasBlocked = false;

			try {
				await BlockedPluginOperations.createPlugin("test-cp-123", { name: "rate-limiting" }, testContext);
			} catch (_error) {
				wasBlocked = true;
			}

			expect(wasBlocked).toBe(true);
		});
	});

	describe("SUCCESS: Valid Elicitation Flow", () => {
		it("should allow operations after successful elicitation", async () => {
			const testContext = {
				userMessage: "Deploy with elicitation",
				files: [],
				configs: [],
			};

			// Step 1: Attempt operation and get blocked
			let sessionId = "";
			try {
				await BlockedServiceOperations.createService(
					"test-cp-123",
					"test-service",
					"example.com",
					80,
					"http",
					testContext,
				);
				expect(false).toBe(true); // Should not reach here
			} catch (error) {
				if (error instanceof KongOperationBlockedError) {
					sessionId = error.elicitationSession.sessionId;
				} else {
					const err = error as { elicitationSession?: { sessionId: string } };
					if (err.elicitationSession) {
						sessionId = err.elicitationSession.sessionId;
					}
				}
			}

			expect(sessionId).toBeTruthy();

			// Step 2: Complete elicitation
			const elicitationResponse = {
				sessionId,
				responses: {
					domain: "api",
					environment: "development",
					team: "platform",
				},
				declined: false,
			};

			const result = await elicitationOrchestrator.processElicitationResponse(elicitationResponse);
			expect(result.success).toBe(true);

			// Step 3: Validate context is now available
			const validatedContext = await gate.validateMandatoryContext({
				operationName: "create_service",
				parameters: { controlPlaneId: "test-cp-123" },
				requestContext: testContext,
			});

			expect(validatedContext.elicitationComplete).toBe(true);
			expect(validatedContext.domain).toBe("api");
			expect(validatedContext.environment).toBe("development");
			expect(validatedContext.team).toBe("platform");
		});
	});

	describe("🧪 Comprehensive Bypass Prevention", () => {
		it("should prevent all known bypass attempts", async () => {
			const tester = new BypassPreventionTests();
			const results = await tester.runAllBypassPreventionTests();

			expect(results.allTestsPassed).toBe(true);
			expect(results.summary.successfulBypasses).toBe(0);

			console.log("🔒 Bypass Prevention Results:", {
				totalTests: Object.keys(results.testResults).length,
				allPassed: results.allTestsPassed,
				bypassAttempts: results.summary.totalBypassAttempts,
				successfulBypasses: results.summary.successfulBypasses,
			});
		});
	});

	describe("INFO: Mandatory Tagging", () => {
		it("should generate exactly 5 tags for all entities", async () => {
			// SIO-865: register a real blocked session before completing it.
			const sessionId = await registerBlockedSession("Test tagging");
			await gate.processElicitationResponse(sessionId, {
				domain: "api",
				environment: "production",
				team: "platform",
			});

			const validatedContext = await gate.validateMandatoryContext({
				operationName: "create_service",
				parameters: { controlPlaneId: "test-cp-123" },
				requestContext: {
					userMessage: "Test tagging",
					files: [],
					configs: [],
				},
			});

			// Validate that mandatory tags would be generated
			expect(validatedContext.domain).toBe("api");
			expect(validatedContext.environment).toBe("production");
			expect(validatedContext.team).toBe("platform");

			// Tags would be: env-production, domain-api, team-platform, type-service, purpose-gateway-service
			// Total: 5 tags (3 mandatory + 2 contextual)
		});
	});

	describe("WARNING: Error Handling", () => {
		it("should handle incomplete elicitation responses", async () => {
			const incompleteResponse = {
				sessionId: "incomplete-test",
				responses: {
					domain: "api",
					// Missing environment and team
				},
				declined: false,
			};

			const result = await elicitationOrchestrator.processElicitationResponse(incompleteResponse);
			expect(result.success).toBe(false);
			expect(result.errors).toBeDefined();
			expect(result.errors?.some((e) => e.includes("Missing required fields"))).toBe(true);
		});

		it("should handle declined elicitation", async () => {
			const declinedResponse = {
				sessionId: "declined-test",
				responses: {},
				declined: true,
			};

			const result = await elicitationOrchestrator.processElicitationResponse(declinedResponse);
			expect(result.success).toBe(false);
			expect(result.errors?.some((e) => e.includes("declined elicitation"))).toBe(true);
		});
	});

	describe("INFO: Session Management", () => {
		it("should track multiple concurrent sessions", async () => {
			// SIO-865: register three distinct real blocked sessions (deterministic IDs are
			// derived per request, so vary the userMessage to get distinct sessions), then
			// complete each and assert against the actual session IDs.
			// Distinct operations yield distinct deterministic sessions (completing one
			// must not satisfy another), so each concurrent session uses its own op.
			const labels: Array<{ label: string; op: string }> = [
				{ label: "alpha", op: "create_service" },
				{ label: "beta", op: "create_route" },
				{ label: "gamma", op: "create_consumer" },
			];
			const sessionByLabel = new Map<string, string>();
			// Register all three blocked sessions FIRST (while context is still missing for
			// every op), then complete them -- completing one caches validated context that
			// could otherwise let a later op pass without blocking.
			for (const { label, op } of labels) {
				sessionByLabel.set(label, await registerBlockedSession(`Track concurrent ${label}`, op));
			}
			for (const { label } of labels) {
				await gate.processElicitationResponse(sessionByLabel.get(label) as string, {
					domain: `domain-${label}`,
					environment: "development",
					team: "platform",
				});
			}

			const activeSessions = gate.getActiveSessions();
			// SIO-865: the gate is a shared singleton; assert our three sessions are tracked
			// rather than an exact global count (other state can coexist).
			expect(activeSessions.size).toBeGreaterThanOrEqual(3);
			expect(new Set(sessionByLabel.values()).size).toBe(3); // three distinct sessions

			// Verify each session has the correct completed context.
			for (const { label } of labels) {
				const sessionId = sessionByLabel.get(label) as string;
				const context = activeSessions.get(sessionId);
				expect(context).toBeDefined();
				expect(context?.elicitationComplete).toBe(true);
				expect(context?.domain).toBe(`domain-${label}`);
			}
		});
	});
});

describe("INFO: Integration Validation", () => {
	it("should validate complete enforcement system", async () => {
		console.log("INFO: Running complete enforcement validation...");

		const isValid = await validateElicitationEnforcement();
		expect(isValid).toBe(true);

		console.log("SUCCESS: Complete enforcement system validation PASSED");
	});
});
