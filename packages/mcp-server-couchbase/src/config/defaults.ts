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
		maxConnections: 10,
		connectionTimeout: 5000,
	},
	logging: {
		level: "info",
		format: "json",
		includeMetadata: true,
	},
	documentation: {
		enabled: true,
		baseDirectory: "/tmp/docs",
		fileExtension: ".md",
	},
	playbooks: {
		enabled: true,
		baseDirectory: "./playbook",
		fileExtension: ".md",
	},
};
