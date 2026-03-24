// src/lib/couchbaseConnector.ts

import { CouchbaseError, connect } from "couchbase";
import { config } from "../config";
import { validateCouchbaseConfigOrThrow } from "./configValidation";
import { createError } from "./errors";

function getDbLogger() {
	const { createContextLogger } = require("./logger");
	return createContextLogger("Database");
}

export async function getCluster() {
	try {
		validateCouchbaseConfigOrThrow(config.database);

		const dbLogger = getDbLogger();
		dbLogger.info("Connecting to Couchbase cluster", { url: config.database.connectionString });
		const cluster = await connect(config.database.connectionString, {
			username: config.database.username,
			password: config.database.password,
		});

		const bucket = cluster.bucket(config.database.bucketName);
		const scope = bucket.scope(config.database.defaultScope);
		const collection = scope.collection("_default");

		dbLogger.info("Successfully connected to Couchbase", {
			bucket: config.database.bucketName,
			scope: config.database.defaultScope,
		});

		return {
			cluster,
			bucket: (name: string) => cluster.bucket(name),
			scope: (bucketName: string, name: string) => cluster.bucket(bucketName).scope(name),
			collection: (bucketName: string, scopeName: string, name: string) =>
				cluster.bucket(bucketName).scope(scopeName).collection(name),
			defaultBucket: bucket,
			defaultScope: scope,
			defaultCollection: collection,
			CouchbaseError,
		};
	} catch (error) {
		const dbLogger = getDbLogger();
		dbLogger.error("Failed to connect to Couchbase", {
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
		throw createError(
			"DB_ERROR",
			"Failed to connect to Couchbase",
			error instanceof Error ? error : new Error(String(error)),
		);
	}
}
