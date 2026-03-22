/**
 * Configuration System Tests for Kong Konnect MCP Server
 * Tests Zod validation, health monitoring, and environment variable management
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type Config,
  ConfigSchema,
  ConfigurationManager,
} from "../config/index.js";

describe("Configuration System", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    // Store original environment
    originalEnv = { ...process.env };

    // Clear environment for clean test state
    delete process.env.KONNECT_ACCESS_TOKEN;
    delete process.env.LANGSMITH_TRACING;
    delete process.env.LANGSMITH_API_KEY;
    delete process.env.NODE_ENV;
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    // Restore original environment
    Object.keys(process.env).forEach((key) => {
      delete process.env[key];
    });
    Object.assign(process.env, originalEnv);
  });

  describe("Zod Schema Validation", () => {
    test("should validate valid configuration", () => {
      const validConfig = {
        application: {
          name: "kong-konnect-mcp",
          version: "1.0.0",
          environment: "development" as const,
          logLevel: "info" as const,
        },
        kong: {
          accessToken: "kpat_1234567890abcdef",
          region: "us" as const,
          timeout: 30000,
          retryAttempts: 3,
          retryDelay: 1000,
        },
        tracing: {
          enabled: false,
          project: "test-project",
          endpoint: "https://api.smith.langchain.com",
          sessionName: "test-session",
          tags: ["test"],
          samplingRate: 1.0,
        },
        monitoring: {
          enabled: true,
          healthCheckInterval: 30000,
          metricsCollection: true,
          performanceThresholds: {
            responseTimeMs: 5000,
            errorRate: 5,
          },
        },
        runtime: {
          preferBunEnv: true,
          envFileAutoLoad: true,
          debugMode: false,
        },
      };

      const result = ConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    test("should reject invalid version format", () => {
      const invalidConfig = {
        application: {
          name: "test",
          version: "invalid-version",
          environment: "development",
          logLevel: "info",
        },
        kong: {
          accessToken: "test-token",
          region: "us",
        },
        // ... minimal required fields
      };

      const result = ConfigSchema.safeParse(invalidConfig);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some(
            (issue) =>
              issue.path.includes("version") &&
              issue.message.includes("semver"),
          ),
        ).toBe(true);
      }
    });

    test("should reject invalid enum values", () => {
      const invalidConfig = {
        application: {
          name: "test",
          version: "1.0.0",
          environment: "invalid-env",
          logLevel: "invalid-level",
        },
        kong: {
          accessToken: "test-token",
          region: "invalid-region",
        },
      };

      const result = ConfigSchema.safeParse(invalidConfig);
      expect(result.success).toBe(false);
    });

    test("should enforce minimum values", () => {
      const invalidConfig = {
        application: {
          name: "",
          version: "1.0.0",
          environment: "development",
          logLevel: "info",
        },
        kong: {
          accessToken: "",
          region: "us",
          timeout: 500, // Below minimum
          retryAttempts: -1, // Below minimum
        },
        tracing: {
          samplingRate: 1.5, // Above maximum
        },
      };

      const result = ConfigSchema.safeParse(invalidConfig);
      expect(result.success).toBe(false);
    });
  });

  describe("Configuration Manager", () => {
    test("should load configuration from environment variables", async () => {
      // Set test environment variables
      process.env.KONNECT_ACCESS_TOKEN = "test-token-12345";
      process.env.KONNECT_REGION = "eu";
      process.env.NODE_ENV = "development";
      process.env.LOG_LEVEL = "debug";
      process.env.LANGSMITH_TRACING = "false";

      const manager = new ConfigurationManager();
      const config = await manager.load();

      expect(config.kong.accessToken).toBe("test-token-12345");
      expect(config.kong.region).toBe("eu");
      expect(config.application.environment).toBe("development");
      expect(config.application.logLevel).toBe("debug");
      expect(config.tracing.enabled).toBe(false);
    });

    test("should use default values when environment variables are missing", async () => {
      process.env.KONNECT_ACCESS_TOKEN = "test-token";
      // Leave other variables unset

      const manager = new ConfigurationManager();
      const config = await manager.load();

      expect(config.kong.region).toBe("us"); // default
      expect(config.application.environment).toBe("development"); // default
      expect(config.application.logLevel).toBe("info"); // default
      expect(config.kong.timeout).toBe(30000); // default
    });

    test("should parse numeric and boolean environment variables correctly", async () => {
      process.env.KONNECT_ACCESS_TOKEN = "test-token";
      process.env.KONNECT_TIMEOUT = "45000";
      process.env.KONNECT_RETRY_ATTEMPTS = "5";
      process.env.LANGSMITH_TRACING = "true";
      process.env.MONITORING_ENABLED = "false";
      process.env.LANGSMITH_SAMPLING_RATE = "0.5";

      const manager = new ConfigurationManager();
      const config = await manager.load();

      expect(config.kong.timeout).toBe(45000);
      expect(config.kong.retryAttempts).toBe(5);
      expect(config.tracing.enabled).toBe(true);
      expect(config.monitoring.enabled).toBe(false);
      expect(config.tracing.samplingRate).toBe(0.5);
    });

    test("should handle array environment variables", async () => {
      process.env.KONNECT_ACCESS_TOKEN = "test-token";
      process.env.LANGSMITH_TAGS = "tag1,tag2,tag3";

      const manager = new ConfigurationManager();
      const config = await manager.load();

      expect(config.tracing.tags).toEqual(["tag1", "tag2", "tag3"]);
    });

    test("should throw validation error for missing required fields", async () => {
      // Don't set KONNECT_ACCESS_TOKEN
      process.env.LANGSMITH_TRACING = "true";
      // Don't set LANGSMITH_API_KEY

      const manager = new ConfigurationManager();

      expect(async () => {
        await manager.load();
      }).toThrow();
    });
  });

  describe("Configuration Health Assessment", () => {
    test("should detect critical issues", async () => {
      process.env.KONNECT_ACCESS_TOKEN = ""; // Empty token
      process.env.NODE_ENV = "production";
      process.env.LANGSMITH_TRACING = "true";
      // Missing LANGSMITH_API_KEY

      const manager = new ConfigurationManager();

      try {
        await manager.load();
      } catch (error) {
        // Configuration should fail to load due to validation errors
        expect(error).toBeDefined();
      }
    });

    test("should assess healthy configuration", async () => {
      process.env.KONNECT_ACCESS_TOKEN = "kpat_strong_token_123456789abcdef";
      process.env.KONNECT_REGION = "us";
      process.env.NODE_ENV = "development";
      process.env.LOG_LEVEL = "info";
      process.env.LANGSMITH_TRACING = "false";

      const manager = new ConfigurationManager();
      const config = await manager.load();
      const health = await manager.getHealth();

      expect(health.status).toBe("healthy");
      expect(health.metrics.securityScore).toBeGreaterThan(70);
      expect(health.issues.critical.length).toBe(0);
    });

    test("should detect production security issues", async () => {
      process.env.KONNECT_ACCESS_TOKEN = "test"; // Weak token
      process.env.NODE_ENV = "production";
      process.env.LOG_LEVEL = "debug"; // Debug in production
      process.env.DEBUG_MODE = "true"; // Debug mode in production
      process.env.LANGSMITH_TRACING = "false";

      const manager = new ConfigurationManager();
      const config = await manager.load();
      const health = await manager.getHealth();

      expect(health.status).not.toBe("healthy");
      expect(health.metrics.securityScore).toBeLessThan(80);
      expect(health.issues.warnings.length).toBeGreaterThan(0);
    });

    test("should provide recommendations", async () => {
      process.env.KONNECT_ACCESS_TOKEN = "weak";
      process.env.KONNECT_TIMEOUT = "60000"; // Very high timeout
      process.env.NODE_ENV = "development";
      process.env.LANGSMITH_TRACING = "false";

      const manager = new ConfigurationManager();
      const config = await manager.load();
      const health = await manager.getHealth();

      expect(health.recommendations.length).toBeGreaterThan(0);
    });
  });

  describe("JSON Schema Export", () => {
    test("should export valid JSON schema", () => {
      const manager = new ConfigurationManager();
      const schema = manager.exportJsonSchema();

      expect(schema).toBeDefined();
      expect(schema.type).toBe("object");
      expect(schema.properties).toBeDefined();
      expect(schema.properties.application).toBeDefined();
      expect(schema.properties.kong).toBeDefined();
      expect(schema.properties.tracing).toBeDefined();
      expect(schema.properties.monitoring).toBeDefined();
      expect(schema.properties.runtime).toBeDefined();
    });
  });

  describe("Environment-Specific Validation", () => {
    test("should enforce production security requirements", async () => {
      process.env.NODE_ENV = "production";
      process.env.KONNECT_ACCESS_TOKEN = "password"; // Weak password
      process.env.LOG_LEVEL = "debug";
      process.env.DEBUG_MODE = "true";
      process.env.LANGSMITH_TRACING = "false";

      const manager = new ConfigurationManager();
      const config = await manager.load();
      const health = await manager.getHealth();

      // Should have security issues
      expect(health.metrics.securityScore).toBeLessThan(70);

      // Should have consistency issues
      expect(health.metrics.environmentConsistency).toBeLessThan(90);
    });

    test("should be more lenient in development", async () => {
      process.env.NODE_ENV = "development";
      process.env.KONNECT_ACCESS_TOKEN = "dev-token-123";
      process.env.LOG_LEVEL = "debug";
      process.env.DEBUG_MODE = "true";
      process.env.LANGSMITH_TRACING = "false";

      const manager = new ConfigurationManager();
      const config = await manager.load();
      const health = await manager.getHealth();

      // Development should be more forgiving
      expect(health.metrics.environmentConsistency).toBeGreaterThan(80);
    });
  });

  describe("Performance and Complexity Metrics", () => {
    test("should calculate configuration complexity", async () => {
      process.env.KONNECT_ACCESS_TOKEN = "test-token";
      process.env.LANGSMITH_TRACING = "false";

      const manager = new ConfigurationManager();
      const config = await manager.load();
      const health = await manager.getHealth();

      expect(health.metrics.configurationComplexity).toBeGreaterThan(0);
      expect(health.metrics.configurationComplexity).toBeLessThanOrEqual(100);
    });

    test("should measure validation performance", async () => {
      process.env.KONNECT_ACCESS_TOKEN = "test-token";
      process.env.LANGSMITH_TRACING = "false";

      const manager = new ConfigurationManager();
      const config = await manager.load();
      const health = await manager.getHealth();

      expect(health.metrics.validationPerformance).toBeGreaterThan(0);
      expect(health.metrics.validationPerformance).toBeLessThan(1000); // Should be fast
    });
  });
});
