// shared/src/tracing/client-detect.ts

export function detectClient(
	transportMode: string,
	userAgent?: string,
): { name: string; version?: string; platform?: string } {
	if (transportMode === "stdio") {
		return { name: "Claude Desktop", platform: process.platform };
	}

	if (userAgent) {
		if (userAgent.includes("n8n")) return { name: "n8n", platform: "web" };
		if (userAgent.includes("Chrome")) return { name: "Chrome Browser", platform: "web" };
		if (userAgent.includes("Safari")) return { name: "Safari Browser", platform: "web" };
	}

	return { name: "Web Client", platform: "web" };
}

export function generateSessionId(_connectionId: string, clientInfo?: { name?: string }): string {
	const timestamp = Date.now();
	const clientPrefix = clientInfo?.name?.toLowerCase().replace(/\s+/g, "-") || "unknown";
	const randomSuffix = Math.random().toString(36).substring(2, 8);
	return `${clientPrefix}-${timestamp}-${randomSuffix}`;
}
