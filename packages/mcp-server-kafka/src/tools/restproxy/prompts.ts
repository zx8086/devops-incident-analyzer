// src/tools/restproxy/prompts.ts

export const RESTPROXY_LIST_TOPICS_DESCRIPTION =
	"[READ] List all topics visible via REST Proxy. Useful for verifying produce/consume targets before writing or subscribing.";

export const RESTPROXY_GET_TOPIC_DESCRIPTION =
	"[READ] Get full topic metadata (configs, partitions, replicas) via REST Proxy. Use after restproxy_list_topics to drill into a specific topic.";

export const RESTPROXY_GET_PARTITIONS_DESCRIPTION =
	"[READ] List partitions for a topic with leader and ISR info. Use to verify partition health and replication state.";

export const RESTPROXY_PRODUCE_DESCRIPTION =
	"[WRITE] Produce one or more JSON records to a topic via REST Proxy v2. Returns offset assignments per record. Requires allowWrites=true.";

export const RESTPROXY_CREATE_CONSUMER_DESCRIPTION =
	"[WRITE] Create a consumer instance in a group. Next step: restproxy_subscribe. REST Proxy auto-cleans idle consumer instances after ~5 minutes — always call restproxy_delete_consumer when done to avoid orphaned state.";

export const RESTPROXY_SUBSCRIBE_DESCRIPTION =
	"[WRITE] Subscribe a consumer instance to one or more topics. Must call restproxy_create_consumer first. Next step: restproxy_consume.";

export const RESTPROXY_CONSUME_DESCRIPTION =
	"[READ] Fetch records for a subscribed consumer instance. Returns up to maxBytes within timeoutMs. Returns empty array if no records are available.";

export const RESTPROXY_COMMIT_OFFSETS_DESCRIPTION =
	"[WRITE] Commit consumed offsets for a consumer instance. Pass an explicit offsets array to commit specific positions, or omit to commit all offsets consumed in the current session.";

export const RESTPROXY_DELETE_CONSUMER_DESCRIPTION =
	"[WRITE] Delete a consumer instance and release its group membership. Idempotent — REST Proxy also auto-deletes idle consumers after ~5 minutes, but explicit deletion is preferred.";
