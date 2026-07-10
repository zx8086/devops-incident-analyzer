/* src/utils/zodHelpers.ts */

import { z } from "zod";

export const coerceBoolean = z.union([z.boolean(), z.string().transform((val) => val === "true" || val === "1")]);

// SIO-659: this helper historically defaulted to `false`, which silently turned
// every undefined boolean parameter into an explicit `?opt=false` on the outgoing
// ES request (e.g. `_source=false` stripped the document body in get_document,
// `realtime=false` forced non-realtime reads). Now: when no defaultValue is
// provided, absent keys stay undefined and the v9 client drops them from the URL,
// letting ES use its own documented defaults. Callers that genuinely want a
// false default must opt in explicitly with booleanField(false, "...").
export const booleanField = (defaultValue?: boolean, description?: string) => {
	const field = defaultValue === undefined ? coerceBoolean : coerceBoolean.default(defaultValue);
	return description ? field.describe(description) : field;
};
