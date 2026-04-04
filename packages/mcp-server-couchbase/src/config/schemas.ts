// src/config/schemas.ts

import { z } from "zod";

export const ServerConfigSchema = z.object({
	name: z.string().min(1),
	version: z.string().min(1),
	readOnlyQueryMode: z.boolean().default(true),
	maxQueryTimeout: z.number().min(1000).max(300000).default(30000),
	maxResultsPerQuery: z.number().min(1).max(10000).default(1000),
});

export const TransportConfigSchema = z.object({
	mode: z.enum(["stdio", "http", "both"]).default("stdio"),
	port: z.number().min(1).max(65535).default(9082),
	host: z.string().min(1).default("0.0.0.0"),
	path: z.string().min(1).default("/mcp"),
	sessionMode: z.enum(["stateless", "stateful"]).default("stateless"),
	idleTimeout: z.number().min(1).default(255),
	apiKey: z.string().optional(),
	allowedOrigins: z.string().optional(),
});

export const DatabaseConfigSchema = z.object({
	connectionString: z.string().url(),
	username: z.string().min(1),
	password: z.string().min(1),
	bucketName: z.string().min(1),
	defaultScope: z.string().default("_default"),
	maxConnections: z.number().min(1).max(100).default(10),
	connectionTimeout: z.number().min(1000).max(30000).default(5000),
});

export const LoggingConfigSchema = z.object({
	level: z.enum(["debug", "info", "warn", "error"]).default("info"),
	format: z.enum(["json", "text"]).default("json"),
	includeMetadata: z.boolean().default(true),
});

export const DocumentationConfigSchema = z.object({
	enabled: z.boolean().default(false),
	baseDirectory: z.string().min(1).default("/tmp/docs"),
	fileExtension: z.string().default(".md"),
});

export const PlaybooksConfigSchema = z.object({
	enabled: z.boolean().default(false),
	baseDirectory: z.string().min(1).default("./playbook"),
	fileExtension: z.string().default(".md"),
});

export const ConfigSchema = z.object({
	server: ServerConfigSchema,
	transport: TransportConfigSchema,
	database: DatabaseConfigSchema,
	logging: LoggingConfigSchema,
	documentation: DocumentationConfigSchema,
	playbooks: PlaybooksConfigSchema,
});

export type Config = z.infer<typeof ConfigSchema>;
