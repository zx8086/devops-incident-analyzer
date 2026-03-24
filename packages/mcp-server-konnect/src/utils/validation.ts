/**
 * Validation utilities for Kong Konnect MCP server
 */

import { z } from "zod";

/**
 * Common validation schemas
 */
export const CommonSchemas = {
	uuid: z.string().uuid("Must be a valid UUID"),
	positiveInt: z.number().int().positive("Must be a positive integer"),
	port: z.number().int().min(1).max(65535, "Port must be between 1 and 65535"),
	hostname: z
		.string()
		.regex(
			/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,
			"Invalid hostname format",
		),
	url: z.string().url("Must be a valid URL"),
	tags: z.array(z.string()).optional(),
	offset: z.string().optional(),
	pageSize: z.number().int().min(1).max(1000, "Page size must be between 1 and 1000").default(100),
};

/**
 * Time range validation for analytics
 */
export const timeRangeSchema = z.enum(["15M", "1H", "6H", "12H", "24H", "7D"], {
	errorMap: () => ({
		message: "Time range must be one of: 15M, 1H, 6H, 12H, 24H, 7D",
	}),
});

/**
 * Certificate validation
 */
export function validateCertificate(cert: string): {
	isValid: boolean;
	error?: string;
} {
	const pemCertRegex = /-----BEGIN CERTIFICATE-----[\s\S]*-----END CERTIFICATE-----/;

	if (!pemCertRegex.test(cert)) {
		return {
			isValid: false,
			error: "Certificate must be in PEM format with proper BEGIN/END markers",
		};
	}

	// Basic length check
	if (cert.length < 100) {
		return {
			isValid: false,
			error: "Certificate appears to be too short",
		};
	}

	return { isValid: true };
}

/**
 * Private key validation
 */
export function validatePrivateKey(key: string): {
	isValid: boolean;
	error?: string;
} {
	const pemKeyRegex = /-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]*-----END (RSA )?PRIVATE KEY-----/;

	if (!pemKeyRegex.test(key)) {
		return {
			isValid: false,
			error: "Private key must be in PEM format with proper BEGIN/END markers",
		};
	}

	// Basic length check
	if (key.length < 100) {
		return {
			isValid: false,
			error: "Private key appears to be too short",
		};
	}

	return { isValid: true };
}

/**
 * Kong entity name validation
 */
export function validateEntityName(name: string, entityType: string): { isValid: boolean; error?: string } {
	// Kong entity names should follow certain patterns
	const nameRegex = /^[a-zA-Z0-9._-]+$/;

	if (!name || name.trim().length === 0) {
		return {
			isValid: false,
			error: `${entityType} name cannot be empty`,
		};
	}

	if (name.length > 100) {
		return {
			isValid: false,
			error: `${entityType} name cannot be longer than 100 characters`,
		};
	}

	if (!nameRegex.test(name)) {
		return {
			isValid: false,
			error: `${entityType} name can only contain letters, numbers, dots, underscores, and hyphens`,
		};
	}

	return { isValid: true };
}

/**
 * Validate HTTP methods for routes
 */
export const httpMethodSchema = z.enum(
	["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT", "TRACE"],
	{
		errorMap: () => ({ message: "Invalid HTTP method" }),
	},
);

/**
 * Validate protocols
 */
export const protocolSchema = z.enum(["http", "https", "tcp", "tls", "grpc", "grpcs", "ws", "wss"], {
	errorMap: () => ({ message: "Invalid protocol" }),
});

/**
 * Validate upstream algorithm
 */
export const upstreamAlgorithmSchema = z.enum(["round-robin", "consistent-hashing", "least-connections", "ring-hash"], {
	errorMap: () => ({ message: "Invalid upstream algorithm" }),
});

/**
 * Validate hash-on options for upstreams
 */
export const hashOnSchema = z.enum(["none", "consumer", "ip", "header", "cookie", "path", "query_arg", "uri_capture"], {
	errorMap: () => ({ message: "Invalid hash-on option" }),
});

/**
 * Common field validations
 */
export const FieldValidations = {
	/**
	 * Validate that a string is not empty after trimming
	 */
	nonEmptyString: (fieldName: string) =>
		z
			.string()
			.min(1, `${fieldName} cannot be empty`)
			.transform((s) => s.trim()),

	/**
	 * Validate array with at least one element
	 */
	nonEmptyArray: <T>(schema: z.ZodType<T>, fieldName: string) =>
		z.array(schema).min(1, `${fieldName} must have at least one element`),

	/**
	 * Validate weight for upstream targets
	 */
	targetWeight: z.number().int().min(0, "Weight must be non-negative").max(1000, "Weight cannot exceed 1000"),

	/**
	 * Validate timeout values
	 */
	timeout: z.number().int().min(1, "Timeout must be at least 1ms").max(300000, "Timeout cannot exceed 5 minutes"),
};

/**
 * Validate pagination parameters
 */
export function validatePagination(size?: number, offset?: string, pageAfter?: string) {
	const errors: string[] = [];

	if (size !== undefined) {
		if (!Number.isInteger(size) || size < 1 || size > 1000) {
			errors.push("Size must be an integer between 1 and 1000");
		}
	}

	if (offset && pageAfter) {
		errors.push("Cannot use both offset and pageAfter parameters");
	}

	return errors;
}

/**
 * Sanitize and validate JSON configuration
 */
export function validateJsonConfig(
	config: unknown,
	configName = "configuration",
): { isValid: boolean; sanitized?: Record<string, unknown>; error?: string } {
	try {
		// Ensure it's a valid object
		if (!config || typeof config !== "object" || Array.isArray(config)) {
			return {
				isValid: false,
				error: `${configName} must be a valid object`,
			};
		}

		// Remove any undefined values and null prototype
		const sanitized = JSON.parse(JSON.stringify(config));

		return { isValid: true, sanitized };
	} catch (error) {
		return {
			isValid: false,
			error: `${configName} contains invalid JSON: ${error}`,
		};
	}
}

/**
 * Validate plugin configuration based on plugin name
 */
export function validatePluginConfig(pluginName: string, config: Record<string, unknown>): string[] {
	const errors: string[] = [];

	// Common validations for all plugins
	if (!config || typeof config !== "object") {
		errors.push("Plugin configuration must be an object");
		return errors;
	}

	// Plugin-specific validations
	switch (pluginName) {
		case "rate-limiting":
			if (!config.minute && !config.hour && !config.day && !config.month && !config.year) {
				errors.push("Rate limiting plugin requires at least one time period limit");
			}
			break;

		case "key-auth":
			if (config.key_names && !Array.isArray(config.key_names)) {
				errors.push("key_names must be an array");
			}
			break;

		case "cors":
			if (config.origins && !Array.isArray(config.origins)) {
				errors.push("origins must be an array");
			}
			if (config.methods && !Array.isArray(config.methods)) {
				errors.push("methods must be an array");
			}
			break;

		case "jwt":
			if (config.secret_is_base64 !== undefined && typeof config.secret_is_base64 !== "boolean") {
				errors.push("secret_is_base64 must be a boolean");
			}
			break;
	}

	return errors;
}
