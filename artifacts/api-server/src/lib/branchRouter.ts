import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export interface BranchConfig {
  branch: string;
  officeEmail: string;
  fromName: string;
  clientPhone: string;
  clientPhoneFormatted: string;
  twilioFrom: string;
}

const SCHAUMBURG_ZIPS = new Set([
  // Schaumburg / Palatine / Arlington Heights
  "60159","60168","60169","60173","60193","60194","60195","60196",
  "60004","60005","60006","60008","60038","60055","60056","60067",
  "60074","60078","60094","60095",
  // Elk Grove / Des Plaines / Buffalo Grove
  "60009","60017","60019","60089","60090","60007",
  // Barrington / Streamwood / Elgin
  "60010","60011","60107","60120","60172","60179","60192","60201",
]);

export function getBranchByZip(zip: string): BranchConfig {
  const isSchaumburg = SCHAUMBURG_ZIPS.has(zip?.toString().trim());
  if (isSchaumburg) {
    return {
      branch: "schaumburg",
      officeEmail: "schaumburg@phes.io",
      fromName: "Phes",
      clientPhone: "847-538-3729",
      clientPhoneFormatted: "(847) 538-3729",
      twilioFrom: "+16308844318",
    };
  }
  return {
    branch: "oak_lawn",
    officeEmail: "info@phes.io",
    fromName: "Phes",
    clientPhone: "773-706-6000",
    clientPhoneFormatted: "(773) 706-6000",
    twilioFrom: "+17737869902",
  };
}

export async function getCompanyIdByBranch(branch: string): Promise<number | null> {
  try {
    let rows: any;
    if (branch === "schaumburg") {
      rows = await db.execute(sql`SELECT id FROM companies WHERE name ILIKE '%schaumburg%' LIMIT 1`);
    } else {
      rows = await db.execute(sql`SELECT id FROM companies WHERE name ILIKE '%oak lawn%' OR name ILIKE '%phes%' ORDER BY id ASC LIMIT 1`);
    }
    const result = (rows as any).rows ?? rows;
    return result[0]?.id ?? null;
  } catch (err) {
    console.error("[branchRouter] getCompanyIdByBranch error:", err);
    return null;
  }
}
