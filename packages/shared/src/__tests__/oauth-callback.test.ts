// shared/src/__tests__/oauth-callback.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import {
	OAuthCallbackTimeoutError,
	waitForOAuthCallback,
} from "../oauth-callback.ts";

let serverPort = 19_400;

afterEach(() => {
	serverPort++;
});

describe("waitForOAuthCallback", () => {
	test("resolves with code on valid callback", async () => {
		const path = "/oauth/callback";
		const promise = waitForOAuthCallback({ port: serverPort, path });

		await Bun.sleep(50);

		const res = await fetch(
			`http://localhost:${serverPort}${path}?code=test_auth_code`,
		);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("Authorization Successful");

		const result = await promise;
		expect(result.code).toBe("test_auth_code");
	});

	test("rejects on error callback", async () => {
		const path = "/oauth/callback";
		const promise = waitForOAuthCallback({ port: serverPort, path });

		await Bun.sleep(50);

		const res = await fetch(
			`http://localhost:${serverPort}${path}?error=access_denied&error_description=User%20denied`,
		);
		expect(res.status).toBe(400);
		const html = await res.text();
		expect(html).toContain("Authorization Failed");

		await expect(promise).rejects.toThrow("User denied");
	});

	test("rejects with OAuthCallbackTimeoutError on timeout", async () => {
		const path = "/oauth/callback";
		const promise = waitForOAuthCallback({
			port: serverPort,
			path,
			timeoutMs: 300,
		});

		await expect(promise).rejects.toThrow(OAuthCallbackTimeoutError);
	});

	test("server port is freed after timeout", async () => {
		const path = "/oauth/callback";
		const port = serverPort;
		const promise = waitForOAuthCallback({
			port,
			path,
			timeoutMs: 200,
		});

		try {
			await promise;
		} catch {
			// expected
		}

		await Bun.sleep(100);

		const testServer = Bun.serve({
			port,
			hostname: "localhost",
			fetch() {
				return new Response("ok");
			},
		});
		expect(testServer.port).toBe(port);
		testServer.stop(true);
	});

	test("returns 404 for wrong path", async () => {
		const path = "/oauth/callback";
		const promise = waitForOAuthCallback({
			port: serverPort,
			path,
			timeoutMs: 2000,
		});

		await Bun.sleep(50);

		const res = await fetch(`http://localhost:${serverPort}/wrong-path`);
		expect(res.status).toBe(404);

		await fetch(
			`http://localhost:${serverPort}${path}?code=cleanup`,
		);
		await promise;
	});

	test("returns 400 for missing code and error params", async () => {
		const path = "/oauth/callback";
		const promise = waitForOAuthCallback({
			port: serverPort,
			path,
			timeoutMs: 2000,
		});

		await Bun.sleep(50);

		const res = await fetch(`http://localhost:${serverPort}${path}`);
		expect(res.status).toBe(400);

		await fetch(
			`http://localhost:${serverPort}${path}?code=cleanup`,
		);
		await promise;
	});
});
