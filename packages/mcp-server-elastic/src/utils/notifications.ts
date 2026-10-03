/* src/utils/notifications.ts */

import { logger } from "./logger.js";

export interface ProgressNotification {
	progressToken: string | number;
	progress: number;
	total?: number;
}

export type NotificationLevel = "info" | "warning" | "error" | "debug";

export interface GeneralNotification {
	level: NotificationLevel;
	logger?: string;
	data: {
		message: string;
		timestamp?: string;
		operation_id?: string;
		type?: string;
		[key: string]: unknown;
	};
}

export class NotificationManager {
	private activeOperations: Map<
		string,
		{
			progressToken: string | number;
			total?: number;
			lastProgress: number;
		}
	> = new Map();

	// SIO-1953: progress is log-only. It used to go out through a request context parked on this
	// process-global singleton, so concurrent tool calls overwrote and cleared each other's context.
	// The tokens are server-invented (createProgressTracker), so no client could correlate them anyway.
	async sendProgress(notification: ProgressNotification): Promise<void> {
		logger.debug(
			{
				token: notification.progressToken,
				progress: notification.progress,
				total: notification.total,
			},
			"Progress update",
		);
	}

	async sendMessage(notification: GeneralNotification): Promise<void> {
		// CRITICAL: Most MCP clients don't support notifications/message
		// Always log locally and skip sending notification to avoid errors
		const logMessage = notification.data.message;
		const logMetadata = {
			level: notification.level,
			operation_id: notification.data.operation_id,
			data: notification.data,
		};

		// Log locally using appropriate level
		switch (notification.level) {
			case "error":
				logger.error(logMetadata, logMessage);
				break;
			case "warning":
				logger.warn(logMetadata, logMessage);
				break;
			case "debug":
				logger.debug(logMetadata, logMessage);
				break;
			default:
				logger.info(logMetadata, logMessage);
				break;
		}

		// Skip sending notification to client - most don't support it
		// Only progress notifications are widely supported
		logger.debug(
			{
				reason: "Most MCP clients don't support notifications/message",
				level: notification.level,
				message: notification.data.message,
			},
			"Message logged locally (client notification skipped)",
		);
	}

	async startOperation(
		operationId: string,
		progressToken: string | number,
		total?: number,
		description?: string,
	): Promise<void> {
		this.activeOperations.set(operationId, {
			progressToken,
			total,
			lastProgress: 0,
		});

		// Send initial progress
		await this.sendProgress({
			progressToken,
			progress: 0,
			total,
		});

		// Send operation start notification
		await this.sendMessage({
			level: "info",
			data: {
				type: "operation_started",
				operation_id: operationId,
				message: description || `Operation ${operationId} started`,
			},
		});

		logger.info(
			{
				operationId,
				progressToken,
				total,
				description,
			},
			"Operation started with progress tracking",
		);
	}

	async updateProgress(operationId: string, progress: number, message?: string): Promise<void> {
		const operation = this.activeOperations.get(operationId);
		if (!operation) {
			logger.warn({ operationId }, "Attempted to update progress for unknown operation");
			return;
		}

		// Update progress
		operation.lastProgress = progress;
		await this.sendProgress({
			progressToken: operation.progressToken,
			progress,
			total: operation.total,
		});

		// Send step notification if message provided
		if (message) {
			await this.sendMessage({
				level: "info",
				data: {
					type: "operation_progress",
					operation_id: operationId,
					message,
					progress,
					total: operation.total,
				},
			});
		}

		logger.debug(
			{
				operationId,
				progress,
				total: operation.total,
				message,
			},
			"Operation progress updated",
		);
	}

