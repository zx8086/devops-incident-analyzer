// src/__tests__/oauth/seed.test.ts

import { describe, expect, test } from "bun:test";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { seedOAuth } from "../../oauth/seed.ts";

function makeProvider(): OAuthClientProvider {
	return {
		get redirectUrl() {
			return "http://localhost:9999/oauth/callback";
		},
		get clientMetadata() {
			return {
				client_name: "test",
				redirect_uris: ["http://localhost:9999/oauth/callback"],
				grant_types: ["authorization_code"],
				response_types: ["code"],
				token_endpoint_auth_method: "none" as const,
			};
		},
		clientInformation: () => undefined,
		saveClientInformation: () => {},
		tokens: () => undefined,
		saveTokens: () => {},
		redirectToAuthorization: async () => {},
		saveCodeVerifier: () => {},
		codeVerifier: () => "verifier",
		invalidateCredentials: () => {},
	};
}

interface StubTransport {
	start: () => Promise<void>;
	send: () => Promise<void>;
	close: () => Promise<void>;
	finishAuth: (code: string) => Promise<void>;
}

function stubTransport(overrides: Partial<StubTransport> = {}): StubTransport {
	return {
		start: async () => {},
		send: async () => {},
		close: async () => {},
		finishAuth: async () => {},
		...overrides,
	};
}

describe("seedOAuth", () => {
	test("returns early when first connect succeeds (already-authorized path)", async () => {
		const log = { messages: [] as string[], info: (m: string) => log.messages.push(m), warn: () => {} };
		let connectCalls = 0;
		let finishAuthCalls = 0;

		await seedOAuth({
			provider: makeProvider(),
			mcpUrl: new URL("https://example.com/mcp"),
			callbackPort: 9999,
			clientName: "test-seed",
			logger: log,
			makeClient: () => ({
				connect: async () => {
					connectCalls += 1;
				},
			}),
			makeTransport: () =>
				stubTransport({
					finishAuth: async () => {
						finishAuthCalls += 1;
					},
				}) as unknown as ReturnType<NonNullable<Parameters<typeof seedOAuth>[0]["makeTransport"]>>,
			awaitCallback: async () => ({ code: "should-not-be-called" }),
		});

		expect(connectCalls).toBe(1);
		expect(finishAuthCalls).toBe(0);
		expect(log.messages.some((m) => m.toLowerCase().includes("already authorized"))).toBe(true);
	});

	test("on UnauthorizedError, awaits callback, calls finishAuth, and reconnects", async () => {
		const log = { messages: [] as string[], info: (m: string) => log.messages.push(m), warn: () => {} };
		let connectCalls = 0;
		const finishAuthArgs: string[] = [];

		await seedOAuth({
			provider: makeProvider(),
			mcpUrl: new URL("https://example.com/mcp"),
			callbackPort: 9999,
			clientName: "test-seed",
			logger: log,
			makeClient: () => ({
				connect: async () => {
					connectCalls += 1;
					if (connectCalls === 1) {
						throw new UnauthorizedError("auth required");
					}
				},
			}),
			makeTransport: () =>
				stubTransport({
					finishAuth: async (code: string) => {
						finishAuthArgs.push(code);
					},
				}) as unknown as ReturnType<NonNullable<Parameters<typeof seedOAuth>[0]["makeTransport"]>>,
			awaitCallback: async () => ({ code: "abc-from-callback" }),
		});

		expect(connectCalls).toBe(2);
		expect(finishAuthArgs).toEqual(["abc-from-callback"]);
		expect(log.messages.some((m) => m.toLowerCase().includes("seeded oauth tokens successfully"))).toBe(true);
	});

	test("non-Unauthorized errors propagate untouched", async () => {
		const log = { messages: [] as string[], info: () => {}, warn: () => {} };

		await expect(
			seedOAuth({
				provider: makeProvider(),
				mcpUrl: new URL("https://example.com/mcp"),
				callbackPort: 9999,
				clientName: "test-seed",
				logger: log,
				makeClient: () => ({
					connect: async () => {
						throw new Error("network down");
					},
				}),
				makeTransport: () =>
					stubTransport() as unknown as ReturnType<NonNullable<Parameters<typeof seedOAuth>[0]["makeTransport"]>>,
				awaitCallback: async () => ({ code: "unused" }),
			}),
		).rejects.toThrow(/network down/);
	});
});
