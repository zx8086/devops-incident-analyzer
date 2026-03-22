// src/config/helpers.ts

export function toBool(value: string | undefined, fallback: boolean): boolean {
	if (value === "true" || value === "1") return true;
	if (value === "false" || value === "0") return false;
	return fallback;
}

export function toNumber(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = parseInt(value, 10);
	return Number.isNaN(parsed) ? fallback : parsed;
}

export function splitCommaSeparated(value: string | undefined): string[] {
	if (value === undefined) return [];
	return value
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}
