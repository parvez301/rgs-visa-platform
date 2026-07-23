import { CountryProductSchema, type CountryProduct, type DocType } from "@rgs/shared";

export const CONFIG_CSV_HEADERS = [
  "countryCode",
  "productCode",
  "countryName",
  "visaType",
  "region",
  "tier",
  "validityDays",
  "stayDays",
  "entry",
  "governmentFeeInr",
  "serviceFeeInr",
  "processingDays",
  "docsRequired",
  "active",
  "officialUrl",
] as const;

export type ConfigCsvHeader = (typeof CONFIG_CSV_HEADERS)[number];

export interface ParsedConfigCsvRow {
  rowNumber: number;
  raw: Record<string, string>;
  product: CountryProduct | null;
  validationError: string | null;
}

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function productToCsvRow(countryProduct: CountryProduct): string {
  const cells: string[] = CONFIG_CSV_HEADERS.map((header) => {
    if (header === "docsRequired") {
      return escapeCsvCell(countryProduct.docsRequired.join("|"));
    }
    if (header === "active") {
      return countryProduct.active ? "true" : "false";
    }
    if (header === "officialUrl") {
      return escapeCsvCell(countryProduct.officialUrl ?? "");
    }
    const fieldValue = countryProduct[header];
    return escapeCsvCell(String(fieldValue));
  });
  return cells.join(",");
}

export function serializeConfigCsv(products: CountryProduct[]): string {
  const headerLine = CONFIG_CSV_HEADERS.join(",");
  const bodyLines = products.map(productToCsvRow);
  return [headerLine, ...bodyLines].join("\n") + "\n";
}

export function configCsvFilename(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `rgs-country-config-${year}-${month}-${day}.csv`;
}

/** Split a CSV line into cells, respecting double-quoted fields. */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (inQuotes) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"') {
      inQuotes = true;
      continue;
    }
    if (character === ",") {
      cells.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  cells.push(current);
  return cells;
}

function parseBooleanCell(rawValue: string): boolean | null {
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return null;
}

function parseIntegerCell(rawValue: string): number | null {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0 || !/^-?\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return null;
  return parsed;
}

function buildProductFromCells(
  headerByIndex: string[],
  cells: string[],
): { product: CountryProduct | null; error: string | null } {
  const raw: Record<string, string> = {};
  headerByIndex.forEach((header, index) => {
    raw[header] = (cells[index] ?? "").trim();
  });

  for (const requiredHeader of CONFIG_CSV_HEADERS) {
    if (!(requiredHeader in raw) && requiredHeader !== "officialUrl") {
      return { product: null, error: `Missing column: ${requiredHeader}` };
    }
  }

  const activeParsed = parseBooleanCell(raw.active ?? "");
  if (activeParsed === null) {
    return { product: null, error: "active must be true or false" };
  }

  const numericFields = [
    "validityDays",
    "stayDays",
    "governmentFeeInr",
    "serviceFeeInr",
    "processingDays",
  ] as const;
  const numbers: Record<(typeof numericFields)[number], number> = {
    validityDays: 0,
    stayDays: 0,
    governmentFeeInr: 0,
    serviceFeeInr: 0,
    processingDays: 0,
  };
  for (const fieldName of numericFields) {
    const parsed = parseIntegerCell(raw[fieldName] ?? "");
    if (parsed === null) {
      return { product: null, error: `${fieldName} must be an integer` };
    }
    numbers[fieldName] = parsed;
  }

  const docsRaw = raw.docsRequired ?? "";
  const docsRequired = (
    docsRaw.length === 0 ? [] : docsRaw.split("|").map((docType) => docType.trim())
  ).filter((docType) => docType.length > 0) as DocType[];

  const officialUrlRaw = (raw.officialUrl ?? "").trim();
  const candidate = {
    countryCode: raw.countryCode ?? "",
    productCode: raw.productCode ?? "",
    countryName: raw.countryName ?? "",
    visaType: raw.visaType ?? "",
    region: raw.region ?? "",
    tier: raw.tier ?? "",
    validityDays: numbers.validityDays,
    stayDays: numbers.stayDays,
    entry: raw.entry ?? "",
    governmentFeeInr: numbers.governmentFeeInr,
    serviceFeeInr: numbers.serviceFeeInr,
    processingDays: numbers.processingDays,
    docsRequired,
    active: activeParsed,
    ...(officialUrlRaw.length > 0 ? { officialUrl: officialUrlRaw } : {}),
  };

  const parseResult = CountryProductSchema.safeParse(candidate);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    const pathLabel = firstIssue?.path.join(".") || "row";
    return {
      product: null,
      error: `${pathLabel}: ${firstIssue?.message ?? "invalid row"}`,
    };
  }
  return { product: parseResult.data, error: null };
}

