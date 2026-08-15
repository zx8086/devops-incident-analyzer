// src/api/constants.ts

// Kong Konnect API region prefixes (subdomain on api.konghq.com).
// Lives here rather than in kong-api.ts so portal-api.ts can read it without
// importing back into kong-api.ts, which imports PortalApi from portal-api.ts
// -- that pairing formed an import cycle. As a plain value (not a type) the
// binding would sit in its temporal dead zone if module evaluation ever
// reached a module-scope read before the defining module finished.
export const API_REGIONS = {
	US: "us",
	EU: "eu",
	AU: "au",
	ME: "me",
	IN: "in",
} as const;
