// src/tools/code-analysis/project-id-param.ts
//
// SIO-1403: ONE schema for "which project", shared by every code-analysis tool.
//
// Before this, the same concept had four incompatible shapes across 27 tools: `project_id` was
// `z.number().int()` on list_merge_requests, `z.string()` on five others, `string|number` on ten
// proxied tools, and the proxy additionally exposed `id` as `string|number` on eleven more. A
// model that learned one call shape got a hard -32602 on the next -- the purest form of "the LLM
// calls tools incorrectly", with no prompt fix available, since any consistent choice it makes is
// wrong for some tool.
//
// Accepting both and coercing to string here is backward-compatible: every argument that was
// valid before is still valid, and `string|number` is already what 21 of the 27 tools accepted.
//
// On the SIO-771 note this supersedes ("numeric project_id is required -- URL-encoded paths 404
// against /api/v4"): re-verified live 2026-08-06 against gitlab.com, and BOTH a numeric id
// (`/projects/43242609`) and a URL-encoded path
// (`/projects/pvhcorp%2Fb2b%2Fshared-services%2Fpvh.services.styles`) return 200. The original
// 404 is better explained by the project-scoped access token of SIO-1401, which 404s on any
// project it does not own regardless of how the id is spelled. Critically, a NUMERIC ID PASSED AS
// A STRING was never the failing case -- `"43242609"` and `43242609` produce the identical
// request path, so widening the type cannot reintroduce that bug either way.

import { z } from "zod";

// GitLab's REST API takes the project identifier as a path segment, so a numeric id and its
// string form are indistinguishable once the URL is built. Coercing to string at the boundary
// means handlers and the REST client keep a single type.
export const ProjectIdParam = z
	.union([z.string().min(1), z.number().int()])
	.transform((value) => String(value))
	.describe(
		"GitLab project ID (numeric, e.g. 43242609 or \"43242609\") or URL-encoded path (e.g. 'group%2Fsubgroup%2Fproject'). Both a number and a string are accepted.",
	);

// Same value, described for tools where a numeric id is strongly preferred because the caller is
// expected to have resolved it from a search first.
export const NumericPreferredProjectIdParam = z
	.union([z.string().min(1), z.number().int()])
	.transform((value) => String(value))
	.describe(
		"GitLab project ID, numeric (e.g. 43242609) or its string form. A URL-encoded path also works. Prefer the numeric id resolved from gitlab_search.",
	);
