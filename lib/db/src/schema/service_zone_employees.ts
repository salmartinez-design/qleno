import { pgTable, serial, integer } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { serviceZonesTable } from "./service_zones";
import { usersTable } from "./users";

export const serviceZoneEmployeesTable = pgTable("service_zone_employees", {
  id: serial("id").primaryKey(),
  zone_id: integer("zone_id").references(() => serviceZonesTable.id).notNull(),
  user_id: integer("user_id").references(() => usersTable.id).notNull(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
});
