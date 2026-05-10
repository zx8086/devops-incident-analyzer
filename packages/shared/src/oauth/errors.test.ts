// src/oauth/errors.test.ts

import { describe, expect, test } from "bun:test";
import { OAuthRefreshChainExpiredError, OAuthRequiresInteractiveAuthError } from "./errors.ts";

describe("OAuthRefreshChainExpiredError", () => {
	test("carries namespace and hint and a message that mentions both", () => {
		const err = new OAuthRefreshChainExpiredError(
			"gitlab",
			"refresh_token rejected by https://gitlab.com; run `bun run oauth:seed:gitlab` to re-seed",
		);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("OAuthRefreshChainExpiredError");
		expect(err.namespace).toBe("gitlab");
		expect(err.hint).toContain("oauth:seed:gitlab");
		expect(err.message).toContain("gitlab");
		expect(err.message).toContain("refresh_token rejected");
	});

	test("is distinct from OAuthRequiresInteractiveAuthError", () => {
		const refresh = new OAuthRefreshChainExpiredError("gitlab", "x");
		const interactive = new OAuthRequiresInteractiveAuthError("gitlab", new URL("https://example.com"));
		expect(refresh).not.toBeInstanceOf(OAuthRequiresInteractiveAuthError);
		expect(interactive).not.toBeInstanceOf(OAuthRefreshChainExpiredError);
	});
});
