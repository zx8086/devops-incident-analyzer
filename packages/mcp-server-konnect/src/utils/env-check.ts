#!/usr/bin/env bun

/**
 * Environment variable diagnostic utility for Bun + Node.js
 * Run with: bun run src/utils/env-check.ts
 */

import { getEnvVar, getRuntimeInfo, initializeEnvironment } from "./env.js";

async function main() {
	console.error("INFO: Environment Variable Diagnostic Tool\n");

	// Initialize environment
	console.error("1. Initializing environment...");
	await initializeEnvironment();

	// Show runtime information
	console.error("\n2. Runtime Information:");
	const runtimeInfo = getRuntimeInfo();
	console.table(runtimeInfo);

	// Test environment variables
	console.error("\n3. Environment Variable Tests:");

	const testVars = [
		"LANGSMITH_TRACING",
		"LANGSMITH_API_KEY",
		"LANGSMITH_PROJECT",
		"LANGSMITH_ENDPOINT",
		"KONNECT_ACCESS_TOKEN",
		"KONNECT_REGION",
		"NODE_ENV",
	];

	const results: Record<string, any> = {};

	for (const varName of testVars) {
		const bunValue = typeof Bun !== "undefined" ? Bun.env[varName] : undefined;
		const processValue = process.env[varName];
		const universalValue = getEnvVar(varName);

		results[varName] = {
			"Bun.env": bunValue || "(undefined)",
			"process.env": processValue || "(undefined)",
			"getEnvVar()": universalValue || "(undefined)",
			Status: universalValue ? "SUCCESS:" : "ERROR:",
		};
	}

	console.table(results);

	// Test .env file detection
	console.error("\n4. .env File Detection:");
	try {
		const fs = await import("node:fs/promises");
		const envExists = await fs
			.access(".env")
			.then(() => true)
			.catch(() => false);
		const envContent = envExists ? await fs.readFile(".env", "utf-8") : null;

		console.error(`INFO: .env file exists: ${envExists ? "SUCCESS:" : "ERROR:"}`);
		if (envExists && envContent) {
			const lines = envContent.split("\n").filter((line) => line.trim() && !line.startsWith("#"));
			console.error(`INFO: Environment variables in .env: ${lines.length}`);
			lines.forEach((line) => {
				const [key] = line.split("=");
				console.error(`  - ${key}`);
			});
		}
	} catch (error) {
		console.error(`ERROR: Error checking .env file: ${error}`);
	}

	// Performance comparison
	console.error("\n5. Performance Comparison:");
	const iterations = 10000;

	if (typeof Bun !== "undefined") {
		const startBun = Bun.nanoseconds();
		for (let i = 0; i < iterations; i++) {
			Bun.env.LANGSMITH_TRACING;
		}
		const bunTime = (Bun.nanoseconds() - startBun) / 1_000_000;

		const startProcess = Bun.nanoseconds();
		for (let i = 0; i < iterations; i++) {
			process.env.LANGSMITH_TRACING;
		}
		const processTime = (Bun.nanoseconds() - startProcess) / 1_000_000;

		const startUniversal = Bun.nanoseconds();
		for (let i = 0; i < iterations; i++) {
			getEnvVar("LANGSMITH_TRACING");
		}
		const universalTime = (Bun.nanoseconds() - startUniversal) / 1_000_000;

		console.error(`Bun.env (${iterations} calls): ${bunTime.toFixed(2)}ms`);
		console.error(`process.env (${iterations} calls): ${processTime.toFixed(2)}ms`);
		console.error(`getEnvVar() (${iterations} calls): ${universalTime.toFixed(2)}ms`);
		console.error(`Speed improvement: ${(processTime / bunTime).toFixed(1)}x faster with Bun.env`);
	}

	// Recommendations
	console.error("\n6. Recommendations:");
	const hasLangSmithTracing = getEnvVar("LANGSMITH_TRACING");
	const hasLangSmithApiKey = getEnvVar("LANGSMITH_API_KEY");
	const hasKonnectToken = getEnvVar("KONNECT_ACCESS_TOKEN");

	if (!hasLangSmithTracing) {
		console.error("WARNING:  LANGSMITH_TRACING not found - add to .env file");
	}
	if (!hasLangSmithApiKey) {
		console.error("WARNING:  LANGSMITH_API_KEY not found - add to .env file");
	}
	if (!hasKonnectToken) {
		console.error("WARNING:  KONNECT_ACCESS_TOKEN not found - add to .env file");
	}

	if (hasLangSmithTracing && hasLangSmithApiKey && hasKonnectToken) {
		console.error("SUCCESS: All critical environment variables found!");
	}

	console.error("\nINFO: Environment diagnostic complete!");
}

if (import.meta.main) {
	main().catch(console.error);
}
