// src/telemetry/tracing.ts
// Bridge to @devops-agent/observability tracing initialization.
// Tracing is a no-op in tests and when LANGSMITH_API_KEY is missing.

export async function initializeTracing(): Promise<void> {
	// Reserved for OTel/LangSmith wiring later. The other MCP servers also keep
	// this empty in their initial scaffolding; tracing comes online via env vars
	// recognized by @devops-agent/observability.
}
