/* src/config.ts */

import { z } from "zod";

const ServerConfigSchema = z.object({
	name: z.string().min(1),
	version: z.string().min(1),
	readOnlyQueryMode: z.boolean().default(true),
	maxQueryTimeout: z.number().min(1000).max(300000).default(30000),
	maxResultsPerQuery: z.number().min(1).max(10000).default(1000),
});

const TransportConfigSchema = z.object({
	mode: z.enum(["stdio", "http", "both"]).default("stdio"),
	port: z.number().min(1).max(65535).default(9082),
	host: z.string().min(1).default("0.0.0.0"),
	path: z.string().min(1).default("/mcp"),
	sessionMode: z.enum(["stateless", "stateful"]).default("stateless"),
	idleTimeout: z.number().min(1).default(255),
	apiKey: z.string().optional(),
	allowedOrigins: z.string().optional(),
});

const DatabaseConfigSchema = z.object({
	connectionString: z.string().url(),
	username: z.string().min(1),
	password: z.string().min(1),
	bucketName: z.string().min(1),
	defaultScope: z.string().default("_default"),
	maxConnections: z.number().min(1).max(100).default(10),
	connectionTimeout: z.number().min(1000).max(30000).default(5000),
});

const LoggingConfigSchema = z.object({
	level: z.enum(["debug", "info", "warn", "error"]).default("info"),
	format: z.enum(["json", "text"]).default("json"),
	includeMetadata: z.boolean().default(true),
});

const DocumentationConfigSchema = z.object({
	enabled: z.boolean().default(false),
	baseDirectory: z.string().min(1).default("/tmp/docs"),
	fileExtension: z.string().default(".md"),
});

const PlaybooksConfigSchema = z.object({
	enabled: z.boolean().default(false),
	baseDirectory: z.string().min(1).default("./playbook"),
	fileExtension: z.string().default(".md"),
});

const ConfigSchema = z.object({
	server: ServerConfigSchema,
	transport: TransportConfigSchema,
	database: DatabaseConfigSchema,
	logging: LoggingConfigSchema,
	documentation: DocumentationConfigSchema,
	playbooks: PlaybooksConfigSchema,
});

type Config = z.infer<typeof ConfigSchema>;

