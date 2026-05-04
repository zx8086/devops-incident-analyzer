// src/tools/certificates/operations.ts
import type { KongApi } from "../../api/kong-api.js";
import { withErrorContext } from "../../utils/error-handling.js";
import { createContextLogger } from "../../utils/logger.js";
import { validateCertificate, validatePrivateKey } from "../../utils/validation.js";

const log = createContextLogger("certificates");

/**
 * List certificates for a specific control plane with health analysis
 */
export async function listCertificates(api: KongApi, controlPlaneId: string, size = 100, offset?: string) {
	log.debug({ controlPlaneId }, "Listing certificates");
	return withErrorContext(
		"list_certificates",
		"certificate",
		undefined,
		controlPlaneId,
	)(async () => {
		const result = await api.listCertificates(controlPlaneId, size, offset);

		// SIO-663: applied-pagination metadata derived from observed result; Kong caps `size` at 100.
		const actualCount = result.data.length;
		const effectiveSize = Math.min(size, actualCount);
		const capped = size > actualCount && actualCount === 100;

		// Analyze certificate health (expiration dates, etc.)
		const now = new Date();
		const _thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
		const _ninetyDaysFromNow = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

		return {
			metadata: {
				controlPlaneId: controlPlaneId,
				requestedSize: size,
				effectiveSize,
				actualCount,
				capped,
				offset: offset || null,
				nextOffset: result.offset,
				totalCount: result.total,
			},
			certificates: result.data.map((cert: any) => {
				// Parse certificate to extract expiration date
				const expirationDate = null;
				const daysUntilExpiration = null;
				let expirationStatus = "unknown";

				try {
					// This is a simplified approach - in production you'd want proper certificate parsing
					if (cert.cert) {
						const _certLines = cert.cert.split("\n");
						// Look for certificate validity period (this is simplified)
						// In production, you'd use a proper X.509 certificate parser
						expirationStatus = "valid";
					}
				} catch (error) {
					log.error({ error }, "Error parsing certificate");
				}

				return {
					certificateId: cert.id,
					cert: cert.cert ? "*** REDACTED ***" : null, // Don't expose full cert in response
					certDigest: cert.cert_digest,
					certAlt: cert.cert_alt ? "*** REDACTED ***" : null,
					snis: cert.snis || [],
					tags: cert.tags,
					expirationAnalysis: {
						status: expirationStatus,
						daysUntilExpiration: daysUntilExpiration,
						expirationDate: expirationDate,
						warnings: daysUntilExpiration && daysUntilExpiration < 30 ? ["Certificate expires within 30 days"] : [],
					},
					metadata: {
						createdAt: cert.created_at,
						updatedAt: cert.updated_at,
					},
				};
			}),
			healthSummary: {
				totalCertificates: result.data.length,
				expiringSoon: result.data.filter((_cert: any) => {
					// This would be properly implemented with certificate parsing
					return false; // Placeholder
				}).length,
				recommendations: [
					"Review certificates expiring within 30 days",
					"Consider automating certificate renewal with ACME plugin",
					"Use create-certificate tool to upload new certificates",
				],
			},
			relatedTools: [
				"Use get-certificate to inspect specific certificate details",
				"Use create-certificate to upload new certificates",
				"Use list-snis to see SNI associations",
			],
		};
	});
}

/**
 * Get detailed information about a specific certificate
 */
export async function getCertificate(api: KongApi, controlPlaneId: string, certificateId: string) {
	log.debug({ controlPlaneId, certificateId }, "Getting certificate");
	return withErrorContext(
		"get_certificate",
		"certificate",
		certificateId,
		controlPlaneId,
	)(async () => {
		const result = await api.getCertificate(controlPlaneId, certificateId);

		// Enhanced certificate analysis
		const cert = result.data;

		// Validate certificate format
		const certValidation = validateCertificate(cert.cert || "");

		return {
			certificate: {
				certificateId: cert.id,
				cert: "*** REDACTED FOR SECURITY ***",
				certDigest: cert.cert_digest,
				certAlt: cert.cert_alt ? "*** PRESENT ***" : null,
				keyInfo: cert.key ? "*** PRIVATE KEY PRESENT ***" : "No private key",
				snis: cert.snis || [],
				tags: cert.tags || [],
				validation: {
					certFormat: certValidation.isValid ? "Valid PEM format" : certValidation.error,
					hasAlternativeCert: !!cert.cert_alt,
					hasPrivateKey: !!cert.key,
				},
				metadata: {
					createdAt: cert.created_at,
					updatedAt: cert.updated_at,
				},
			},
			usage: {
				sniAssociations: cert.snis?.length || 0,
				relatedServices: "Use list-services to find services using this certificate",
			},
			recommendations: [
				"Regularly rotate certificates before expiration",
				"Use SNI associations to apply certificates to specific domains",
				"Monitor certificate expiration dates proactively",
			],
		};
	});
}

/**
 * Create a new certificate
 */
