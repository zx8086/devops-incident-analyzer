/* src/lib/couchbaseConnector.ts */

import { Cluster, CouchbaseError, connect } from "couchbase";
import { config } from "../config";
import { validateCouchbaseConfigOrThrow } from "./configValidation";
import { createError } from "./errors";
import { createContextLogger, logger } from "./logger";

function getDbLogger() {
	const { createContextLogger } = require("./logger");
	return createContextLogger("Database");
}

export async function getCluster() {
	try {
		validateCouchbaseConfigOrThrow(config.couchbase);

		const dbLogger = getDbLogger();
		dbLogger.info("Connecting to Couchbase cluster", { url: config.couchbase.url });
		const cluster = await connect(config.couchbase.url!, {
			username: config.couchbase.username!,
			password: config.couchbase.password!,
		});

		const bucket = cluster.bucket(config.couchbase.bucket!);
		const scope = bucket.scope(config.couchbase.scope!);
		const collection = scope.collection(config.couchbase.collection!);

		dbLogger.info("Successfully connected to Couchbase", {
			bucket: config.couchbase.bucket,
			scope: config.couchbase.scope,
			collection: config.couchbase.collection,
		});

		return {
			cluster,
			bucket: (name: string) => cluster.bucket(name),
			scope: (bucket: string, name: string) => cluster.bucket(bucket).scope(name),
			collection: (bucket: string, scope: string, name: string) => cluster.bucket(bucket).scope(scope).collection(name),
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
		throw createError("DB_ERROR", "Failed to connect to Couchbase", { error });
	}
}
