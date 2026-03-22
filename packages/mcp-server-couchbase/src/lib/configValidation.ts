/* src/lib/configValidation.ts */

import type { CouchbaseConfig } from "../types";
import { createError } from "./errors";
import { logger } from "./logger";

function getConfigLogger() {
	const { createContextLogger } = require("./logger");
	return createContextLogger("ConfigValidator");
}

export interface ValidationResult {
	isValid: boolean;
	missingFields: string[];
}

/**
 * Validates Couchbase configuration
 * @param config The Couchbase configuration to validate
 * @returns Validation result with status and missing fields
 */
export function validateCouchbaseConfig(config: CouchbaseConfig): ValidationResult {
	const requiredFields = [
		{ key: "url", value: config.url },
		{ key: "username", value: config.username },
		{ key: "password", value: config.password },
		{ key: "bucket", value: config.bucket },
		{ key: "scope", value: config.scope },
		{ key: "collection", value: config.collection },
	];

	const missingFields = requiredFields.filter((field) => !field.value).map((field) => field.key);

	return {
		isValid: missingFields.length === 0,
		missingFields,
	};
}

/**
 * Validates Couchbase configuration and throws an error if invalid
 * @param config The Couchbase configuration to validate
 * @throws AppError if configuration is invalid
 */
export function validateCouchbaseConfigOrThrow(config: CouchbaseConfig): void {
	const { isValid, missingFields } = validateCouchbaseConfig(config);

	if (!isValid) {
		const configLogger = getConfigLogger();
		configLogger.error("Missing Couchbase configuration", {
			missingFields,
			hasUrl: !!config.url,
			hasUsername: !!config.username,
			hasPassword: !!config.password,
			hasBucket: !!config.bucket,
			hasScope: !!config.scope,
			hasCollection: !!config.collection,
		});
		throw createError("CONFIG_ERROR", `Missing required Couchbase configuration: ${missingFields.join(", ")}`);
	}
}

/**
 * Validates Couchbase configuration and exits process if invalid
 * @param config The Couchbase configuration to validate
 */
export function validateCouchbaseConfigOrExit(config: CouchbaseConfig): void {
	const { isValid, missingFields } = validateCouchbaseConfig(config);

	if (!isValid) {
		const configLogger = getConfigLogger();
		configLogger.error(`Missing required configuration: ${missingFields.map((f) => `couchbase.${f}`).join(", ")}`);
		process.exit(1);
	}
}
