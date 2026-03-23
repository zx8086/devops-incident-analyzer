/* src/utils/notifications.ts */

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { getCurrentRunTree, withRunTree } from "langsmith/singletons/traceable";
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
		[key: string]: any;
	};
}

export class NotificationManager {
	private requestContext: RequestHandlerExtra<ServerRequest, ServerNotification> | null = null;
	private activeOperations: Map<
		string,
		{
			progressToken: string | number;
			total?: number;
			lastProgress: number;
		}
	> = new Map();

	setRequestContext(context: RequestHandlerExtra<ServerRequest, ServerNotification>): void {
		this.requestContext = context;
		logger.debug("Notification manager request context set");
	}

	clearRequestContext(): void {
		this.requestContext = null;
		logger.debug("Notification manager request context cleared");
	}

	async sendProgress(notification: ProgressNotification): Promise<void> {
		if (!this.requestContext?.sendNotification) {
			logger.debug(
				{
					token: notification.progressToken,
					progress: notification.progress,
					total: notification.total,
				},
				"No request context available for progress notification",
			);
			return;
		}

		// CRITICAL: Safely get trace context without throwing errors
		let currentTrace: any;
		try {
			currentTrace = getCurrentRunTree(true); // Allow absent run tree
		} catch (_error) {
			// No tracing context available - this is fine
			currentTrace = null;
		}

		const sendNotificationSafely = async () => {
			try {
				// Use the sendNotification function from RequestHandlerExtra
				await this.requestContext!.sendNotification({
					method: "notifications/progress",
					params: {
						progressToken: notification.progressToken,
						progress: notification.progress,
						total: notification.total,
					},
				});

				logger.debug(
					{
						token: notification.progressToken,
						progress: notification.progress,
						total: notification.total,
						hasTraceContext: !!currentTrace,
					},
					"Progress notification sent successfully",
				);
			} catch (error) {
				// Log but don't throw - progress notifications are optional
				logger.warn(
					{
						error: error instanceof Error ? error.message : String(error),
						token: notification.progressToken,
						progress: notification.progress,
						total: notification.total,
						hasTraceContext: !!currentTrace,
					},
					"Progress notification failed (non-critical)",
				);
			}
		};

		// Execute with preserved trace context if available
		if (currentTrace) {
			await withRunTree(currentTrace, sendNotificationSafely);
		} else {
			await sendNotificationSafely();
		}
	}

	async sendMessage(notification: GeneralNotification): Promise<void> {
		// CRITICAL: Most MCP clients don't support notifications/message
		// Always log locally and skip sending notification to avoid errors
		const logMessage = `[${notification.level.toUpperCase()}] ${notification.data.message}`;
		const logMetadata = {
			level: notification.level,
			type: notification.data.type,
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

	async completeOperation(operationId: string, result?: any, message?: string): Promise<void> {
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

	async sendWarning(message: string, data?: Record<string, any>): Promise<void> {
		await this.sendMessage({
			level: "warning",
			data: {
				message,
				type: "warning",
				...data,
			},
		});
	}

	async sendError(message: string, error?: Error | string, data?: Record<string, any>): Promise<void> {
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

	async sendInfo(message: string, data?: Record<string, any>): Promise<void> {
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

export function withNotificationContext<TArgs, TResult>(
	handler: (args: TArgs, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => Promise<TResult>,
): (args: TArgs, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => Promise<TResult> {
	return async (args: TArgs, extra: RequestHandlerExtra<ServerRequest, ServerNotification>): Promise<TResult> => {
		// Set the request context so notifications can be sent
		notificationManager.setRequestContext(extra);

		try {
			const result = await handler(args, extra);
			return result;
		} finally {
			// Always clear the context after execution
			notificationManager.clearRequestContext();
		}
	};
}

export function withNotifications<T extends any[], R>(
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
	complete: (result?: any, message?: string) => Promise<void>;
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
		complete: (result?: any, message?: string) => notificationManager.completeOperation(operationId, result, message),
		fail: (error: Error | string, message?: string) => notificationManager.failOperation(operationId, error, message),
	};
}
