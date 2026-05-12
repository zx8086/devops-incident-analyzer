// src/services/topic-pagination.ts

export interface SliceTopicsOptions {
	filter?: string;
	prefix?: string;
	limit: number;
	offset: number;
}

export interface PagedTopicNames {
	topics: string[];
	total: number;
	truncated: boolean;
	hint?: string;
}

// SIO-735: shared paging slice used by kafka_list_topics, kafka_get_cluster_info,
// and restproxy_list_topics. Sort first so 'offset' is stable across calls
// (Kafka Admin and REST Proxy give no order guarantee).
export function sliceTopics(raw: string[], options: SliceTopicsOptions): PagedTopicNames {
	const { filter, prefix, limit, offset } = options;
	const sorted = [...raw].sort();

	let matching = sorted;
	if (prefix) matching = matching.filter((t) => t.startsWith(prefix));
	if (filter) {
		const regex = new RegExp(filter);
		matching = matching.filter((t) => regex.test(t));
	}

	const total = matching.length;
	const page = matching.slice(offset, offset + limit);
	const truncated = offset + page.length < total;

	let hint: string | undefined;
	if (offset >= total && total > 0) {
		hint = `Offset is past the end of the result set (total: ${total}). Reduce 'offset' or remove it.`;
	} else if (truncated) {
		hint = "More topics match. Use a more specific 'prefix' or page with 'offset' (max 'limit' is 500).";
	}

	return {
		topics: page,
		total,
		truncated,
		...(hint ? { hint } : {}),
	};
}
