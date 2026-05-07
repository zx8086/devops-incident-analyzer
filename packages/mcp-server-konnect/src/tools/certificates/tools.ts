import type { MCPTool } from "../registry.js";
import * as certificatesOps from "./operations.js";
import type {
	CreateCertificateArgs,
	DeleteCertificateArgs,
	GetCertificateArgs,
	ListCertificatesArgs,
	UpdateCertificateArgs,
} from "./parameters.js";
import * as parameters from "./parameters.js";
import * as prompts from "./prompts.js";

export const certificatesTools = (): MCPTool[] => [
	{
		method: "list_certificates",
		name: "List Certificates",
		description: prompts.listCertificatesPrompt(),
		parameters: parameters.listCertificatesParameters,
		category: "certificates",
		handler: async (args: ListCertificatesArgs, { api }) =>
			certificatesOps.listCertificates(api, args.controlPlaneId, args.size, args.offset),
	},
	{
		method: "get_certificate",
		name: "Get Certificate",
		description: prompts.getCertificatePrompt(),
		parameters: parameters.getCertificateParameters,
		category: "certificates",
		handler: async (args: GetCertificateArgs, { api }) =>
			certificatesOps.getCertificate(api, args.controlPlaneId, args.certificateId),
	},
	{
		method: "create_certificate",
		name: "Create Certificate",
		description: prompts.createCertificatePrompt(),
		parameters: parameters.createCertificateParameters,
		category: "certificates",
		handler: async (args: CreateCertificateArgs, { api }) =>
			certificatesOps.createCertificate(
				api,
				args.controlPlaneId,
				args.cert,
				args.key,
				args.certAlt,
				args.keyAlt,
				args.tags,
			),
	},
	{
		method: "update_certificate",
		name: "Update Certificate",
		description: prompts.updateCertificatePrompt(),
		parameters: parameters.updateCertificateParameters,
		category: "certificates",
		handler: async (args: UpdateCertificateArgs, { api }) =>
			certificatesOps.updateCertificate(
				api,
				args.controlPlaneId,
				args.certificateId,
				args.cert,
				args.key,
				args.certAlt,
				args.keyAlt,
				args.tags,
			),
	},
	{
		method: "delete_certificate",
		name: "Delete Certificate",
		description: prompts.deleteCertificatePrompt(),
		parameters: parameters.deleteCertificateParameters,
		category: "certificates",
		handler: async (args: DeleteCertificateArgs, { api }) =>
			certificatesOps.deleteCertificate(api, args.controlPlaneId, args.certificateId),
	},
];
