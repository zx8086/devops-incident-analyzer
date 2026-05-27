// src/tools/messaging/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { withEstate } from "../estate-schema.ts";
import { toMcp } from "../wrap.ts";
import { type DescribeRuleParams, describeRule, describeRuleSchema } from "./eventbridge/describe-rule.ts";
import { type ListRulesParams, listRules, listRulesSchema } from "./eventbridge/list-rules.ts";
import {
	type GetTopicAttributesParams,
	getTopicAttributes,
	getTopicAttributesSchema,
} from "./sns/get-topic-attributes.ts";
import { type ListTopicsParams, listTopics, listTopicsSchema } from "./sns/list-topics.ts";
import {
	type GetQueueAttributesParams,
	getQueueAttributes,
	getQueueAttributesSchema,
} from "./sqs/get-queue-attributes.ts";
import { type ListQueuesParams, listQueues, listQueuesSchema } from "./sqs/list-queues.ts";
import {
	type ListStateMachinesParams,
	listStateMachines,
	listStateMachinesSchema,
} from "./stepfunctions/list-state-machines.ts";

export function registerMessagingTools(server: McpServer, config: AwsConfig): void {
	const topics = listTopics(config);
	server.tool(
		"aws_sns_list_topics",
		"List SNS topic ARNs in the account.",
		withEstate(config, listTopicsSchema.shape),
		async (params) => toMcp(await topics(params as ListTopicsParams)),
	);

	const topicAttributes = getTopicAttributes(config);
	server.tool(
		"aws_sns_get_topic_attributes",
		"Get all attributes for an SNS topic including subscriptions count, delivery policy, and KMS key.",
		withEstate(config, getTopicAttributesSchema.shape),
		async (params) => toMcp(await topicAttributes(params as GetTopicAttributesParams)),
	);

	const queues = listQueues(config);
	server.tool(
		"aws_sqs_list_queues",
		"List SQS queue URLs in the account, optionally filtered by name prefix.",
		withEstate(config, listQueuesSchema.shape),
		async (params) => toMcp(await queues(params as ListQueuesParams)),
	);

	const queueAttributes = getQueueAttributes(config);
	server.tool(
		"aws_sqs_get_queue_attributes",
		"Get attributes for an SQS queue including approximate message counts, visibility timeout, and ARN.",
		withEstate(config, getQueueAttributesSchema.shape),
		async (params) => toMcp(await queueAttributes(params as GetQueueAttributesParams)),
	);

	const rules = listRules(config);
	server.tool(
		"aws_eventbridge_list_rules",
		"List EventBridge rules on a bus, optionally filtered by name prefix.",
		withEstate(config, listRulesSchema.shape),
		async (params) => toMcp(await rules(params as ListRulesParams)),
	);

	const rule = describeRule(config);
	server.tool(
		"aws_eventbridge_describe_rule",
		"Describe an EventBridge rule with event pattern, schedule, state, and targets.",
		withEstate(config, describeRuleSchema.shape),
		async (params) => toMcp(await rule(params as DescribeRuleParams)),
	);

	const stateMachines = listStateMachines(config);
	server.tool(
		"aws_stepfunctions_list_state_machines",
		"List Step Functions state machines with name, ARN, type, and creation date.",
		withEstate(config, listStateMachinesSchema.shape),
		async (params) => toMcp(await stateMachines(params as ListStateMachinesParams)),
	);
}
