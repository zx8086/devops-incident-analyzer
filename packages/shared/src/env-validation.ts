// packages/shared/src/env-validation.ts
import { z } from "zod";

export type EnvLogger = {
	warn: (obj: Record<string, unknown>, msg: string) => void;
};

const noopLogger: EnvLogger = { warn: () => {} };

function readValidatedEnv(name: string, defaultValue: number, schema: z.ZodTypeAny, logger: EnvLogger): number {
	const raw = process.env[name];
	if (raw === undefined) return defaultValue;
	const parsed = schema.safeParse(Number(raw));
	if (!parsed.success) {
		logger.warn({ name, raw, defaultValue }, "invalid env var, falling back to default");
		return defaultValue;
	}
	return parsed.data as number;
}

// Accepts fractional milliseconds -- Number("5000.5") is valid input today and
// setTimeout/Date.now() arithmetic tolerates non-integer ms, so there is no
// functional reason to reject it.
export function readPositiveMsEnv(name: string, defaultValue: number, logger: EnvLogger = noopLogger): number {
	return readValidatedEnv(name, defaultValue, z.number().finite().positive(), logger);
}

// For counts/byte-sizes where a fractional value has no meaning (e.g. concurrency,
// byte-tail length).
export function readPositiveIntEnv(name: string, defaultValue: number, logger: EnvLogger = noopLogger): number {
	return readValidatedEnv(name, defaultValue, z.number().finite().positive().int(), logger);
}
