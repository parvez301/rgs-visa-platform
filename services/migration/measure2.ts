import { crm } from "@rgs/shared";
import { readWorkbook } from "./src/readWorkbook";

const PATH = "/Users/parvez/Downloads/CRM - RAYS GLOBAL SERVICES.xlsx";
const extract = await readWorkbook(PATH);

const failures = new Map<string, number>();
let parsed = 0;
let present = 0;
for (const row of extract.miniCrmRows) {
  if (row.courierDateRaw.trim() === "") continue;
  present += 1;
  if (crm.normalizeExcelDate(row.courierDateRaw).isoDate === null) {
    failures.set(row.courierDateRaw, (failures.get(row.courierDateRaw) ?? 0) + 1);
  } else {
    parsed += 1;
  }
}
console.log("COURIER DATE present", present, "parsed", parsed, "failed", present - parsed);
console.log(
  "distinct failing values",
  [...failures.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40),
);
console.log("distinct failing count", failures.size);
