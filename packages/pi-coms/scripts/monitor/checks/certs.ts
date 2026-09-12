// scripts/monitor/checks/certs.ts
import {
	type CertificateDetail,
	DescribeCertificateCommand,
	type DescribeCertificateCommandOutput,
	ListCertificatesCommand,
	type ListCertificatesCommandOutput,
} from "@aws-sdk/client-acm";

import {
	DescribeListenerCertificatesCommand,
	type DescribeListenerCertificatesCommandOutput,
	DescribeListenersCommand,
	type DescribeListenersCommandOutput,
	DescribeLoadBalancersCommand,
	type DescribeLoadBalancersCommandOutput,
} from "@aws-sdk/client-elastic-load-balancing-v2";

// Re-exported so tests need no direct dependency on the SDK (it lives in scripts/package.json).
export type { DescribeCertificateCommand };
export {
	DescribeListenerCertificatesCommand,
	DescribeListenersCommand,
	DescribeLoadBalancersCommand,
	ListCertificatesCommand,
};

import { errorMessage } from "../errors.ts";
import type { Finding } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

// ACM-managed certs renew ~60 days before expiry, so anything inside 30 days
// means renewal is failing -- a fully predictable outage.
const WARN_DAYS = 30;
const CRIT_DAYS = 7;
const REALERT_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;

// Only certificates with an expiry take part in the scan.
type DatedCert = CertificateDetail & { NotAfter: Date };
function hasNotAfter(c: CertificateDetail | undefined): c is DatedCert {
	return c?.NotAfter != null;
}

export type CheckCertsOpts = { now?: number; warnDays?: number; critDays?: number };
export type RegionalAcm = { region: string; client: AwsClient };

// The host region plus us-east-1 by default: CloudFront certificates must
// live in us-east-1, so an expiring one is invisible to a host-region scan.
export function certRegions(hostRegion: string | undefined, envList: string | undefined): string[] {
	const list = envList
		? envList
				.split(",")
				.map((r) => r.trim())
				.filter((r) => r.length > 0)
		: [hostRegion, "us-east-1"].filter((r): r is string => typeof r === "string" && r.length > 0);
	return [...new Set(list)];
}

export async function checkCerts(
	clients: RegionalAcm[],
	state: MonitorState,
	opts: CheckCertsOpts = {},
): Promise<Finding[]> {
	const now = opts.now ?? Date.now();
	const warnDays = opts.warnDays ?? WARN_DAYS;
	const critDays = opts.critDays ?? CRIT_DAYS;
	const findings: Finding[] = [];
	const at = new Date(now).toISOString();

	// Describe everything first: whether an expiring cert matters depends on
	// what else covers its domain (a rotated-out cert is noise, not risk).
	const certs: {
		arn: string;
		region: string;
		cert: DatedCert;
		daysLeft: number;
		names: string[];
	}[] = [];
	for (const { region, client } of clients) {
		try {
			const arns: string[] = [];
			let nextToken: string | undefined;
			do {
				const resp = (await client.send(
					new ListCertificatesCommand({ NextToken: nextToken }),
				)) as ListCertificatesCommandOutput;
				for (const c of resp.CertificateSummaryList ?? []) if (c.CertificateArn) arns.push(c.CertificateArn);
				nextToken = resp.NextToken;
			} while (nextToken);
			for (const arn of arns) {
				const resp = (await client.send(
					new DescribeCertificateCommand({ CertificateArn: arn }),
				)) as DescribeCertificateCommandOutput;
				const cert = resp.Certificate;
				if (!hasNotAfter(cert)) continue;
				const daysLeft = Math.floor((new Date(cert.NotAfter).getTime() - now) / DAY_MS);
				const names = [cert.DomainName, ...(cert.SubjectAlternativeNames ?? [])].filter(
					(n: unknown): n is string => typeof n === "string" && n.length > 0,
				);
				certs.push({ arn, region, cert, daysLeft, names });
			}
		} catch (e) {
			// One unreachable region must not kill the scan: report it once as an
			// info scoping fact and keep scanning the other regions.
			const scopeKey = `cert:scope:${region}:`;
			if (state.shouldAlert(scopeKey)) {
				state.markAlerted(scopeKey, "cert");
				findings.push({
					family: "cert",
					severity: "info",
					resource: region,
					summary: `ACM in ${region} is unreadable (not inspected): ${errorMessage(e)}`,
					dedup_key: scopeKey,
					evidence: { region, error: errorMessage(e) },
					at,
				});
			}
		}
	}

	for (const { arn, region, cert, daysLeft } of certs) {
		if (daysLeft > warnDays) continue;
		const domain: string = cert.DomainName ?? arn;
		// Same-region only: a valid cert elsewhere cannot serve resources bound
		// to this region (CloudFront needs us-east-1), so cross-region
		// supersession would mask a real gap.
		const successor = certs.find(
			(s) => s.arn !== arn && s.region === region && s.daysLeft > warnDays && s.names.some((n) => covers(n, domain)),
		);
		// An expiry only breaks TLS when something actually serves the
		// certificate, so InUseBy decides severity rather than merely decorating
		// the evidence: an unattached certificate is cleanup, reported as info so
		// it stays discoverable without paging. Without this an expired-and-
		// detached certificate scores a negative daysLeft, satisfies
		// `daysLeft <= critDays` and pages critical forever (SIO-1724).
		const inUseBy = cert.InUseBy ?? [];
		const inUse = inUseBy.length > 0;
		const severity = successor || !inUse ? "info" : daysLeft <= critDays ? "critical" : "warn";
		const key = `cert:${arn}:${severity}`;
		if (!state.shouldAlert(key, REALERT_MS)) continue;
		state.markAlerted(key, "cert");
		const supersededNote = successor
			? `; superseded by a valid certificate for ${successor.cert.DomainName ?? successor.arn} (expires ${new Date(successor.cert.NotAfter).toISOString()})`
			: "";
		// A past expiry reads as "expired N day(s) ago", never "expires in -N days".
		const expiredNote = daysLeft < 0 ? `expired ${-daysLeft} day(s) ago` : `expires in ${daysLeft} day(s)`;
		const unusedNote = inUse ? "" : "; not in use by any resource";
		findings.push({
			family: "cert",
			severity,
			resource: domain,
			summary: `Certificate ${domain} (${region}) ${expiredNote}${unusedNote}${supersededNote}`,
			dedup_key: key,
			evidence: {
				arn,
				region,
				notAfter: new Date(cert.NotAfter).toISOString(),
				daysLeft,
				renewalEligibility: cert.RenewalEligibility ?? null,
				inUseBy,
				...(successor
					? {
							supersededBy: {
								arn: successor.arn,
								domain: successor.cert.DomainName ?? null,
								notAfter: new Date(successor.cert.NotAfter).toISOString(),
							},
						}
					: {}),
			},
			at,
		});
	}
	return findings;
}

