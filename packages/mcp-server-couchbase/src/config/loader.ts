// src/config/loader.ts

import { defaultConfig } from "./defaults";
import { envVarMapping } from "./envMapping";
import type { Config } from "./schemas";
import { ConfigSchema } from "./schemas";

function parseEnvVar(value: string | undefined, type: "string" | "number" | "boolean"): unknown {
	if (value === undefined) return undefined;
	if (type === "number") return Number(value);
	if (type === "boolean") return value.toLowerCase() === "true";
	return value;
}

function loadConfigFromEnv(): Partial<Config> {
	const config: Partial<Config> = {};

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

let config: Config;

try {
	const envConfig = loadConfigFromEnv();
	const mergedConfig = {
		server: { ...defaultConfig.server, ...envConfig.server },
		transport: { ...defaultConfig.transport, ...envConfig.transport },
		database: { ...defaultConfig.database, ...envConfig.database },
		logging: { ...defaultConfig.logging, ...envConfig.logging },
		documentation: { ...defaultConfig.documentation, ...envConfig.documentation },
		playbooks: { ...defaultConfig.playbooks, ...envConfig.playbooks },
	};

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
