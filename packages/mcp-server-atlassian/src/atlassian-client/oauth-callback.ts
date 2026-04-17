// src/atlassian-client/oauth-callback.ts

import { createContextLogger } from "../utils/logger.js";
import { OAUTH_CALLBACK_PATH } from "./oauth-provider.js";

const log = createContextLogger("oauth-callback");

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><title>Authorization Successful</title></head>
<body style="font-family:system-ui;text-align:center;padding:60px">
<h1>Authorization Successful</h1>
<p>You can close this window and return to the terminal.</p>
<script>setTimeout(()=>window.close(),3000)</script>
</body></html>`;

const ERROR_HTML = (error: string) => `<!DOCTYPE html>
<html><head><title>Authorization Failed</title></head>
<body style="font-family:system-ui;text-align:center;padding:60px">
<h1>Authorization Failed</h1>
<p>Error: ${error}</p>
</body></html>`;

export interface OAuthCallbackResult {
	code: string;
}

export async function waitForOAuthCallback(port: number): Promise<OAuthCallbackResult> {
	return new Promise<OAuthCallbackResult>((resolve, reject) => {
		const server = Bun.serve({
			port,
			hostname: "localhost",

			fetch(req) {
				const url = new URL(req.url);

				if (url.pathname !== OAUTH_CALLBACK_PATH) {
					return new Response("Not found", { status: 404 });
				}

				const code = url.searchParams.get("code");
				const error = url.searchParams.get("error");

				if (code) {
					log.info("OAuth authorization code received");
					resolve({ code });
					setTimeout(() => server.stop(true), 3000);
					return new Response(SUCCESS_HTML, {
						headers: { "Content-Type": "text/html" },
					});
				}

				if (error) {
					const description = url.searchParams.get("error_description") || error;
					log.error({ error: description }, "OAuth authorization failed");
					reject(new Error(`OAuth authorization failed: ${description}`));
					setTimeout(() => server.stop(true), 3000);
					return new Response(ERROR_HTML(description), {
						status: 400,
						headers: { "Content-Type": "text/html" },
					});
				}

				return new Response("Bad request: missing code or error parameter", { status: 400 });
			},
		});

		log.info({ port, path: OAUTH_CALLBACK_PATH }, "OAuth callback server started");
	});
}
