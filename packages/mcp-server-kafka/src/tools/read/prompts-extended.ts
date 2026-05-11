// src/tools/read/prompts-extended.ts

export const GET_CONSUMER_GROUP_LAG_DESCRIPTION = `[READ] Calculate consumer group lag per partition by comparing committed offsets with latest topic offsets. Returns per-partition lag and total lag across all subscribed topics. Essential for monitoring consumer health and detecting stalled consumers.`;

export const DESCRIBE_CLUSTER_DESCRIPTION = `[READ] Get detailed broker-level metadata including broker IDs, host/port, rack assignments, and controller status. Provides deeper cluster topology information than get_cluster_info. Use this for infrastructure debugging and capacity planning.`;

export const GET_MESSAGE_BY_OFFSET_DESCRIPTION = `[READ] Retrieve a single message from a specific topic, partition, and offset. Use this for targeted message inspection during incident investigation when you know the exact offset of a problematic message.`;
