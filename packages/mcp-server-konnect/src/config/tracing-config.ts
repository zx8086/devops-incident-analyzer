/* src/config/tracing-config.ts */
import { getEnvVar, getEnvVarWithDefault } from "../utils/env.js";
import { configManager, getConfiguration } from "./index.js";
export interface TracingConfig {
  enabled: boolean;
  apiKey?: string;
  project?: string;
  endpoint?: string;
  sessionName?: string;
  tags: string[];
  samplingRate: number;
}
export function loadTracingConfig(): TracingConfig {
  try {
    const config = getConfiguration();
    return {
      enabled: config.tracing.enabled,
      apiKey: config.tracing.apiKey,
      project: config.tracing.project,
      endpoint: config.tracing.endpoint,
      sessionName: config.tracing.sessionName,
      tags: config.tracing.tags,
      samplingRate: config.tracing.samplingRate,
    };
  } catch {
    const config: TracingConfig = {
      enabled:
        getEnvVar("LANGCHAIN_TRACING_V2") === "true" ||
        getEnvVar("LANGSMITH_TRACING") === "true",
      apiKey: getEnvVar("LANGCHAIN_API_KEY") || getEnvVar("LANGSMITH_API_KEY"),
      project:
        getEnvVarWithDefault("LANGCHAIN_PROJECT", null) ||
        getEnvVarWithDefault("LANGSMITH_PROJECT", "konnect-mcp-server"),
      endpoint:
        getEnvVarWithDefault("LANGCHAIN_ENDPOINT", null) ||
        getEnvVarWithDefault(
          "LANGSMITH_ENDPOINT",
          "https://api.smith.langchain.com",
        ),
      sessionName: getEnvVarWithDefault("LANGSMITH_SESSION", "mcp-session"),
      tags: getEnvVar("LANGSMITH_TAGS")?.split(",") || [
        "mcp-server",
        "kong-konnect",
      ],
      samplingRate: parseFloat(
        getEnvVarWithDefault("LANGSMITH_SAMPLING_RATE", "1.0"),
      ),
    };
    return config;
  }
}
export async function initializeEnvironment(): Promise<void> {
  const { initializeEnvironment: initEnv } = await import("../utils/env.js");
  return await initEnv();
}
export function validateTracingConfig(config: TracingConfig): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (config.enabled) {
    if (!config.apiKey || config.apiKey.trim() === "") {
      errors.push("LANGSMITH_API_KEY is required when tracing is enabled");
    }
    if (!config.project || config.project.trim() === "") {
      errors.push("LANGSMITH_PROJECT is required when tracing is enabled");
    }
    if (config.samplingRate < 0 || config.samplingRate > 1) {
      errors.push("LANGSMITH_SAMPLING_RATE must be between 0.0 and 1.0");
    }

    if (config.apiKey && !config.apiKey.startsWith("lsv2_")) {
    }
  }
  return {
    isValid: errors.length === 0,
    error,
  };
}
export async function getTracingConfig(): Promise<TracingConfig> {
  try {
    const config = await configManager.load();
    return {
      enabled: config.tracing.enabled,
      apiKey: config.tracing.apiKey,
      project: config.tracing.project,
      endpoint: config.tracing.endpoint,
      sessionName: config.tracing.sessionName,
      tags: config.tracing.tags,
      samplingRate: config.tracing.samplingRate,
    };
  } catch (error) {
    throw error;
  }
}
export async function getRuntimeInfo(): Promise<{
  runtime: "bun" | "node" | "unknown";
  version: string;
  envSource: "Bun.env" | "process.env";
  autoEnvLoading: boolean;
}> {
  const envModule = await import("../utils/env.js");
  const { getRuntimeInfo: getRuntimeInfoFromEnv } = envModule;
  return getRuntimeInfoFromEnv();
}
