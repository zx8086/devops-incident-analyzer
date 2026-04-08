import { z } from "zod";
import { CommonSchemas } from "../../utils/validation.js";

export const listCertificatesParameters = () =>
	z.object({
		controlPlaneId: CommonSchemas.uuid.describe("Control Plane ID (obtainable from list-control-planes tool)"),
		size: CommonSchemas.pageSize,
		offset: CommonSchemas.offset,
	});

export const getCertificateParameters = () =>
	z.object({
		controlPlaneId: CommonSchemas.uuid.describe("Control Plane ID (obtainable from list-control-planes tool)"),
		certificateId: CommonSchemas.uuid.describe("Certificate ID (obtainable from list-certificates tool)"),
	});

export const createCertificateParameters = () =>
	z.object({
		controlPlaneId: CommonSchemas.uuid.describe("Control Plane ID (obtainable from list-control-planes tool)"),
		cert: z.string().min(1).describe("Certificate in PEM format (-----BEGIN CERTIFICATE-----...)"),
		key: z.string().min(1).describe("Private key in PEM format (-----BEGIN PRIVATE KEY-----...)"),
		certAlt: z.string().optional().describe("Alternative certificate in PEM format (for dual cert setups)"),
		keyAlt: z.string().optional().describe("Alternative private key in PEM format"),
		tags: CommonSchemas.tags,
	});

export const updateCertificateParameters = () =>
	z.object({
		controlPlaneId: CommonSchemas.uuid.describe("Control Plane ID (obtainable from list-control-planes tool)"),
		certificateId: CommonSchemas.uuid.describe("Certificate ID (obtainable from list-certificates tool)"),
		cert: z.string().optional().describe("Updated certificate in PEM format"),
		key: z.string().optional().describe("Updated private key in PEM format"),
		certAlt: z.string().optional().describe("Updated alternative certificate in PEM format"),
		keyAlt: z.string().optional().describe("Updated alternative private key in PEM format"),
		tags: CommonSchemas.tags,
	});

export const deleteCertificateParameters = () =>
	z.object({
		controlPlaneId: CommonSchemas.uuid.describe("Control Plane ID (obtainable from list-control-planes tool)"),
		certificateId: CommonSchemas.uuid.describe("Certificate ID (obtainable from list-certificates tool)"),
	});
