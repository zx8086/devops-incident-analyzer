/* src/lib/connectionManager.ts */

import { type Bucket, type Cluster, connect } from "couchbase";
import { config } from "../config";
import { logger } from "../utils/logger";
import { createError } from "./errors";

export class CouchbaseConnectionManager {
	private static instance: CouchbaseConnectionManager;
	private cluster: Cluster | null = null;
	private bucket: Bucket | null = null;
	private connectionPool: Bucket[] = [];
	private isHealthy = false;
	private healthCheckInterval: NodeJS.Timeout | null = null;
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
			});

			this.bucket = this.cluster.bucket(config.database.bucketName);
			await this.initializeConnectionPool();
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

	private async initializeConnectionPool(): Promise<void> {
		try {
			// Initialize the connection pool with the configured number of connections
			for (let i = 0; i < config.database.maxConnections; i++) {
				const bucket = this.cluster?.bucket(config.database.bucketName);
				if (bucket) this.connectionPool.push(bucket);
			}
			logger.info(
				{
					poolSize: this.connectionPool.length,
					maxConnections: config.database.maxConnections,
				},
				"Connection pool initialized",
			);
		} catch (error) {
			logger.error(
				{
					error: error instanceof Error ? error.message : String(error),
				},
				"Failed to initialize connection pool",
			);
			throw createError(
				"DB_ERROR",
				"Failed to initialize connection pool",
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	private startHealthCheck(): void {
		logger.info("Starting health check monitor");
		// Run health check every 30 seconds
		this.healthCheckInterval = setInterval(async () => {
			await this.checkHealth();
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

			// Check if we can access the bucket
			await this.bucket
				.defaultCollection()
				.get("health_check_key")
				.catch(() => {
					// Ignore not found error, we just want to verify bucket access
				});

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

		// Get a connection from the pool using round-robin
		const connection = this.connectionPool.shift();
		if (!connection) {
			logger.error("No available connections in the pool");
			throw createError("DB_ERROR", "No available connections in the pool");
		}

		// Add the connection back to the pool
		this.connectionPool.push(connection);
		return connection;
	}

	public async close(): Promise<void> {
		logger.info("Closing Couchbase connection manager");

		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval);
			logger.debug("Health check monitor stopped");
		}

		try {
			if (this.cluster) {
				await this.cluster.close();
			}
			this.connectionPool = [];
			this.isHealthy = false;
			this.initializationPromise = null;
			logger.info("Couchbase connection closed successfully");
		} catch (error) {
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

	public getPoolSize(): number {
		return this.connectionPool.length;
	}

	public getCluster(): Cluster | null {
		return this.cluster;
	}
}

export const connectionManager = CouchbaseConnectionManager.getInstance();
