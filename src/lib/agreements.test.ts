import { describe, expect, it } from "vitest";
import { createConsentPdf, deliverAgreementPdf } from "./agreements";
import { getPlatform } from "./platforms";
import { blankLegalFixture } from "../test/fixtures";

describe("createConsentPdf", () => {
  it("accepts a plain agreement draft", async () => {
    const blob = createConsentPdf({
      role: "vendor",
      signerName: "Ada Lovelace",
      agreementReference: "AGR-001",
      date: "2026-10-04",
    });
    expect(blob.type).toBe("application/pdf");
    const text = await blob.text();
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("AGR-001");
  });

  // Regression: the console calls createConsentPdf with the campaign title,
  // the signed consent and the whole legal block.
  it("accepts the driver-console document input", async () => {
    const legal = blankLegalFixture();
    const blob = createConsentPdf({
      campaignTitle: "Bondi Coffee",
      role: "appOwner",
      consent: { ...legal.appOwner, signerName: "Raheel Atta", agreementReference: "REF-9" },
      legal,
      nswSafetyMode: true,
    });
    const text = await blob.text();
    expect(text).toContain("Bondi Coffee");
    expect(text).toContain("Raheel Atta");
    expect(text).toContain("REF-9");
  });
});

describe("deliverAgreementPdf", () => {
  // Regression: this used to resolve to an object which callers stored in
  // deliveryStatus and rendered directly — React throws "Objects are not valid
  // as a React child", blanking the campaign legal panel.
  it("resolves to a renderable status string, never an object", async () => {
    const result = await deliverAgreementPdf(new Blob(["x"]), ["driver@retroflex.app"], "Consent");
    expect(typeof result).toBe("string");
    expect(result).toBe("prepared");
  });

  it("reports not-issued when there is nobody to deliver to", async () => {
    const result = await deliverAgreementPdf(new Blob(["x"]), [undefined, ""], "Consent");
    expect(result).toBe("not-issued");
  });
});

describe("getPlatform", () => {
  it("resolves known platforms", () => {
    expect(getPlatform("uber").name).toBe("Uber");
    expect(getPlatform("didi").short).toBe("DD");
  });

  // Regression: getPlatform returned undefined for unknown ids and callers
  // rendered .name/.accent straight away, crashing the history list.
  it("falls back instead of returning undefined", () => {
    const unknown = getPlatform("some-new-app");
    expect(unknown).toBeDefined();
    expect(unknown.name).toBe("Some-new-app");
    expect(unknown.short).toHaveLength(2);
    expect(getPlatform("").name).toBe("Rideshare");
  });
});
