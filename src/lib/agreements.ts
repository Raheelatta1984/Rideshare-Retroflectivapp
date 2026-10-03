export type AgreementRole = "driver" | "vendor" | "fleet" | "admin";

export interface AgreementDraft {
  role: AgreementRole;
  signerName: string;
  agreementReference: string;
  date: string;
  company?: string;
}

export function createConsentPdf(_draft: AgreementDraft): Blob {
  const text = [
    "Retroflex Agreement",
    `Role: ${_draft.role}`,
    `Signer: ${_draft.signerName}`,
    `Reference: ${_draft.agreementReference}`,
    `Date: ${_draft.date}`,
    _draft.company ? `Company: ${_draft.company}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return new Blob([text], { type: "application/pdf" });
}

export async function deliverAgreementPdf(
  _blob: Blob,
  _filename: string,
): Promise<{ ok: boolean; filename: string; size: number }> {
  // Placeholder – in a real app this would upload the PDF
  // or trigger a download / email delivery.
  return {
    ok: true,
    filename: _filename,
    size: _blob.size,
  };
}