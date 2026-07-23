// src/lib/classifyCouchbaseError.ts
// SIO-1087: map a Couchbase SDK error onto the shared ToolErrorKind by its DOCUMENTED type
// (instanceof the exported error classes) and the stable N1QL first_error_code carried on
// `error.cause`, instead of regexing the message string. The SDK error survives on
// AppError.originalError, so the tool's catch point can classify structurally.

import type { ToolErrorKind } from "@devops-agent/shared";
import {
	AuthenticationFailureError,
	CollectionNotFoundError,
	type CouchbaseError,
	DocumentNotFoundError,
	IndexFailureError,
	IndexNotFoundError,
	ParsingFailureError,
	PlanningFailureError,
	ScopeNotFoundError,
	TimeoutError,
} from "couchbase";
import { AppError } from "./errors";

// Stable N1QL error codes (error.cause.first_error_code). 4000 = no index available / plan failure;
// 3000-3999 = parse/syntax. Used as a secondary discriminator when the class alone is ambiguous.
const N1QL_NO_INDEX_CODE = 4000;
const N1QL_SYNTAX_MIN = 3000;
const N1QL_SYNTAX_MAX = 3999;

function readFirstErrorCode(err: CouchbaseError): number | undefined {
	const cause = (err as { cause?: unknown }).cause;
	if (cause == null || typeof cause !== "object") return undefined;
	const code = (cause as { first_error_code?: unknown }).first_error_code;
	return typeof code === "number" ? code : undefined;
}

// Unwrap the real SDK error from an AppError (the tool wraps it as AppError.originalError).
export function unwrapCouchbaseError(error: unknown): unknown {
	if (error instanceof AppError && error.originalError) return error.originalError;
	return error;
}

// Returns the shared kind for a caught couchbase error, or "unknown" if it is not a recognizable
// SDK error. Classification is by instanceof + first_error_code -- never by message text.
export function classifyCouchbaseError(error: unknown): ToolErrorKind {
	const err = unwrapCouchbaseError(error);

	// PlanningFailureError with first_error_code 4000 is the "no index available on keyspace" case:
	// the collection exists but has no queryable index. A discovery outcome (no-index -> no-data),
	// NOT a malfunction -- must not cap confidence.
	if (err instanceof PlanningFailureError) {
		return readFirstErrorCode(err) === N1QL_NO_INDEX_CODE ? "no-index" : "bad-query";
	}
	if (err instanceof IndexNotFoundError || err instanceof IndexFailureError) return "no-index";
	if (err instanceof ParsingFailureError) return "bad-query";
	// A missing document / scope / collection is a not-found finding, not a malfunction.
	if (
		err instanceof DocumentNotFoundError ||
		err instanceof ScopeNotFoundError ||
		err instanceof CollectionNotFoundError
	) {
		return "not-found";
	}
	if (err instanceof AuthenticationFailureError) return "auth-denied";
	if (err instanceof TimeoutError) return "timeout";

	// Fall back to the N1QL code for a generic CouchbaseError whose class we don't special-case.
	if (err instanceof Error && "cause" in err) {
		const code = readFirstErrorCode(err as CouchbaseError);
		if (code === N1QL_NO_INDEX_CODE) return "no-index";
		if (code !== undefined && code >= N1QL_SYNTAX_MIN && code <= N1QL_SYNTAX_MAX) return "bad-query";
	}
	return "unknown";
}

// SIO-1087: structural replacement for the old `err.message.includes("index")` checks scattered in
// the schema/document resources. True when the error means "this collection has no usable index".
export function isNoIndexError(error: unknown): boolean {
	return classifyCouchbaseError(error) === "no-index";
}

// Compact log-side summary of a Couchbase SDK error. The raw SDK object carries
// cpp_core_span traces, dispatch endpoints, and full HTTP bodies -- logging it
// verbatim bloats every error line by kilobytes. Client-facing envelopes are
// built separately (buildToolErrorEnvelope); this is only for logger payloads.
export function summarizeCouchbaseError(error: unknown): {
	name: string;
	message: string;
	kind: ToolErrorKind;
	code?: number;
} {
	const err = unwrapCouchbaseError(error);
	const kind = classifyCouchbaseError(error);
	if (err instanceof Error) {
		const code = "cause" in err ? readFirstErrorCode(err as CouchbaseError) : undefined;
		return { name: err.name, message: err.message, kind, ...(code !== undefined ? { code } : {}) };
	}
	return { name: "UnknownError", message: String(err), kind };
}

// SIO-1087: structural replacement for `err.message.includes("not found")` -- a document/scope/
// collection that does not exist.
export function isNotFoundError(error: unknown): boolean {
	const err = unwrapCouchbaseError(error);
	return (
		err instanceof DocumentNotFoundError || err instanceof ScopeNotFoundError || err instanceof CollectionNotFoundError
	);
}
