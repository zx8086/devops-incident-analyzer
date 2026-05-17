// apps/web/src/lib/server/langsmith-tags.ts
export interface LangSmithTagOptions {
	threadId: string;
	dataSources?: string[];
	isFollowUp?: boolean;
	resumed?: boolean;
}

export function buildLangSmithTags(opts: LangSmithTagOptions): string[] {
	const tags = ["chat", `thread:${opts.threadId}`];
	tags.push(
		opts.dataSources && opts.dataSources.length > 0
			? `datasources:${[...opts.dataSources].sort().join(",")}`
			: "datasources:auto",
	);
	if (opts.isFollowUp) tags.push("follow-up");
	if (opts.resumed) tags.push("resumed");
	return tags;
}
