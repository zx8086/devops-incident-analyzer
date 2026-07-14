// packages/shared/src/focus-match.ts
// SIO-1030: shared fuzzy matcher for scoping finding cards to the investigation
// focus. normalize/tokenize were file-private in extractors/kafka.ts (SIO-785);
// lifted here so every extractor and correlation/rules.ts share one matcher instead
// of each re-implementing (or drifting on) service-name matching.
//
// SIO-1103: moved from packages/agent/src/correlation/ into @devops-agent/shared so
// non-agent consumers (the knowledge-graph confirm-binding CLI, staleness) can key
// graph identity on the SAME normalization the correlation rules use -- graph Alias
// identity and rule scoping cannot drift. The old path re-exports these for
// back-compat, so every existing agent import site is unchanged.

// SIO-785: tokens used as suffixes/qualifiers on kafka consumer-group ids that
// should be stripped before fuzzy-matching against APM service names. Kafka groups
// often look like `<service>-prod-consumer`, `<service>-sink`, `<service>-eventing`.
const SUFFIX_PATTERN = /-?(consumer|sink|eventing|prod|stg|dev|svc|service)$/g;
const MIN_TOKEN_LENGTH = 4;

export function normalize(s: string): string {
	let result = s.toLowerCase();
	// Strip suffix tokens iteratively (a group can be e.g. `notifications-service-consumer`).
	let prev = "";
	while (prev !== result) {
		prev = result;
		result = result.replace(SUFFIX_PATTERN, "");
	}
	// Singular form: drop trailing `s` (handles notifications-service vs notification-service).
	result = result.replace(/s$/, "");
	// SIO-1030: a name that is entirely suffix tokens (e.g. "prod-service", "svc-service",
	// or bare "service") strips to "". An empty normalized form breaks matchesFocus two ways:
	// a focus service that empties is silently skipped (false negative), and an empty haystack
	// makes `sNorm.includes("")` true for every focus (false positive). Fall back to the
	// lowercased original so such names still compare literally instead of vanishing.
	return result.length > 0 ? result : s.toLowerCase();
}

export function tokenize(s: string): Set<string> {
	// SIO-785: depluralise per token so `articles` matches `article`. The whole-string
	// normalize only strips a single trailing `s`, but kafka group ids embed plural
	// nouns mid-string (e.g. `pim-sink-articles`).
	return new Set(
		normalize(s)
			.split(/[-_.]/)
			.filter((t) => t.length >= MIN_TOKEN_LENGTH)
			.map((t) => t.replace(/s$/, "")),
	);
}

// SIO-1030: "related to" match between a finding's service-naming text (haystack)
// and the investigation focus services. Same predicate the kafka extractor has used
// since SIO-785 (normalized substring OR token overlap). GUARDRAIL: empty focus =>
// match everything (show-all on first-turn / unfocused investigations). The
// MIN_TOKEN_LENGTH=4 filter in tokenize() is what stops short focus tokens (e.g.
// "api") from matching unrelated names (e.g. "authentication-service").
export function matchesFocus(haystack: string, focusServices: string[]): boolean {
	if (focusServices.length === 0) return true;
	if (!haystack) return false;
	const hNorm = normalize(haystack);
	const hTokens = tokenize(haystack);
	for (const svc of focusServices) {
		const sNorm = normalize(svc);
		if (sNorm.length > 0 && (hNorm.includes(sNorm) || sNorm.includes(hNorm))) return true;
		const sTokens = tokenize(svc);
		for (const t of sTokens) {
			if (hTokens.has(t)) return true;
		}
	}
	return false;
}
