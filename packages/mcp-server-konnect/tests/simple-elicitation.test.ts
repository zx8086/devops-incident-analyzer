// @ts-nocheck -- SimpleElicitationManager and SimpleElicitationTool are not yet implemented
/**
 * Comprehensive Test Suite for Simplified Universal Elicitation
 *
 * Tests the unified approach that works identically in Claude Code and Claude Desktop
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { SimpleElicitationTool } from "../src/tools/simple-elicitation-tool.js";
import { SimpleElicitationManager } from "../src/utils/simple-elicitation.js";

describe("Simplified Universal Elicitation", () => {
	let elicitationManager: SimpleElicitationManager;
	let elicitationTool: SimpleElicitationTool;

	beforeEach(() => {
		elicitationManager = new SimpleElicitationManager();
		elicitationTool = new SimpleElicitationTool();
	});

	describe("SimpleElicitationManager", () => {
		describe("Message Pattern Extraction", () => {
			test("should extract direct assignment patterns", async () => {
				const userMessage = "deploy with domain=api, environment=production, team=platform";

				const result = await elicitationManager.gatherKongContext({}, userMessage);

				expect(result.success).toBe(true);
				expect(result.context?.domain).toBe("api");
				expect(result.context?.environment).toBe("production");
				expect(result.context?.team).toBe("platform");
			});

			test("should handle mixed case and underscores", async () => {
				const userMessage = "domain=Shared_Services, environment=STAGING, team=Global_Platform_Engineering";

				const result = await elicitationManager.gatherKongContext({}, userMessage);

				expect(result.success).toBe(true);
				expect(result.context?.domain).toBe("shared-services");
				expect(result.context?.environment).toBe("staging");
				expect(result.context?.team).toBe("global-platform-engineering");
			});

			test("should normalize common environment variations", async () => {
				const messages = ["domain=api, environment=dev, team=platform", "domain=api, environment=prod, team=platform"];

				const result1 = await elicitationManager.gatherKongContext({}, messages[0]);
				const result2 = await elicitationManager.gatherKongContext({}, messages[1]);

				expect(result1.context?.environment).toBe("development");
				expect(result2.context?.environment).toBe("production");
			});

			test("should prefer provided context over extracted", async () => {
				const userMessage = "domain=extracted, environment=extracted, team=extracted";
				const provided = {
					domain: "provided",
					environment: "provided",
					team: "provided",
				};

				const result = await elicitationManager.gatherKongContext(provided, userMessage);

				expect(result.context?.domain).toBe("provided");
				expect(result.context?.environment).toBe("provided");
				expect(result.context?.team).toBe("provided");
			});

			test("should merge provided and extracted context", async () => {
				const userMessage = "domain=api, environment=production";
				const provided = { team: "platform" };

				const result = await elicitationManager.gatherKongContext(provided, userMessage);

				expect(result.context?.domain).toBe("api");
				expect(result.context?.environment).toBe("production");
				expect(result.context?.team).toBe("platform");
			});
		});

		describe("Missing Field Detection", () => {
			test("should identify all missing fields", async () => {
				const result = await elicitationManager.gatherKongContext({});

				expect(result.success).toBe(false);
				expect(result.error).toContain("Missing context requires elicitation");
			});

			test("should identify partial missing fields", async () => {
				const provided = { domain: "api" };

				const result = await elicitationManager.gatherKongContext(provided);

				expect(result.success).toBe(false);
				expect(result.error).toContain("Missing context requires elicitation");
			});

			test("should succeed when all fields provided", async () => {
				const provided = {
					domain: "api",
					environment: "production",
					team: "platform",
				};

				const result = await elicitationManager.gatherKongContext(provided);

				expect(result.success).toBe(true);
				expect(result.context).toEqual(provided);
			});
		});

		describe("Tag Generation", () => {
			test("should generate correct tags for different entity types", () => {
				const context = {
					domain: "api",
					environment: "production",
					team: "platform",
				};

				const serviceTags = elicitationManager.generateTags(context, "service");
				const routeTags = elicitationManager.generateTags(context, "route");
				const consumerTags = elicitationManager.generateTags(context, "consumer");
				const pluginTags = elicitationManager.generateTags(context, "plugin");

				// All should have mandatory tags
				[serviceTags, routeTags, consumerTags, pluginTags].forEach((tags) => {
					expect(tags).toContain("env-production");
					expect(tags).toContain("domain-api");
					expect(tags).toContain("team-platform");
					expect(tags).toHaveLength(5);
				});

				// Entity-specific tags
				expect(serviceTags).toContain("function-service");
				expect(routeTags).toContain("function-route");
				expect(consumerTags).toContain("function-consumer");
				expect(pluginTags).toContain("function-plugin");
			});

			test("should always generate exactly 5 tags", () => {
				const context = {
					domain: "api",
					environment: "production",
					team: "platform",
				};
				const entityTypes = ["service", "route", "consumer", "plugin", "certificate", "unknown"];

				entityTypes.forEach((entityType) => {
					const tags = elicitationManager.generateTags(context, entityType);
					expect(tags).toHaveLength(5);
				});
			});
		});
	});

	describe("SimpleElicitationTool", () => {
		describe("Context Gathering Integration", () => {
			test("should successfully gather context when provided complete info", async () => {
				const userMessage = "deploy Kong config with domain=api, environment=production, team=platform";

				const result = await elicitationTool.gatherKongContext(userMessage);

				expect(result.success).toBe(true);
				expect(result.context?.domain).toBe("api");
				expect(result.context?.environment).toBe("production");
				expect(result.context?.team).toBe("platform");
				expect(result.summary).toContain("SUCCESS");
				expect(result.summary).toContain("env-production");
			});

			test("should handle provided context parameter", async () => {
				const provided = {
					domain: "backend",
					environment: "staging",
					team: "devops",
				};

				const result = await elicitationTool.gatherKongContext("some message", provided);

				expect(result.success).toBe(true);
				expect(result.context).toEqual(provided);
			});

			test("should fail gracefully when context is missing", async () => {
				const result = await elicitationTool.gatherKongContext("deploy Kong config");

				expect(result.success).toBe(false);
				expect(result.error).toBeDefined();
				expect(result.summary).toContain("ERROR");
			});

			test("should handle mixed provided and extracted context", async () => {
				const userMessage = "environment=development, team=platform";
				const provided = { domain: "api" };

				const result = await elicitationTool.gatherKongContext(userMessage, provided);

				expect(result.success).toBe(true);
				expect(result.context?.domain).toBe("api");
				expect(result.context?.environment).toBe("development");
				expect(result.context?.team).toBe("platform");
			});
		});

		describe("Tag Generation", () => {
			test("should generate entity-specific tags", () => {
				const context = {
					domain: "platform",
					environment: "staging",
					team: "infrastructure",
				};

				const serviceTags = elicitationTool.generateEntityTags(context, "service");
				const routeTags = elicitationTool.generateEntityTags(context, "route");

				expect(serviceTags).toEqual([
					"env-staging",
					"domain-platform",
					"team-infrastructure",
					"function-service",
					"type-kong-entity",
				]);

				expect(routeTags).toEqual([
					"env-staging",
					"domain-platform",
					"team-infrastructure",
					"function-route",
					"type-kong-entity",
				]);
			});
		});
	});

	describe("Error Handling", () => {
		test("should handle empty user messages gracefully", async () => {
			const result = await elicitationManager.gatherKongContext({}, "");

			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});

		test("should handle malformed user messages", async () => {
			const malformed = "domain environment=production team";

			const result = await elicitationManager.gatherKongContext({}, malformed);

			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});

		test("should handle null/undefined inputs", async () => {
			const result = await elicitationTool.gatherKongContext(undefined, undefined);

			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});
	});

	describe("Real-world Scenarios", () => {
		test("should handle airline flight API scenario", async () => {
			const userMessage = "deploy flight booking API with domain=api, environment=production, team=travel-platform";

			const result = await elicitationTool.gatherKongContext(userMessage);

			expect(result.success).toBe(true);
			expect(result.context?.domain).toBe("api");
			expect(result.context?.environment).toBe("production");
			expect(result.context?.team).toBe("travel-platform");

			const serviceTags = elicitationTool.generateEntityTags(result.context!, "service");
			expect(serviceTags).toContain("env-production");
			expect(serviceTags).toContain("domain-api");
			expect(serviceTags).toContain("team-travel-platform");
		});

		test("should handle enterprise shared services scenario", async () => {
			const userMessage =
				"migrate enterprise config: domain=shared_services, environment=staging, team=global_platform_engineering";

			const result = await elicitationTool.gatherKongContext(userMessage);

			expect(result.success).toBe(true);
			expect(result.context?.domain).toBe("shared-services");
			expect(result.context?.environment).toBe("staging");
			expect(result.context?.team).toBe("global-platform-engineering");
		});

		test("should handle demo/test scenarios", async () => {
			const userMessage = "test deployment: domain=demo, environment=development, team=demo";

			const result = await elicitationTool.gatherKongContext(userMessage);

			expect(result.success).toBe(true);
			expect(result.context?.domain).toBe("demo");
			expect(result.context?.environment).toBe("development");
			expect(result.context?.team).toBe("demo");
		});
	});

	describe("Claude Desktop Compatibility", () => {
		test("should work with Claude Desktop direct provision pattern", async () => {
			// This simulates how Claude Desktop users would provide information
			const directProvision = "domain=infrastructure, environment=production, team=platform-engineering";

			const result = await elicitationTool.gatherKongContext(directProvision);

			expect(result.success).toBe(true);
			expect(result.context?.domain).toBe("infrastructure");
			expect(result.context?.environment).toBe("production");
			expect(result.context?.team).toBe("platform-engineering");
		});

		test("should generate Claude Desktop friendly error messages", async () => {
			const result = await elicitationTool.gatherKongContext("incomplete request");

			expect(result.success).toBe(false);
			expect(result.summary).toContain("ERROR");
			expect(result.error).toBeDefined();
		});
	});

	describe("Performance and Edge Cases", () => {
		test("should handle very long user messages efficiently", async () => {
			const longMessage =
				"deploy Kong configuration with lots of details and information but also domain=api, environment=production, team=platform at the end after many words ".repeat(
					100,
				);

			const result = await elicitationTool.gatherKongContext(longMessage);

			expect(result.success).toBe(true);
			expect(result.context?.domain).toBe("api");
		});

		test("should handle special characters in context values", async () => {
			const userMessage = "domain=api-gateway, environment=pre-production, team=platform_team";

			const result = await elicitationTool.gatherKongContext(userMessage);

			expect(result.success).toBe(true);
			expect(result.context?.domain).toBe("api-gateway");
			expect(result.context?.environment).toBe("pre-production");
			expect(result.context?.team).toBe("platform-team");
		});

		test("should handle case variations consistently", async () => {
			const variations = [
				"DOMAIN=API, ENVIRONMENT=PRODUCTION, TEAM=PLATFORM",
				"Domain=Api, Environment=Production, Team=Platform",
				"domain=api, environment=production, team=platform",
			];

			for (const variation of variations) {
				const result = await elicitationTool.gatherKongContext(variation);

				expect(result.success).toBe(true);
				expect(result.context?.domain).toBe("api");
				expect(result.context?.environment).toBe("production");
				expect(result.context?.team).toBe("platform");
			}
		});
	});
});