export function parseConfigCsv(csvText: string): ParsedConfigCsvRow[] {
  const normalized = csvText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];

  const headerCells = splitCsvLine(lines[0]!).map((cell) => cell.trim());
  const missingHeaders = CONFIG_CSV_HEADERS.filter(
    (header) => header !== "officialUrl" && !headerCells.includes(header),
  );
  if (missingHeaders.length > 0) {
    return [
      {
        rowNumber: 1,
        raw: {},
        product: null,
        validationError: `Missing required columns: ${missingHeaders.join(", ")}`,
      },
    ];
  }

  const rows: ParsedConfigCsvRow[] = [];
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const cells = splitCsvLine(lines[lineIndex]!);
    const raw: Record<string, string> = {};
    headerCells.forEach((header, index) => {
      raw[header] = (cells[index] ?? "").trim();
    });
    const { product, error } = buildProductFromCells(headerCells, cells);
    rows.push({
      rowNumber: lineIndex + 1,
      raw,
      product,
      validationError: error,
    });
  }
  return rows;
}

export function productsEqual(
  leftProduct: CountryProduct,
  rightProduct: CountryProduct,
): boolean {
  return (
    leftProduct.countryCode === rightProduct.countryCode &&
    leftProduct.productCode === rightProduct.productCode &&
    leftProduct.countryName === rightProduct.countryName &&
    leftProduct.visaType === rightProduct.visaType &&
    leftProduct.region === rightProduct.region &&
    leftProduct.tier === rightProduct.tier &&
    leftProduct.validityDays === rightProduct.validityDays &&
    leftProduct.stayDays === rightProduct.stayDays &&
    leftProduct.entry === rightProduct.entry &&
    leftProduct.governmentFeeInr === rightProduct.governmentFeeInr &&
    leftProduct.serviceFeeInr === rightProduct.serviceFeeInr &&
    leftProduct.processingDays === rightProduct.processingDays &&
    leftProduct.active === rightProduct.active &&
    (leftProduct.officialUrl ?? "") === (rightProduct.officialUrl ?? "") &&
    leftProduct.docsRequired.length === rightProduct.docsRequired.length &&
    leftProduct.docsRequired.every(
      (docType, index) => docType === rightProduct.docsRequired[index],
    )
  );
}

export type ImportDiffKind = "unchanged" | "changed" | "new" | "invalid";

export interface ImportPreviewRow {
  rowNumber: number;
  kind: ImportDiffKind;
  product: CountryProduct | null;
  validationError: string | null;
  existingProduct: CountryProduct | null;
}

export function buildImportPreview(
  parsedRows: ParsedConfigCsvRow[],
  existingProducts: CountryProduct[],
): ImportPreviewRow[] {
  const byProductCode = new Map(
    existingProducts.map((countryProduct) => [
      countryProduct.productCode,
      countryProduct,
    ]),
  );

  return parsedRows.map((parsedRow) => {
    if (!parsedRow.product) {
      return {
        rowNumber: parsedRow.rowNumber,
        kind: "invalid" as const,
        product: null,
        validationError: parsedRow.validationError,
        existingProduct: null,
      };
    }
    const existingProduct = byProductCode.get(parsedRow.product.productCode) ?? null;
    if (!existingProduct) {
      return {
        rowNumber: parsedRow.rowNumber,
        kind: "new" as const,
        product: parsedRow.product,
        validationError: null,
        existingProduct: null,
      };
    }
    if (productsEqual(existingProduct, parsedRow.product)) {
      return {
        rowNumber: parsedRow.rowNumber,
        kind: "unchanged" as const,
        product: parsedRow.product,
        validationError: null,
        existingProduct,
      };
    }
    return {
      rowNumber: parsedRow.rowNumber,
      kind: "changed" as const,
      product: parsedRow.product,
      validationError: null,
      existingProduct,
    };
  });
}
