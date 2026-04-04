// src/config/envMapping.ts

export const envVarMapping = {
	server: {
		name: "MCP_SERVER_NAME",
		version: "MCP_SERVER_VERSION",
		readOnlyQueryMode: "READ_ONLY_QUERY_MODE",
		maxQueryTimeout: "MCP_MAX_QUERY_TIMEOUT",
		maxResultsPerQuery: "MCP_MAX_RESULTS_PER_QUERY",
	},
	transport: {
		mode: "MCP_TRANSPORT",
		port: "MCP_PORT",
		host: "MCP_HOST",
		path: "MCP_PATH",
		sessionMode: "MCP_SESSION_MODE",
		idleTimeout: "MCP_IDLE_TIMEOUT",
		apiKey: "MCP_API_KEY",
		allowedOrigins: "MCP_ALLOWED_ORIGINS",
	},
	database: {
		connectionString: "COUCHBASE_URL",
		username: "COUCHBASE_USERNAME",
		password: "COUCHBASE_PASSWORD",
		bucketName: "COUCHBASE_BUCKET",
		defaultScope: "COUCHBASE_SCOPE",
		maxConnections: "COUCHBASE_MAX_CONNECTIONS",
		connectionTimeout: "COUCHBASE_CONNECTION_TIMEOUT",
	},
	logging: {
		level: "LOG_LEVEL",
		format: "LOG_FORMAT",
		includeMetadata: "LOG_INCLUDE_METADATA",
	},
	documentation: {
		enabled: "DOCS_ENABLED",
		baseDirectory: "DOCS_BASE_DIR",
		fileExtension: "DOCS_FILE_EXT",
	},
	playbooks: {
		enabled: "PLAYBOOKS_ENABLED",
		baseDirectory: "PLAYBOOKS_BASE_DIR",
		fileExtension: "PLAYBOOKS_FILE_EXT",
	},
};
