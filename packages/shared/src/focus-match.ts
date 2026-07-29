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

// SIO-1210: incident-sourced focus tokens are often PascalCase/camelCase
// (e.g. `NotificationService`, from a ticket title or normalized entity name)
// while real infra names are hyphenated (`notification-service`). Insert a
// hyphen at lower/digit -> upper transitions BEFORE normalize()'s lowercasing
// so tokenize() sees the same word boundaries either style expresses. Two
// passes: lower/digit->upper (`fooBar`) and acronym->word (`APIGateway`,
// `HTTPService`) -- a single pass leaves consecutive-capital acronyms glued
// to the following word.
function splitCamelCase(s: string): string {
	return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2");
}

export function tokenize(s: string): Set<string> {
	// SIO-785: depluralise per token so `articles` matches `article`. The whole-string
	// normalize only strips a single trailing `s`, but kafka group ids embed plural
	// nouns mid-string (e.g. `pim-sink-articles`).
	//
	// SIO-1284: \s is in the split class because five call sites pass FREE PROSE, not an
	// identifier: the gitlab (title+description), aws alarm, atlassian (key+summary) and
	// orbit extractors, plus rules.ts. Without it a whitespace-separated title collapses
	// into ONE token that fails both the MIN_TOKEN_LENGTH filter and the overlap check --
	// "Add retry to SAP draft order sink" tokenized to a single 29-char string and was
	// dropped against focus `prana-order-service` despite containing the word `order`.
	// The GitLab card was therefore empty on every focused run (droppedAll: true).
	// Identifier tokenization is UNCHANGED: ARNs, log groups, consumer-group ids, kafka
	// topics and gitlab paths contain no whitespace -- verified zero drift across all of
	// them, which is what keeps the SIO-1268 ECS ledger and SIO-1261 gitlab probe intact.
	return new Set(
		normalize(splitCamelCase(s))
			.split(/[-_.\s]/)
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
		if (sNorm.length === 0) continue;
		// Exact normalized equality always matches (a short but exact name is unambiguous).
		if (sNorm === hNorm) return true;
		// SIO-1103 CodeRabbit: the FUZZY substring path (one normalized value contained in
		// the other) requires BOTH to meet MIN_TOKEN_LENGTH -- otherwise a short focus like
		// "cat" scopes in "catalog-service" (sNorm "cat" ⊂ hNorm "catalog"). This mirrors the
		// MIN_TOKEN_LENGTH filter tokenize() already applies to the token-overlap path.
		if (
			sNorm.length >= MIN_TOKEN_LENGTH &&
			hNorm.length >= MIN_TOKEN_LENGTH &&
			(hNorm.includes(sNorm) || sNorm.includes(hNorm))
		) {
			return true;
		}
		const sTokens = tokenize(svc);
		for (const t of sTokens) {
			if (hTokens.has(t)) return true;
		}
	}
	return false;
}
