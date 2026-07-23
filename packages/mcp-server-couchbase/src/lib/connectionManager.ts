/* src/lib/connectionManager.ts */

import { type Bucket, type Cluster, connect } from "couchbase";
import { config } from "../config";
import { logger } from "../utils/logger";
import { createError } from "./errors";

export class CouchbaseConnectionManager {
	private static instance: CouchbaseConnectionManager;
	private cluster: Cluster | null = null;
	private bucket: Bucket | null = null;
	private isHealthy = false;
	private healthCheckInterval: NodeJS.Timeout | null = null;
	private healthCheckInFlight = false;
	private initializationPromise: Promise<void> | null = null;

	private constructor() {
		// Private constructor to enforce singleton pattern
	}

	public static getInstance(): CouchbaseConnectionManager {
		if (!CouchbaseConnectionManager.instance) {
			CouchbaseConnectionManager.instance = new CouchbaseConnectionManager();
		}
		return CouchbaseConnectionManager.instance;
	}

	public async initialize(): Promise<void> {
		if (!this.initializationPromise) {
			logger.info("Initializing Couchbase connection manager");
			this.initializationPromise = this.initializeConnection();
		}
		return this.initializationPromise;
	}

	private async initializeConnection(): Promise<void> {
		try {
			logger.info(
				{
					connectionString: config.database.connectionString,
					bucketName: config.database.bucketName,
				},
				"Connecting to Couchbase cluster",
			);

			this.cluster = await connect(config.database.connectionString, {
				username: config.database.username,
				password: config.database.password,
				// Cluster-wide timeouts: connectTimeout was previously dead config, and without
				// queryTimeout every SQL++ statement inherited the SDK's 75s default -- analysis
				// tools should fail fast at maxQueryTimeout (30s) instead.
				timeouts: {
					connectTimeout: config.database.connectionTimeout,
					queryTimeout: config.server.maxQueryTimeout,
				},
			});

			this.bucket = this.cluster.bucket(config.database.bucketName);
			this.isHealthy = true;
			this.startHealthCheck();

			logger.info("Successfully connected to Couchbase cluster");
		} catch (error) {
			this.isHealthy = false;
			logger.error(
				{
					error: error instanceof Error ? error.message : String(error),
				},
				"Failed to connect to Couchbase cluster",
			);
			throw createError(
				"DB_ERROR",
				"Failed to initialize database connection",
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	private startHealthCheck(): void {
		// Reconnects re-enter here via initializeConnection; without this guard each
		// reconnect leaked the previous timer and health checks stacked up.
		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval);
		}
		logger.info("Starting health check monitor");
		// Run health check every 30 seconds. The callback must never produce an
		// unhandled rejection -- a rejecting async interval callback has no awaiter.
		// clearInterval only stops FUTURE ticks, so a slow probe (or a reconnect's
		// replacement interval) could otherwise overlap an in-flight check.
		this.healthCheckInterval = setInterval(() => {
			if (this.healthCheckInFlight) {
				logger.debug("Skipping health check tick: previous check still in flight");
				return;
			}
			this.healthCheckInFlight = true;
			this.checkHealth()
				.catch((error) => {
					logger.warn(
						{ error: error instanceof Error ? error.message : String(error) },
						"Health check tick failed unexpectedly",
					);
				})
				.finally(() => {
					this.healthCheckInFlight = false;
				});
		}, 30000);
	}

	private async checkHealth(): Promise<void> {
		try {
			if (!this.cluster || !this.bucket) {
				this.isHealthy = false;
				logger.warn("Health check failed: No active connection");
				await this.initializeConnection();
				return;
			}

			// Perform a simple ping operation
			await this.cluster.ping();

			// Check if we can access the bucket. exists() RESOLVES ({exists:false}) for a
			// missing doc -- unlike get(), which rejected with DocumentNotFoundError on
			// every tick and could surface as an unhandled rejection from the SDK binding.
			await this.bucket.defaultCollection().exists("health_check_key");

			this.isHealthy = true;
			logger.debug(
				{
					clusterConnected: !!this.cluster,
					bucketConnected: !!this.bucket,
				},
				"Health check passed",
			);
		} catch (error) {
			this.isHealthy = false;
			logger.error(
				{
					error: error instanceof Error ? error.message : String(error),
				},
				"Health check failed",
			);

			// Attempt to reconnect
			try {
				await this.initializeConnection();
			} catch (reconnectError) {
				logger.error(
					{
						error: reconnectError instanceof Error ? reconnectError.message : String(reconnectError),
					},
					"Failed to reconnect during health check",
				);
			}
		}
	}

	public async getConnection(): Promise<Bucket> {
		if (!this.initializationPromise) {
			await this.initialize();
		}

		if (!this.isHealthy) {
			logger.error("Attempted to get connection while unhealthy");
			throw createError("DB_ERROR", "Database connection is not healthy");
		}

		// SIO-1174: the SDK multiplexes internally, so a single bucket handle is the
		// whole "pool" -- the former round-robin cycled identical references.
		if (!this.bucket) {
			logger.error("No bucket handle available");
			throw createError("DB_ERROR", "No bucket handle available");
		}
		return this.bucket;
	}

	public async close(): Promise<void> {
		logger.info("Closing Couchbase connection manager");

		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval);
			this.healthCheckInterval = null;
			logger.debug("Health check monitor stopped");
		}

		try {
			if (this.cluster) {
				await this.cluster.close();
			}
			this.cluster = null;
			this.bucket = null;
			this.isHealthy = false;
			this.initializationPromise = null;
			logger.info("Couchbase connection closed successfully");
		} catch (error) {
			// A failed close still invalidates the handles -- getCluster() must not
			// hand out a half-closed SDK object after shutdown.
			this.cluster = null;
			this.bucket = null;
			this.isHealthy = false;
			this.initializationPromise = null;
			logger.error(
				{
					error: error instanceof Error ? error.message : String(error),
				},
				"Error closing Couchbase connection",
			);
			throw createError(
				"DB_ERROR",
				"Failed to close database connection",
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	public isConnectionHealthy(): boolean {
		return this.isHealthy;
	}

	public getCluster(): Cluster | null {
		return this.cluster;
	}
}

export const connectionManager = CouchbaseConnectionManager.getInstance();
