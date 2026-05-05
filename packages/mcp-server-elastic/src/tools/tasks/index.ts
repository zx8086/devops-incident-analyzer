/* src/tools/tasks/index.ts */
import type { Client } from "@elastic/elasticsearch";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import { OperationType, withReadOnlyCheck } from "../../utils/readOnlyMode.js";
import { booleanField } from "../../utils/zodHelpers.js";

// Define task-specific error types
export class TaskError extends Error {
	constructor(
		message: string,
		public readonly taskId?: string,
	) {
		super(message);
		this.name = "TaskError";
	}
}

export class TaskNotFoundError extends TaskError {
	constructor(taskId: string) {
		super(`Task not found: ${taskId}`, taskId);
		this.name = "TaskNotFoundError";
	}
}

export class TaskCancellationError extends TaskError {
	constructor(taskId: string, reason?: string) {
		super(`Failed to cancel task ${taskId}: ${reason || "Unknown error"}`, taskId);
		this.name = "TaskCancellationError";
	}
}

const listTasksSchema = z.object({
	actions: z.union([z.string(), z.array(z.string())]).optional(),
	detailed: booleanField().optional(),
	groupBy: z.enum(["nodes", "parents", "none"]).optional(),
	nodes: z.union([z.string(), z.array(z.string())]).optional(),
	parentTaskId: z.string().optional(),
	// Elasticsearch Duration accepts string ("30s") or special values -1/0; not arbitrary numbers.
	timeout: z.union([z.string(), z.literal(-1), z.literal(0)]).optional(),
	waitForCompletion: booleanField().optional(),
});

export const listTasks = {
	name: "elasticsearch_list_tasks",
	description:
		"Get information about tasks currently running on Elasticsearch cluster nodes. Best for cluster monitoring, performance troubleshooting, operation tracking. Use when you need to monitor long-running operations like reindexing, searches, or bulk operations in Elasticsearch.",
	inputSchema: listTasksSchema.shape,
	operationType: OperationType.READ as const,
	handler: async (client: Client, args: z.infer<typeof listTasksSchema>) => {
		try {
			logger.debug(
				{
					actions: args.actions,
					groupBy: args.groupBy,
					nodes: args.nodes,
				},
				"Listing Elasticsearch tasks",
			);

			const result = await client.tasks.list({
				actions: args.actions,
				detailed: args.detailed,
				group_by: args.groupBy,
				nodes: args.nodes,
				parent_task_id: args.parentTaskId,
				timeout: args.timeout,
				wait_for_completion: args.waitForCompletion,
			});

			logger.debug(
				{
					taskCount: Object.keys(result.tasks || {}).length,
				},
				"Tasks retrieved successfully",
			);

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(result, null, 2),
					},
				],
			};
		} catch (error) {
			logger.error(
				{
					error: error instanceof Error ? error.message : String(error),
					actions: args.actions,
					nodes: args.nodes,
				},
				"Failed to list tasks",
			);

			throw new McpError(
				ErrorCode.InternalError,
				`Failed to list tasks: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	},
};

const getTaskSchema = z.object({
	taskId: z.string().min(1, "Task ID cannot be empty"),
	// Elasticsearch Duration accepts string ("30s") or special values -1/0; not arbitrary numbers.
	timeout: z.union([z.string(), z.literal(-1), z.literal(0)]).optional(),
	waitForCompletion: booleanField().optional(),
});

export const getTask = {
	name: "elasticsearch_get_task",
	description:
		"Get information about a specific Elasticsearch task. Best for task monitoring, operation tracking, performance analysis. Use when you need to inspect the status and details of running or completed tasks in Elasticsearch.",
	inputSchema: getTaskSchema.shape,
	operationType: OperationType.READ as const,
	handler: async (client: Client, args: z.infer<typeof getTaskSchema>) => {
		try {
			logger.debug(
				{
					taskId: args.taskId,
					timeout: args.timeout,
				},
				"Getting Elasticsearch task details",
			);

			const result = await client.tasks.get({
				task_id: args.taskId,
				timeout: args.timeout,
				wait_for_completion: args.waitForCompletion,
			});

			logger.debug(
				{
					taskId: args.taskId,
					completed: result.completed,
				},
				"Task details retrieved successfully",
			);

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(result, null, 2),
					},
				],
			};
		} catch (error) {
			logger.error(
				{
					error: error instanceof Error ? error.message : String(error),
					taskId: args.taskId,
				},
				"Failed to get task",
			);

			if (error instanceof Error && error.message.includes("not found")) {
				throw new McpError(ErrorCode.InvalidRequest, `Task not found: ${args.taskId}`);
			}

			throw new McpError(
				ErrorCode.InternalError,
				`Failed to get task: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	},
};

const cancelTaskSchema = z.object({
	taskId: z.string().optional(),
	actions: z.union([z.string(), z.array(z.string())]).optional(),
	nodes: z.array(z.string()).optional(),
	parentTaskId: z.string().optional(),
	waitForCompletion: booleanField().optional(),
});

const cancelTaskImpl = async (client: Client, args: z.infer<typeof cancelTaskSchema>) => {
	try {
		logger.debug(
			{
				taskId: args.taskId,
				actions: args.actions,
				nodes: args.nodes,
			},
			"Cancelling Elasticsearch task",
		);

		const result = await client.tasks.cancel({
			task_id: args.taskId,
			actions: args.actions,
			nodes: args.nodes,
			parent_task_id: args.parentTaskId,
			wait_for_completion: args.waitForCompletion,
		});

		logger.info(
			{
				taskId: args.taskId,
				nodesAffected: result.nodes ? Object.keys(result.nodes).length : 0,
			},
			"Task cancellation completed",
		);

		return {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify(result, null, 2),
				},
			],
		};
	} catch (error) {
		logger.error(
			{
				error: error instanceof Error ? error.message : String(error),
				taskId: args.taskId,
			},
			"Failed to cancel task",
		);

		if (args.taskId && error instanceof Error && error.message.includes("not found")) {
			throw new McpError(ErrorCode.InvalidRequest, `Task not found: ${args.taskId}`);
		}

		throw new McpError(
			ErrorCode.InternalError,
			`Failed to cancel task: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
};

export const cancelTask = {
	name: "elasticsearch_cancel_task",
	description:
		"Cancel a running Elasticsearch task. Best for operation control, resource management, stopping long-running operations. Use when you need to terminate tasks that are taking too long or consuming too many resources in Elasticsearch. WARNING: Task management API is beta.",
	inputSchema: cancelTaskSchema.shape,
	operationType: OperationType.WRITE as const,
	handler: withReadOnlyCheck("elasticsearch_cancel_task", cancelTaskImpl, OperationType.WRITE),
};

export const tasksTools = [listTasks, getTask, cancelTask] as const;
