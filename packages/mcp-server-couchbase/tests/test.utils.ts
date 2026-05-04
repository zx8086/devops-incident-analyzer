/* tests/test.utils.ts */

import type { Bucket, Cluster } from "couchbase";

type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>;

export class MockBucket implements Partial<Bucket> {
	private documents: Map<string, unknown> = new Map();

	scope(_name: string) {
		return {
			collection: (_collectionName: string) => ({
				get: async (id: string) => {
					if (!id) throw new Error("Missing document id");
					const doc = this.documents.get(id);
					if (!doc) throw new Error("Document not found");
					return { content: doc };
				},
				upsert: async (id: string, content: unknown) => {
					if (!id || !content) throw new Error("Missing parameters for upsert");
					let parsedContent: unknown;
					try {
						parsedContent = typeof content === "string" ? JSON.parse(content) : content;
					} catch (_e) {
						throw new Error("Invalid JSON content");
					}
					this.documents.set(id, parsedContent);
					return { content: parsedContent };
				},
				remove: async (id: string) => {
					if (!id) throw new Error("Missing document id for remove");
					const doc = this.documents.get(id);
					if (!doc) throw new Error("Document not found");
					this.documents.delete(id);
					return { content: { id } };
				},
			}),
			query: async (_query: string) => {
				const results = Array.from(this.documents.entries()).map(([id, content]) => ({
					id,
					...content,
				}));
				return {
					rows: results,
					meta: { mock: true },
				};
			},
		};
	}

	collections() {
		return {
			getAllScopes: async () => [
				{
					name: "_default",
					collections: [{ name: "_default" }],
				},
			],
		};
	}
}

export class MockCluster implements Partial<Cluster> {
	bucket(_name: string) {
		return new MockBucket() as Bucket;
	}

	async close() {
		return;
	}
}

export const mockConnection = {
	cluster: new MockCluster() as Cluster,
	defaultBucket: new MockBucket() as Bucket,
};

export const mockServer = {
	registeredTools: {} as Record<string, { schema: unknown; handler: ToolHandler }>,
	tool: (...args: unknown[]) => {
		let name: string;
		let schema: unknown;
		let handler: unknown;
		if (args.length === 4) {
			[name, , schema, handler] = args as [string, unknown, unknown, unknown];
		} else if (args.length === 3) {
			[name, schema, handler] = args as [string, unknown, unknown];
		} else {
			throw new Error("Invalid tool registration signature");
		}
		mockServer.registeredTools[name] = {
			schema,
			handler: typeof handler === "function" ? (handler as ToolHandler) : async () => undefined,
		};
		return mockServer;
	},
};
