// src/lib/couchbaseConnector.ts

import { CouchbaseError, connect } from "couchbase";
import { config } from "../config";
import { createContextLogger } from "../utils/logger";
import { validateCouchbaseConfigOrThrow } from "./configValidation";
import { createError } from "./errors";

const dbLogger = createContextLogger("Database");

export async function getCluster() {
	try {
		validateCouchbaseConfigOrThrow(config.database);

		dbLogger.info({ url: config.database.connectionString }, "Connecting to Couchbase cluster");
		const cluster = await connect(config.database.connectionString, {
			username: config.database.username,
			password: config.database.password,
		});

		const bucket = cluster.bucket(config.database.bucketName);
		const scope = bucket.scope(config.database.defaultScope);
		const collection = scope.collection("_default");

		dbLogger.info(
			{
				bucket: config.database.bucketName,
				scope: config.database.defaultScope,
			},
			"Successfully connected to Couchbase",
		);

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
		dbLogger.error(
			{
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			},
			"Failed to connect to Couchbase",
		);
		throw createError(
			"DB_ERROR",
			"Failed to connect to Couchbase",
			error instanceof Error ? error : new Error(String(error)),
		);
	}
}
