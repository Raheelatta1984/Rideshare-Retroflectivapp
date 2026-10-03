import type { CommercialCampaignLegal, ConsentRole, DeliveryStatus, LegalConsent } from "../types";

/** Consent slots plus the non-campaign agreement roles the vault issues. */
export type AgreementRole = ConsentRole | "vendor" | "fleet" | "admin";

export interface AgreementDraft {
  role: AgreementRole;
  signerName: string;
  agreementReference: string;
  date: string;
  company?: string;
  /** Commercial campaign this consent belongs to, when applicable. */
  campaignTitle?: string;
  email?: string;
}

/**
 * Wider input accepted by createConsentPdf — the driver console passes the
 * campaign title, the signed consent record and the whole legal block so the
 * generated document can carry the full authorization context.
 */
export interface ConsentDocumentInput {
  campaignTitle?: string;
  role: AgreementRole;
  consent?: LegalConsent;
  legal?: CommercialCampaignLegal;
  nswSafetyMode?: boolean;
  date?: string;
}

function isDocumentInput(input: ConsentDocumentInput | AgreementDraft): input is ConsentDocumentInput {
  return "consent" in input || "legal" in input || "nswSafetyMode" in input;
}

function resolveDraft(input: ConsentDocumentInput | AgreementDraft): AgreementDraft {
  if (isDocumentInput(input)) {
    const consent = input.consent;
    return {
      role: input.role,
      signerName: consent?.signerName ?? "",
      agreementReference: consent?.agreementReference ?? "",
      date: input.date ?? new Date(consent?.signedDocumentAt ?? Date.now()).toISOString(),
      campaignTitle: input.campaignTitle,
      email: consent?.email,
    };
  }

  return input;
}

export function createConsentPdf(input: ConsentDocumentInput | AgreementDraft): Blob {
  const draft = resolveDraft(input);
  const text = [
    "Retroflex Agreement",
    `Role: ${draft.role}`,
    draft.campaignTitle ? `Campaign: ${draft.campaignTitle}` : "",
    `Signer: ${draft.signerName}`,
    draft.email ? `Email: ${draft.email}` : "",
    `Reference: ${draft.agreementReference}`,
    `Date: ${draft.date}`,
    draft.company ? `Company: ${draft.company}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return new Blob([text], { type: "application/pdf" });
}

/**
 * Placeholder delivery. Returns a *status string* (not an object) because the
 * caller stores the result straight into `deliveryStatus` / and that value is
 * rendered directly in the campaign legal panel — returning an object here
 * crashes React with "Objects are not valid as a React child".
 */
export async function deliverAgreementPdf(
  blob: Blob,
  recipients: Array<string | undefined>,
  title: string,
): Promise<DeliveryStatus> {
  const to = recipients.filter((value): value is string => Boolean(value));
  void blob;
  void title;
  // In a real app: upload the PDF and email `to`.
  return to.length > 0 ? "prepared" : "not-issued";
}
