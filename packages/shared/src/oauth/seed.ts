// src/oauth/seed.ts

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { waitForOAuthCallback } from "../oauth-callback.ts";
import { OAUTH_CALLBACK_PATH } from "./base-provider.ts";

interface SeedClientLike {
	connect(transport: Transport): Promise<void>;
}

interface SeedTransportLike extends Transport {
	finishAuth(code: string): Promise<void>;
}

export interface SeedOAuthOptions {
	provider: OAuthClientProvider;
	mcpUrl: URL;
	callbackPort: number;
	clientName: string;
	logger?: { info(msg: string): void; warn(msg: string): void };
	// Test seam: production uses the SDK's Client; tests inject a stub.
	makeClient?: () => SeedClientLike;
	// Test seam: production uses StreamableHTTPClientTransport; tests inject a stub.
	makeTransport?: (url: URL, opts: { authProvider: OAuthClientProvider }) => SeedTransportLike;
	// Test seam: production uses waitForOAuthCallback; tests skip the real listener.
	awaitCallback?: () => Promise<{ code: string }>;
}

export async function seedOAuth(options: SeedOAuthOptions): Promise<void> {
	const { provider, mcpUrl, callbackPort, clientName } = options;
	const log = options.logger ?? { info: console.log, warn: console.warn };

	const makeClient =
		options.makeClient ?? (() => new Client({ name: clientName, version: "0.1.0" }, { capabilities: {} }));
	const makeTransport = options.makeTransport ?? ((url, opts) => new StreamableHTTPClientTransport(url, opts));
	const awaitCallback =
		options.awaitCallback ?? (() => waitForOAuthCallback({ port: callbackPort, path: OAUTH_CALLBACK_PATH }));

	let client = makeClient();
	let transport = makeTransport(mcpUrl, { authProvider: provider });

	try {
		await client.connect(transport);
		log.info("Already authorized; tokens are present and the connection succeeded.");
		await transport.close();
		return;
	} catch (error) {
		if (!(error instanceof UnauthorizedError)) {
			throw error;
		}
	}

	log.info("Waiting for browser authorization...");
	const { code } = await awaitCallback();
	await transport.finishAuth(code);

	// Reconnect with the fresh tokens to verify the seeded state actually works.
	client = makeClient();
	transport = makeTransport(mcpUrl, { authProvider: provider });
	await client.connect(transport);
	await transport.close();

	log.info("Seeded OAuth tokens successfully.");
}
