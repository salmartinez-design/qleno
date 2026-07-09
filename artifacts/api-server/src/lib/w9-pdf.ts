// [estimate-w9] Fills the official IRS Form W-9 (Rev. 3-2024) with the tenant's
// saved tax info and returns a Buffer. Field mapping was verified by rendering
// the filled form. pdf-lib (no Chromium needed).
import { PDFDocument } from "pdf-lib";
import { W9_TEMPLATE_B64 } from "./w9-template.js";

export type W9Classification = "individual" | "c_corp" | "s_corp" | "partnership" | "trust" | "llc" | "other";

export interface W9Data {
  legalName: string;            // line 1
  businessName?: string | null; // line 2
  classification: W9Classification;
  llcClass?: string | null;     // C / S / P, when classification = llc
  otherDesc?: string | null;    // when classification = other
  ein?: string | null;          // digits; business TIN
  ssn?: string | null;          // digits; individual TIN (fallback)
  address?: string | null;      // line 5
  cityStateZip?: string | null; // line 6
  exemptPayeeCode?: string | null;
  fatcaCode?: string | null;
}

const P = "topmostSubform[0].Page1[0].";
const B3 = `${P}Boxes3a-b_ReadOrder[0].`;
const ADDR = `${P}Address_ReadOrder[0].`;
// Verified field map for fw9.pdf (Rev. 3-2024).
const CLASS_BOX: Record<W9Classification, string> = {
  individual: `${B3}c1_1[0]`, c_corp: `${B3}c1_1[1]`, s_corp: `${B3}c1_1[2]`,
  partnership: `${B3}c1_1[3]`, trust: `${B3}c1_1[4]`, llc: `${B3}c1_1[5]`, other: `${B3}c1_1[6]`,
};
const onlyDigits = (s?: string | null) => String(s ?? "").replace(/\D/g, "");

export async function renderW9(data: W9Data): Promise<Buffer> {
  const doc = await PDFDocument.load(Buffer.from(W9_TEMPLATE_B64, "base64"));
  const form = doc.getForm();
  const setText = (name: string, v?: string | null) => { if (v) { try { form.getTextField(name).setText(v); } catch { /* tolerate */ } } };
  const check = (name: string) => { try { form.getCheckBox(name).check(); } catch { /* tolerate */ } };

  setText(`${P}f1_01[0]`, data.legalName);
  setText(`${P}f1_02[0]`, data.businessName);
  check(CLASS_BOX[data.classification] || CLASS_BOX.other);
  if (data.classification === "llc") setText(`${B3}f1_03[0]`, (data.llcClass || "").toUpperCase().slice(0, 1));
  if (data.classification === "other") setText(`${B3}f1_04[0]`, data.otherDesc);
  setText(`${P}f1_05[0]`, data.exemptPayeeCode);
  setText(`${P}f1_06[0]`, data.fatcaCode);
  setText(`${ADDR}f1_07[0]`, data.address);
  setText(`${ADDR}f1_08[0]`, data.cityStateZip);

  // TIN: business EIN (f1_14 prefix-2 + f1_15 suffix-7) takes priority; else SSN
  // (f1_11 area-3, f1_12 group-2, f1_13 serial-4).
  const ein = onlyDigits(data.ein);
  const ssn = onlyDigits(data.ssn);
  if (ein.length === 9) {
    setText(`${P}f1_14[0]`, ein.slice(0, 2));
    setText(`${P}f1_15[0]`, ein.slice(2));
  } else if (ssn.length === 9) {
    setText(`${P}f1_11[0]`, ssn.slice(0, 3));
    setText(`${P}f1_12[0]`, ssn.slice(3, 5));
    setText(`${P}f1_13[0]`, ssn.slice(5));
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
