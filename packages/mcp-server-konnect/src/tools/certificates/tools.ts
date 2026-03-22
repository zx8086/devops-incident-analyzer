import type { z } from "zod";
import * as parameters from "./parameters.js";
import * as prompts from "./prompts.js";

export type CertificatesTool = {
  method: string;
  name: string;
  description: string;
  parameters: z.ZodObject<any, any, any, any>;
  category: string;
};

export const certificatesTools = (): CertificatesTool[] => [
  {
    method: "list_certificates",
    name: "List Certificates",
    description: prompts.listCertificatesPrompt(),
    parameters: parameters.listCertificatesParameters(),
    category: "certificates",
  },
  {
    method: "get_certificate",
    name: "Get Certificate",
    description: prompts.getCertificatePrompt(),
    parameters: parameters.getCertificateParameters(),
    category: "certificates",
  },
  {
    method: "create_certificate",
    name: "Create Certificate",
    description: prompts.createCertificatePrompt(),
    parameters: parameters.createCertificateParameters(),
    category: "certificates",
  },
  {
    method: "update_certificate",
    name: "Update Certificate",
    description: prompts.updateCertificatePrompt(),
    parameters: parameters.updateCertificateParameters(),
    category: "certificates",
  },
  {
    method: "delete_certificate",
    name: "Delete Certificate",
    description: prompts.deleteCertificatePrompt(),
    parameters: parameters.deleteCertificateParameters(),
    category: "certificates",
  },
];
