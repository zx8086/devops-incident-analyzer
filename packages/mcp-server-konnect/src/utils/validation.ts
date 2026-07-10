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
	message: "Time range must be one of: 15M, 1H, 6H, 12H, 24H, 7D",
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
