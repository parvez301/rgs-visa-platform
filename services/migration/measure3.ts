import { readWorkbook } from "./src/readWorkbook";

const PATH = "/Users/parvez/Downloads/CRM - RAYS GLOBAL SERVICES.xlsx";
const extract = await readWorkbook(PATH);

const unusable = new Map<string, number>();
let blank = 0;
let usable = 0;
for (const row of extract.miniCrmRows) {
  const rawValue = row.applicantCount.trim();
  if (rawValue === "") {
    blank += 1;
    continue;
  }
  const parsedApplicantCount = Number(rawValue);
  if (Number.isFinite(parsedApplicantCount) && parsedApplicantCount >= 1) {
    usable += 1;
    continue;
  }
  unusable.set(rawValue, (unusable.get(rawValue) ?? 0) + 1);
}
console.log("rows", extract.miniCrmRows.length, "blank", blank, "usable", usable);
console.log("unusable values", [...unusable.entries()].sort((a, b) => b[1] - a[1]));
console.log(
  "no-digit unusable",
  [...unusable.entries()].filter(([value]) => !/\d/.test(value)),
);
