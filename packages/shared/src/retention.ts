// shared/src/retention.ts

const UNIT_MS: Record<string, number> = {
	d: 86_400_000,
	w: 604_800_000,
	m: 2_592_000_000, // 30 days
	y: 31_536_000_000, // 365 days
};

export function parseRetentionPeriod(period: string): number {
	const match = period.match(/^(\d+)([dwmy])$/);
	if (!match) throw new Error(`Invalid retention period format: "${period}". Expected e.g. "1y", "30d", "6m".`);

	const value = Number(match[1]);
	const unit = match[2] as string;
	return value * (UNIT_MS[unit] ?? 0);
}

export function getRetentionExpiresAt(period: string, now?: Date): string {
	const ms = parseRetentionPeriod(period);
	const base = now ?? new Date();
	return new Date(base.getTime() + ms).toISOString();
}
