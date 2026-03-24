// src/lib/configValidation.ts

import type { CouchbaseConfig } from "../types";
import { createError } from "./errors";

export interface ValidationResult {
	isValid: boolean;
	missingFields: string[];
}

export function validateCouchbaseConfig(config: CouchbaseConfig): ValidationResult {
	const requiredFields = [
		{ key: "connectionString", value: config.connectionString },
		{ key: "username", value: config.username },
		{ key: "password", value: config.password },
		{ key: "bucketName", value: config.bucketName },
		{ key: "defaultScope", value: config.defaultScope },
	];

	const missingFields = requiredFields.filter((field) => !field.value).map((field) => field.key);

	return {
		isValid: missingFields.length === 0,
		missingFields,
	};
}

export function validateCouchbaseConfigOrThrow(config: CouchbaseConfig): void {
	const { isValid, missingFields } = validateCouchbaseConfig(config);

	if (!isValid) {
		throw createError("CONFIG_ERROR", `Missing required Couchbase configuration: ${missingFields.join(", ")}`);
	}
}
