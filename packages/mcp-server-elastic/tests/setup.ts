// packages/mcp-server-elastic/tests/setup.ts
// SIO-865: bun test preload. The config module (src/config/index.ts) runs
// loadConfig() at import time and throws when neither ES_URL nor
// ELASTIC_DEPLOYMENTS is set -- which killed the whole suite offline before any
// test ran. Provide a dummy ES_URL so config loads, and force integration
// suites to skip (they are gated by shouldSkipIntegrationTests / SKIP_INTEGRATION_TESTS)
// so unit tests run offline without trying to reach a real cluster. Real
// integration runs set ES_URL + SKIP_INTEGRATION_TESTS=false in the environment,
// which overrides these defaults (only set when unset).
if (!Bun.env.ES_URL && !Bun.env.ELASTIC_DEPLOYMENTS) {
	process.env.ES_URL = "https://elastic.test.invalid:9243";
}
if (Bun.env.SKIP_INTEGRATION_TESTS === undefined) {
	process.env.SKIP_INTEGRATION_TESTS = "true";
}
