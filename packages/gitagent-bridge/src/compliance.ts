// gitagent-bridge/src/compliance.ts
import type { ComplianceConfig } from "./types.ts";

export function complianceToMetadata(compliance?: ComplianceConfig): Record<string, string> {
  if (!compliance) return {};

  const metadata: Record<string, string> = {
    compliance_risk_tier: compliance.risk_tier,
  };

  if (compliance.recordkeeping?.audit_logging) {
    metadata.compliance_audit_logging = "true";
  }
  if (compliance.recordkeeping?.retention_period) {
    metadata.compliance_retention_period = compliance.recordkeeping.retention_period;
  }
  if (compliance.recordkeeping?.immutable) {
    metadata.compliance_immutable_logs = "true";
  }
  if (compliance.supervision?.human_in_the_loop) {
    metadata.compliance_hitl = compliance.supervision.human_in_the_loop;
  }
  if (compliance.data_governance?.pii_handling) {
    metadata.compliance_pii_handling = compliance.data_governance.pii_handling;
  }
  if (compliance.data_governance?.data_classification) {
    metadata.compliance_data_classification = compliance.data_governance.data_classification;
  }

  return metadata;
}

export function requiresApproval(toolName: string, compliance?: ComplianceConfig): boolean {
  if (!compliance?.supervision) return false;
  if (compliance.supervision.human_in_the_loop === "always") return true;
  if (compliance.supervision.human_in_the_loop === "none") return false;

  const triggers = compliance.supervision.escalation_triggers ?? [];
  return triggers.some((t) => "action_type" in t && toolName.includes(String(t.action_type)));
}