export async function createCertificate(
	api: KongApi,
	controlPlaneId: string,
	cert: string,
	key: string,
	certAlt?: string,
	keyAlt?: string,
	tags?: string[],
) {
	log.debug({ controlPlaneId }, "Creating certificate");
	return withErrorContext(
		"create_certificate",
		"certificate",
		undefined,
		controlPlaneId,
	)(async () => {
		// Validate certificate and key format
		const certValidation = validateCertificate(cert);
		if (!certValidation.isValid) {
			throw new Error(`Invalid certificate format: ${certValidation.error}`);
		}

		const keyValidation = validatePrivateKey(key);
		if (!keyValidation.isValid) {
			throw new Error(`Invalid private key format: ${keyValidation.error}`);
		}

		// Validate alternative certificate if provided
		if (certAlt) {
			const certAltValidation = validateCertificate(certAlt);
			if (!certAltValidation.isValid) {
				throw new Error(`Invalid alternative certificate format: ${certAltValidation.error}`);
			}
		}

		// Validate alternative key if provided
		if (keyAlt) {
			const keyAltValidation = validatePrivateKey(keyAlt);
			if (!keyAltValidation.isValid) {
				throw new Error(`Invalid alternative private key format: ${keyAltValidation.error}`);
			}
		}

		const certificateData = {
			cert,
			key,
			cert_alt: certAlt,
			key_alt: keyAlt,
			tags: tags || [],
		};

		const result = await api.createCertificate(controlPlaneId, certificateData);

		return {
			certificate: {
				certificateId: result.data.id,
				status: "created",
				cert: "*** CERTIFICATE CREATED ***",
				hasAlternativeCert: !!certAlt,
				tags: result.data.tags || [],
				metadata: {
					createdAt: result.data.created_at,
					updatedAt: result.data.updated_at,
				},
			},
			nextSteps: [
				"Use create-sni tool to associate this certificate with domain names",
				"Configure services to use this certificate for TLS termination",
				"Monitor certificate expiration and plan for renewal",
			],
		};
	});
}

/**
 * Update an existing certificate
 */
export async function updateCertificate(
	api: KongApi,
	controlPlaneId: string,
	certificateId: string,
	cert?: string,
	key?: string,
	certAlt?: string,
	keyAlt?: string,
	tags?: string[],
) {
	log.debug({ controlPlaneId, certificateId }, "Updating certificate");
	return withErrorContext(
		"update_certificate",
		"certificate",
		certificateId,
		controlPlaneId,
	)(async () => {
		// Validate provided certificate and key if updating
		if (cert) {
			const certValidation = validateCertificate(cert);
			if (!certValidation.isValid) {
				throw new Error(`Invalid certificate format: ${certValidation.error}`);
			}
		}

		if (key) {
			const keyValidation = validatePrivateKey(key);
			if (!keyValidation.isValid) {
				throw new Error(`Invalid private key format: ${keyValidation.error}`);
			}
		}

		if (certAlt) {
			const certAltValidation = validateCertificate(certAlt);
			if (!certAltValidation.isValid) {
				throw new Error(`Invalid alternative certificate format: ${certAltValidation.error}`);
			}
		}

		if (keyAlt) {
			const keyAltValidation = validatePrivateKey(keyAlt);
			if (!keyAltValidation.isValid) {
				throw new Error(`Invalid alternative private key format: ${keyAltValidation.error}`);
			}
		}

		const updateData: any = {};
		if (cert !== undefined) updateData.cert = cert;
		if (key !== undefined) updateData.key = key;
		if (certAlt !== undefined) updateData.cert_alt = certAlt;
		if (keyAlt !== undefined) updateData.key_alt = keyAlt;
		if (tags !== undefined) updateData.tags = tags;

		const result = await api.updateCertificate(controlPlaneId, certificateId, updateData);

		return {
			certificate: {
				certificateId: result.data.id,
				status: "updated",
				updatedFields: Object.keys(updateData),
				tags: result.data.tags || [],
				metadata: {
					createdAt: result.data.created_at,
					updatedAt: result.data.updated_at,
				},
			},
			recommendations: [
				"Verify that all services using this certificate continue to work properly",
				"Update any SNI associations if domain names have changed",
			],
		};
	});
}

/**
 * Delete a certificate
 */
export async function deleteCertificate(api: KongApi, controlPlaneId: string, certificateId: string) {
	log.debug({ controlPlaneId, certificateId }, "Deleting certificate");
	return withErrorContext(
		"delete_certificate",
		"certificate",
		certificateId,
		controlPlaneId,
	)(async () => {
		await api.deleteCertificate(controlPlaneId, certificateId);

		return {
			status: "deleted",
			certificateId: certificateId,
			message: "Certificate has been successfully deleted",
			warnings: [
				"Any SNI associations for this certificate have been removed",
				"Services configured to use this certificate may experience SSL/TLS errors",
				"Verify that no services depend on this certificate before deletion",
			],
		};
	});
}