	async completeOperation(operationId: string, result?: unknown, message?: string): Promise<void> {
		const operation = this.activeOperations.get(operationId);
		if (!operation) {
			logger.warn({ operationId }, "Attempted to complete unknown operation");
			return;
		}

		// Send final progress
		await this.sendProgress({
			progressToken: operation.progressToken,
			progress: operation.total || 100,
			total: operation.total,
		});

		// Send completion notification
		await this.sendMessage({
			level: "info",
			data: {
				type: "operation_completed",
				operation_id: operationId,
				message: message || `Operation ${operationId} completed successfully`,
				result: result ? String(result) : undefined,
			},
		});

		// Clean up
		this.activeOperations.delete(operationId);

		logger.info(
			{
				operationId,
				result,
				message,
			},
			"Operation completed",
		);
	}

	async failOperation(operationId: string, error: Error | string, message?: string): Promise<void> {
		const operation = this.activeOperations.get(operationId);
		if (!operation) {
			logger.warn({ operationId }, "Attempted to fail unknown operation");
			return;
		}

		// Send error notification
		await this.sendMessage({
			level: "error",
			data: {
				type: "operation_failed",
				operation_id: operationId,
				message: message || `Operation ${operationId} failed`,
				error: error instanceof Error ? error.message : String(error),
			},
		});

		// Clean up
		this.activeOperations.delete(operationId);

		logger.error(
			{
				operationId,
				error: error instanceof Error ? error.message : String(error),
				message,
			},
			"Operation failed",
		);
	}

	async sendWarning(message: string, data?: Record<string, unknown>): Promise<void> {
		await this.sendMessage({
			level: "warning",
			data: {
				message,
				type: "warning",
				...data,
			},
		});
	}

	async sendError(message: string, error?: Error | string, data?: Record<string, unknown>): Promise<void> {
		await this.sendMessage({
			level: "error",
			data: {
				message,
				type: "error",
				error: error instanceof Error ? error.message : error,
				...data,
			},
		});
	}

	async sendInfo(message: string, data?: Record<string, unknown>): Promise<void> {
		await this.sendMessage({
			level: "info",
			data: {
				message,
				type: "info",
				...data,
			},
		});
	}

	getActiveOperationsCount(): number {
		return this.activeOperations.size;
	}

	getActiveOperationIds(): string[] {
		return Array.from(this.activeOperations.keys());
	}

	static generateOperationId(prefix: string = "op"): string {
		return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(7)}`;
	}

	static generateProgressToken(operationId: string): string {
		return `progress-${operationId}`;
	}
}

// Global notification manager instance
export const notificationManager = new NotificationManager();

export function withNotifications<T extends unknown[], R>(
	toolName: string,
	handler: (...args: T) => Promise<R>,
): (...args: T) => Promise<R> {
	return async (...args: T): Promise<R> => {
		const operationId = NotificationManager.generateOperationId(toolName);
		const _progressToken = NotificationManager.generateProgressToken(operationId);

		try {
			// For long-running operations, we could start progress tracking here
			// But for now, just execute and notify on errors
			const result = await handler(...args);

			return result;
		} catch (error) {
			// Send error notification for failed operations
			await notificationManager.sendError(
				`Tool ${toolName} execution failed`,
				error instanceof Error ? error : new Error(String(error)),
				{ tool: toolName, operation_id: operationId },
			);
			throw error;
		}
	};
}

export interface ProgressTracker {
	operationId: string;
	progressToken: string;
	updateProgress: (progress: number, message?: string) => Promise<void>;
	complete: (result?: unknown, message?: string) => Promise<void>;
	fail: (error: Error | string, message?: string) => Promise<void>;
}

export async function createProgressTracker(
	toolName: string,
	total?: number,
	description?: string,
): Promise<ProgressTracker> {
	const operationId = NotificationManager.generateOperationId(toolName);
	const progressToken = NotificationManager.generateProgressToken(operationId);

	await notificationManager.startOperation(operationId, progressToken, total, description);

	return {
		operationId,
		progressToken,
		updateProgress: (progress: number, message?: string) =>
			notificationManager.updateProgress(operationId, progress, message),
		complete: (result?: unknown, message?: string) =>
			notificationManager.completeOperation(operationId, result, message),
		fail: (error: Error | string, message?: string) => notificationManager.failOperation(operationId, error, message),
	};
}