// An ACM scan alone cannot answer "is this domain covered?": an ALB listener
// can carry extra SNI certificates beyond its default, and a name may terminate
// somewhere ACM never sees (CloudFront, another account, or a non-ACM
// gateway). DescribeListenerCertificates is the only read that distinguishes
// "no cert" from "a cert we are not allowed to enumerate", so an AccessDenied
// here is reported as a scoping fact, never as coverage.
export async function checkListenerCerts(
	clients: RegionalAcm[],
	state: MonitorState,
	opts: { now?: number } = {},
): Promise<Finding[]> {
	const now = opts.now ?? Date.now();
	const at = new Date(now).toISOString();
	const findings: Finding[] = [];

	for (const { region, client } of clients) {
		const scopeKey = `cert:sni:scope:${region}:`;
		try {
			const lbArns: string[] = [];
			let marker: string | undefined;
			do {
				const resp = (await client.send(
					new DescribeLoadBalancersCommand({ Marker: marker }),
				)) as DescribeLoadBalancersCommandOutput;
				for (const lb of resp.LoadBalancers ?? []) if (lb.LoadBalancerArn) lbArns.push(lb.LoadBalancerArn);
				marker = resp.NextMarker;
			} while (marker);

			for (const lbArn of lbArns) {
				const listeners: { arn: string; defaultArn: string | null }[] = [];
				let lMarker: string | undefined;
				do {
					const resp = (await client.send(
						new DescribeListenersCommand({ LoadBalancerArn: lbArn, Marker: lMarker }),
					)) as DescribeListenersCommandOutput;
					for (const l of resp.Listeners ?? []) {
						// Only TLS-terminating listeners carry certificates.
						if (!l.ListenerArn || (l.Certificates ?? []).length === 0) continue;
						listeners.push({ arn: l.ListenerArn, defaultArn: l.Certificates?.[0]?.CertificateArn ?? null });
					}
					lMarker = resp.NextMarker;
				} while (lMarker);

				for (const listener of listeners) {
					// DescribeListeners returns only the default cert; the extra SNI
					// certs are a separate read, and that read is what used to be denied.
					const sniArns: string[] = [];
					let cMarker: string | undefined;
					do {
						const resp = (await client.send(
							new DescribeListenerCertificatesCommand({ ListenerArn: listener.arn, Marker: cMarker }),
						)) as DescribeListenerCertificatesCommandOutput;
						for (const c of resp.Certificates ?? []) {
							if (c.CertificateArn && !c.IsDefault) sniArns.push(c.CertificateArn);
						}
						cMarker = resp.NextMarker;
					} while (cMarker);

					if (sniArns.length === 0) continue;
					const key = `cert:sni:${listener.arn}`;
					if (!state.shouldAlert(key, REALERT_MS)) continue;
					state.markAlerted(key, "cert");
					findings.push({
						family: "cert",
						severity: "info",
						resource: listener.arn,
						summary: `Listener ${listener.arn} (${region}) carries ${sniArns.length} extra SNI certificate(s) beyond its default`,
						dedup_key: key,
						evidence: {
							region,
							loadBalancerArn: lbArn,
							listenerArn: listener.arn,
							defaultCertificateArn: listener.defaultArn,
							sniCertificateArns: sniArns,
						},
						at,
					});
				}
			}
		} catch (e) {
			// The whole point of this check: a denied or unreachable read must say
			// "not inspected", so absence of a finding is never read as coverage.
			if (!state.shouldAlert(scopeKey)) continue;
			state.markAlerted(scopeKey, "cert");
			findings.push({
				family: "cert",
				severity: "info",
				resource: region,
				summary: `Listener certificates in ${region} are unreadable (not inspected -- SNI certificates beyond each listener default are unknown): ${errorMessage(e)}`,
				dedup_key: scopeKey,
				evidence: { region, error: errorMessage(e) },
				at,
			});
		}
	}
	return findings;
}

// Exact match, or single-label wildcard: *.example.com covers a.example.com
// but not example.com or a.b.example.com.
function covers(name: string, domain: string): boolean {
	if (name === domain) return true;
	if (!name.startsWith("*.")) return false;
	const suffix = name.slice(2);
	return domain.endsWith(`.${suffix}`) && !domain.slice(0, -suffix.length - 1).includes(".");
}