// Default configuration
const defaultConfig: Config = {
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

// Environment variable mapping
const envVarMapping = {
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

// Load configuration from environment variables
function loadConfigFromEnv(): Partial<Config> {
	const config: Partial<Config> = {};

	// Helper function to parse environment variables
	const parseEnvVar = (value: string | undefined, type: "string" | "number" | "boolean"): unknown => {
		if (value === undefined) return undefined;
		if (type === "number") return Number(value);
		if (type === "boolean") return value.toLowerCase() === "true";
		return value;
	};

	// Load server config
	config.server = {
		name: (parseEnvVar(Bun.env[envVarMapping.server.name], "string") as string) || defaultConfig.server.name,
		version: (parseEnvVar(Bun.env[envVarMapping.server.version], "string") as string) || defaultConfig.server.version,
		readOnlyQueryMode:
			(parseEnvVar(Bun.env[envVarMapping.server.readOnlyQueryMode], "boolean") as boolean) ??
			defaultConfig.server.readOnlyQueryMode,
		maxQueryTimeout:
			(parseEnvVar(Bun.env[envVarMapping.server.maxQueryTimeout], "number") as number) ||
			defaultConfig.server.maxQueryTimeout,
		maxResultsPerQuery:
			(parseEnvVar(Bun.env[envVarMapping.server.maxResultsPerQuery], "number") as number) ||
			defaultConfig.server.maxResultsPerQuery,
	};

	// Load transport config
	const transportMode = parseEnvVar(Bun.env[envVarMapping.transport.mode], "string") as string | undefined;
	const transportSessionMode = parseEnvVar(Bun.env[envVarMapping.transport.sessionMode], "string") as
		| string
		| undefined;
	config.transport = {
		mode: (transportMode as "stdio" | "http" | "both") || defaultConfig.transport.mode,
		port: (parseEnvVar(Bun.env[envVarMapping.transport.port], "number") as number) || defaultConfig.transport.port,
		host: (parseEnvVar(Bun.env[envVarMapping.transport.host], "string") as string) || defaultConfig.transport.host,
		path: (parseEnvVar(Bun.env[envVarMapping.transport.path], "string") as string) || defaultConfig.transport.path,
		sessionMode: (transportSessionMode as "stateless" | "stateful") || defaultConfig.transport.sessionMode,
		idleTimeout:
			(parseEnvVar(Bun.env[envVarMapping.transport.idleTimeout], "number") as number) ||
			defaultConfig.transport.idleTimeout,
		apiKey: (parseEnvVar(Bun.env[envVarMapping.transport.apiKey], "string") as string) || undefined,
		allowedOrigins: (parseEnvVar(Bun.env[envVarMapping.transport.allowedOrigins], "string") as string) || undefined,
	};

	// Load database config
	config.database = {
		connectionString:
			(parseEnvVar(Bun.env[envVarMapping.database.connectionString], "string") as string) ||
			defaultConfig.database.connectionString,
		username:
			(parseEnvVar(Bun.env[envVarMapping.database.username], "string") as string) || defaultConfig.database.username,
		password:
			(parseEnvVar(Bun.env[envVarMapping.database.password], "string") as string) || defaultConfig.database.password,
		bucketName:
			(parseEnvVar(Bun.env[envVarMapping.database.bucketName], "string") as string) ||
			defaultConfig.database.bucketName,
		defaultScope:
			(parseEnvVar(Bun.env[envVarMapping.database.defaultScope], "string") as string) ||
			defaultConfig.database.defaultScope,
		maxConnections:
			(parseEnvVar(Bun.env[envVarMapping.database.maxConnections], "number") as number) ||
			defaultConfig.database.maxConnections,
		connectionTimeout:
			(parseEnvVar(Bun.env[envVarMapping.database.connectionTimeout], "number") as number) ||
			defaultConfig.database.connectionTimeout,
	};

	// Load logging config
	config.logging = {
		level:
			(parseEnvVar(Bun.env[envVarMapping.logging.level], "string") as "debug" | "info" | "warn" | "error") ||
			defaultConfig.logging.level,
		format:
			(parseEnvVar(Bun.env[envVarMapping.logging.format], "string") as "json" | "text") || defaultConfig.logging.format,
		includeMetadata:
			(parseEnvVar(Bun.env[envVarMapping.logging.includeMetadata], "boolean") as boolean) ??
			defaultConfig.logging.includeMetadata,
	};

	// Load documentation config
	if (Bun.env[envVarMapping.documentation.enabled]) {
		config.documentation = {
			enabled:
				(parseEnvVar(Bun.env[envVarMapping.documentation.enabled], "boolean") as boolean) ??
				defaultConfig.documentation?.enabled,
			baseDirectory:
				(parseEnvVar(Bun.env[envVarMapping.documentation.baseDirectory], "string") as string) ||
				defaultConfig.documentation?.baseDirectory,
			fileExtension:
				(parseEnvVar(Bun.env[envVarMapping.documentation.fileExtension], "string") as string) ||
				defaultConfig.documentation?.fileExtension,
		};
	}

	// Load playbooks config
	if (Bun.env[envVarMapping.playbooks.enabled]) {
		config.playbooks = {
			enabled:
				(parseEnvVar(Bun.env[envVarMapping.playbooks.enabled], "boolean") as boolean) ??
				defaultConfig.playbooks?.enabled,
			baseDirectory:
				(parseEnvVar(Bun.env[envVarMapping.playbooks.baseDirectory], "string") as string) ||
				defaultConfig.playbooks?.baseDirectory,
			fileExtension:
				(parseEnvVar(Bun.env[envVarMapping.playbooks.fileExtension], "string") as string) ||
				defaultConfig.playbooks?.fileExtension,
		};
	}

	return config;
}

// Initialize configuration
let config: Config;

try {
	// Merge default config with environment variables
	const envConfig = loadConfigFromEnv();
	const mergedConfig = {
		server: { ...defaultConfig.server, ...envConfig.server },
		transport: { ...defaultConfig.transport, ...envConfig.transport },
		database: { ...defaultConfig.database, ...envConfig.database },
		logging: { ...defaultConfig.logging, ...envConfig.logging },
		documentation: { ...defaultConfig.documentation, ...envConfig.documentation },
		playbooks: { ...defaultConfig.playbooks, ...envConfig.playbooks },
	};

	// Validate and set configuration
	config = ConfigSchema.parse(mergedConfig);
	process.stderr.write(
		"Configuration loaded successfully: " +
			JSON.stringify(
				{
					server: {
						name: config.server.name,
						version: config.server.version,
						readOnlyQueryMode: config.server.readOnlyQueryMode,
					},
					transport: {
						mode: config.transport.mode,
						port: config.transport.port,
						host: config.transport.host,
						path: config.transport.path,
						sessionMode: config.transport.sessionMode,
					},
					database: {
						connectionString: config.database.connectionString,
						bucketName: config.database.bucketName,
					},
					logging: {
						level: config.logging.level,
						format: config.logging.format,
					},
					documentation: {
						enabled: config.documentation?.enabled || false,
						baseDirectory: config.documentation?.baseDirectory || "./docs",
						fileExtension: config.documentation?.fileExtension || ".md",
					},
					playbooks: {
						enabled: config.playbooks?.enabled || false,
						baseDirectory: config.playbooks?.baseDirectory || "./playbook",
						fileExtension: config.playbooks?.fileExtension || ".md",
					},
				},
				null,
				2,
			) +
			"\n",
	);
} catch (error) {
	process.stderr.write(`Configuration validation failed: ${error instanceof Error ? error.message : String(error)}\n`);
	throw new Error(`Invalid configuration: ${error instanceof Error ? error.message : String(error)}`);
}

export { config };
