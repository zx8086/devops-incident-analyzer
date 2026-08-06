// src/resources/resource-registry.ts

import type { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../utils/logger";

// SIO-1412: couchbase's OWN registry of every resource it registers on the SDK
// server, populated explicitly at registration time (threaded through
// registerAllResources -- no monkey-patching). server.ts's readResourceByUri
// generic fallback walks THIS instead of the SDK's private _registeredResources/
// _registeredResourceTemplates fields, whose reverse-engineered shape already
// broke once on an SDK internals change (SIO-1052). The SDK registration calls
// are unchanged, so protocol behavior (resources/list, resources/read) is
// untouched -- this is parallel bookkeeping for the in-process read path only.

export type TemplateVariables = Record<string, string | string[]>;
export type ExactReadCallback = (uri: URL) => Promise<unknown> | unknown;
export type TemplateReadCallback = (uri: URL, variables: TemplateVariables) => Promise<unknown> | unknown;

// SIO-1412 (CodeRabbit): three documentation resources register SCHEME-LESS URIs
// ("scope-documentation" and friends); a bare `new URL()` throws TypeError before
// their handler runs. Fall back to an opaque base so every registered URI reaches
// its handler; input unparsable even with the base keeps -32602 parity.
function toUrl(uri: string): URL {
	try {
		return new URL(uri);
	} catch {
		try {
			return new URL(uri, "resource://local/");
		} catch {
			throw new McpError(ErrorCode.InvalidParams, `Unparsable resource URI: ${uri}`);
		}
	}
}

export class ResourceRegistry {
	private readonly exact = new Map<string, ExactReadCallback>();
	private readonly templates: Array<{ template: ResourceTemplate; readCallback: TemplateReadCallback }> = [];

	addExact(uri: string, readCallback: ExactReadCallback): void {
		// Last registration wins (matches the SDK's own behavior); log so a collision
		// (e.g. a playbook literally named "test.md" vs the hardcoded debug resource)
		// is visible instead of silent.
		if (this.exact.has(uri)) {
			logger.debug({ uri }, "ResourceRegistry: duplicate exact URI registration; overwriting previous handler");
		}
		this.exact.set(uri, readCallback);
	}

	addTemplate(template: ResourceTemplate, readCallback: TemplateReadCallback): void {
		this.templates.push({ template, readCallback });
	}

	// Mirrors the SDK's own resources/read dispatch: exact URI first, then the
	// first matching template. Throws the same -32602 the SDK's real handler
	// throws for an unknown resource.
	async read(uri: string): Promise<unknown> {
		const exact = this.exact.get(uri);
		if (exact) {
			return await exact(toUrl(uri));
		}
		for (const { template, readCallback } of this.templates) {
			const variables = template.uriTemplate.match(uri);
			if (variables) {
				return await readCallback(toUrl(uri), variables);
			}
		}
		throw new McpError(ErrorCode.InvalidParams, `No resource handler found for URI: ${uri}`);
	}
}
