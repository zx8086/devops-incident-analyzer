// src/config/defaults.ts

import type { Config } from "./schemas";

export const defaultConfig: Config = {
	server: {
		name: "mcp-server-couchbase",
		version: "1.0.0",
		readOnlyQueryMode: true,
		maxQueryTimeout: 30000,
		maxResultsPerQuery: 1000,
	},
	transport: {
		mode: "stdio",
		port: 9082,
		host: "0.0.0.0",
		path: "/mcp",
		sessionMode: "stateless",
		idleTimeout: 255,
	},
	database: {
		connectionString: "couchbase://localhost",
		username: "Administrator",
		password: "password",
		bucketName: "default",
		defaultScope: "_default",
		connectionTimeout: 5000,
	},
	logging: {
		level: "info",
		format: "json",
		includeMetadata: true,
	},
	// Disabled by default (matches the schema default): with enabled: true every
	// deployment silently registered markdown docs resources against /tmp/docs.
	// Opt in with DOCS_ENABLED=true + DOCS_BASE_DIR.
	documentation: {
		enabled: false,
		baseDirectory: "/tmp/docs",
		fileExtension: ".md",
	},
	// SIO-1177: disabled by default (matches the schema default). No playbook
	// markdown ships in the package -- the enabled:true default made every boot
	// warn "No playbook directory found". Couchbase incident procedures live as
	// gitagent skills on the capella-agent instead. Opt in with
	// PLAYBOOKS_ENABLED=true + PLAYBOOKS_BASE_DIR.
	playbooks: {
		enabled: false,
		baseDirectory: "./playbook",
		fileExtension: ".md",
	},
};
