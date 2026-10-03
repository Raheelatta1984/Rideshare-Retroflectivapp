import type { CommercialCampaignLegal } from "../types";

/** Minimal but complete legal block, mirroring blankCampaignLegal() in DriverConsole. */
function blankConsent() {
  return {
    confirmed: false,
    signerName: "",
    agreementReference: "",
    email: "",
    deliveryStatus: "not-issued" as const,
  };
}

export function blankLegalFixture(): CommercialCampaignLegal {
  return {
    appOwner: { ...blankConsent(), email: "raheel@retroflex.app" },
    driver: blankConsent(),
    vehicleOwner: blankConsent(),
    campaignOwner: blankConsent(),
    trademarkAuthorization: blankConsent(),
    safetyAssessment: blankConsent(),
    merchantName: "",
    offerExpiry: "",
    privacyPolicyUrl: "",
    qrTermsConfirmed: false,
    noRiderDataWithoutConsent: false,
    driverIsVehicleOwner: false,
  };
}
