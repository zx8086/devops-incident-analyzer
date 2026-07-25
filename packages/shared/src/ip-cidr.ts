// shared/src/ip-cidr.ts
// SIO-1204: pure IPv4 CIDR containment for network-map placement. Replaces the
// Neo4j-article query-time UDF (ipBelongsToNetwork): lbug/Kuzu has no UDFs, so
// containment is computed here at ingest time and stored as explicit IN_SUBNET
// edges. IPv4 only by design -- a false negative merely omits a derived edge,
// never mints a wrong one, so every malformed/IPv6 input returns false/null
// instead of throwing. Browser-safe: no Node/Bun imports.

export function parseIpv4(ip: string): number | null {
	const parts = ip.split(".");
	if (parts.length !== 4) return null;
	let value = 0;
	for (const part of parts) {
		// Reject empty octets, signs, whitespace, and non-digits ("1e2", "+3", " 4").
		if (part.length === 0 || part.length > 3 || !/^\d+$/.test(part)) return null;
		const octet = Number(part);
		if (octet > 255) return null;
		value = value * 256 + octet;
	}
	// Keep the result an unsigned 32-bit value (>>> 0 avoids the sign bit).
	return value >>> 0;
}

export function ipInCidr(ip: string, cidr: string): boolean {
	const slash = cidr.indexOf("/");
	if (slash <= 0) return false;
	const network = parseIpv4(cidr.slice(0, slash));
	if (network === null) return false;
	const prefixRaw = cidr.slice(slash + 1);
	if (!/^\d{1,2}$/.test(prefixRaw)) return false;
	const prefix = Number(prefixRaw);
	if (prefix > 32) return false;
	const addr = parseIpv4(ip);
	if (addr === null) return false;
	if (prefix === 0) return true;
	// (-1 << (32 - prefix)) builds the mask; >>> 0 keeps unsigned semantics.
	const mask = (-1 << (32 - prefix)) >>> 0;
	return (addr & mask) >>> 0 === (network & mask) >>> 0;
}
