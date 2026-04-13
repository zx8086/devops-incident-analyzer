// src/gitlab-client/index.ts

import { createContextLogger } from "../utils/logger.js";

const log = createContextLogger("gitlab-api");

export interface GitLabRestConfig {
	instanceUrl: string;
	personalAccessToken: string;
	timeout: number;
}

interface RequestOptions {
	path: string;
	method?: "GET" | "POST" | "PUT" | "DELETE";
	query?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
}

export class GitLabRestClient {
	private readonly baseUrl: string;
	private readonly headers: Record<string, string>;
	private readonly timeout: number;

	constructor(config: GitLabRestConfig) {
		this.baseUrl = `${config.instanceUrl}/api/v4`;
		this.headers = {
			"PRIVATE-TOKEN": config.personalAccessToken,
			"Content-Type": "application/json",
		};
		this.timeout = config.timeout;
	}

	private async request<T>(options: RequestOptions): Promise<T> {
		const url = new URL(`${this.baseUrl}${options.path}`);
		if (options.query) {
			for (const [key, value] of Object.entries(options.query)) {
				if (value !== undefined) {
					url.searchParams.set(key, String(value));
				}
			}
		}

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeout);

		try {
			const response = await fetch(url.toString(), {
				method: options.method || "GET",
				headers: this.headers,
				body: options.body ? JSON.stringify(options.body) : undefined,
				signal: controller.signal,
			});

			if (!response.ok) {
				const errorBody = await response.text().catch(() => "");
				throw new Error(`GitLab API error ${response.status}: ${response.statusText}. ${errorBody}`);
			}

			return (await response.json()) as T;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	async getFileContent(
		projectId: string,
		filePath: string,
		ref = "HEAD",
	): Promise<{
		file_name: string;
		file_path: string;
		size: number;
		content: string;
		encoding: string;
		ref: string;
	}> {
		const encodedPath = encodeURIComponent(filePath);
		log.debug({ projectId, filePath, ref }, "Getting file content");
		return this.request({
			path: `/projects/${encodeURIComponent(projectId)}/repository/files/${encodedPath}`,
			query: { ref },
		});
	}

	async getBlame(
		projectId: string,
		filePath: string,
		ref = "HEAD",
	): Promise<
		Array<{
			commit: {
				id: string;
				message: string;
				authored_date: string;
				author_name: string;
				author_email: string;
			};
			lines: string[];
		}>
	> {
		const encodedPath = encodeURIComponent(filePath);
		log.debug({ projectId, filePath, ref }, "Getting file blame");
		return this.request({
			path: `/projects/${encodeURIComponent(projectId)}/repository/files/${encodedPath}/blame`,
			query: { ref },
		});
	}

	async getCommitDiff(
		projectId: string,
		sha: string,
	): Promise<
		Array<{
			old_path: string;
			new_path: string;
			a_mode: string;
			b_mode: string;
			diff: string;
			new_file: boolean;
			renamed_file: boolean;
			deleted_file: boolean;
		}>
	> {
		log.debug({ projectId, sha }, "Getting commit diff");
		return this.request({
			path: `/projects/${encodeURIComponent(projectId)}/repository/commits/${sha}/diff`,
		});
	}

	async listCommits(
		projectId: string,
		options?: {
			ref_name?: string;
			since?: string;
			until?: string;
			path?: string;
			per_page?: number;
			page?: number;
		},
	): Promise<
		Array<{
			id: string;
			short_id: string;
			title: string;
			message: string;
			author_name: string;
			author_email: string;
			authored_date: string;
			committed_date: string;
			web_url: string;
		}>
	> {
		log.debug({ projectId, ...options }, "Listing commits");
		return this.request({
			path: `/projects/${encodeURIComponent(projectId)}/repository/commits`,
			query: options as Record<string, string | number | boolean | undefined>,
		});
	}

	async getRepositoryTree(
		projectId: string,
		options?: {
			path?: string;
			ref?: string;
			recursive?: boolean;
			per_page?: number;
			page?: number;
		},
	): Promise<
		Array<{
			id: string;
			name: string;
			type: "tree" | "blob";
			path: string;
			mode: string;
		}>
	> {
		log.debug({ projectId, ...options }, "Getting repository tree");
		return this.request({
			path: `/projects/${encodeURIComponent(projectId)}/repository/tree`,
			query: options as Record<string, string | number | boolean | undefined>,
		});
	}
}
