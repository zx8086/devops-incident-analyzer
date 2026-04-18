// shared/src/oauth-callback.ts

const DEFAULT_TIMEOUT_MS = 120_000;

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

export class OAuthCallbackTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`OAuth callback timed out after ${timeoutMs}ms -- user did not complete authorization`);
		this.name = "OAuthCallbackTimeoutError";
	}
}

export interface OAuthCallbackOptions {
	port: number;
	path: string;
	timeoutMs?: number;
	logger?: {
		info: (obj: Record<string, unknown>, msg: string) => void;
		error: (obj: Record<string, unknown>, msg: string) => void;
		warn: (obj: Record<string, unknown>, msg: string) => void;
	};
}

export interface OAuthCallbackResult {
	code: string;
}

export async function waitForOAuthCallback(
	options: OAuthCallbackOptions,
): Promise<OAuthCallbackResult> {
	const { port, path, logger } = options;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return new Promise<OAuthCallbackResult>((resolve, reject) => {
		let settled = false;

		const server = Bun.serve({
			port,
			hostname: "localhost",

			fetch(req) {
				const url = new URL(req.url);

				if (url.pathname !== path) {
					return new Response("Not found", { status: 404 });
				}

				const code = url.searchParams.get("code");
				const error = url.searchParams.get("error");

				if (code) {
					logger?.info({ port, path }, "OAuth authorization code received");
					settled = true;
					clearTimeout(timer);
					resolve({ code });
					setTimeout(() => server.stop(true), 3000);
					return new Response(SUCCESS_HTML, {
						headers: { "Content-Type": "text/html" },
					});
				}

				if (error) {
					const description =
						url.searchParams.get("error_description") || error;
					logger?.error(
						{ error: description },
						"OAuth authorization failed",
					);
					settled = true;
					clearTimeout(timer);
					// Defer rejection so the HTTP response is delivered before the
					// promise rejects -- prevents unhandled-rejection races in tests
					// where the caller awaits the fetch result before awaiting the promise.
					setTimeout(() => {
						reject(new Error(description));
						setTimeout(() => server.stop(true), 3000);
					}, 0);
					return new Response(ERROR_HTML(description), {
						status: 400,
						headers: { "Content-Type": "text/html" },
					});
				}

				return new Response(
					"Bad request: missing code or error parameter",
					{ status: 400 },
				);
			},
		});

		logger?.info(
			{ port, path, timeoutMs },
			"OAuth callback server started",
		);

		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				server.stop(true);
				logger?.error(
					{ port, timeoutMs },
					"OAuth callback server timed out",
				);
				reject(new OAuthCallbackTimeoutError(timeoutMs));
			}
		}, timeoutMs);
	});
}
