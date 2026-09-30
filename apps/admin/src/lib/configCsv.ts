import {
  CountryProductSchema,
  DOC_TYPES,
  requiredDocumentsFromLegacyDocTypes,
  type CountryProduct,
  type DocType,
  type RequiredDocument,
} from "@rgs/shared";

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
  "requiredDocuments",
  "active",
  "officialUrl",
] as const;

/** Older exports used this column name; still accepted on import. */
const LEGACY_DOCS_HEADER = "docsRequired";

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

function escapeDocumentText(text: string): string {
  return text.replace(/[\\;|]/g, (character) => `\\${character}`);
}

/** `Label|DOC_TYPE;Label2` — DocType optional; backslash, `;` and `|` inside a label are backslash-escaped. */
export function serializeRequiredDocuments(
  requiredDocuments: readonly RequiredDocument[],
): string {
  return requiredDocuments
    .map((requiredDocument) =>
      requiredDocument.portalDocType === undefined
        ? escapeDocumentText(requiredDocument.label)
        : `${escapeDocumentText(requiredDocument.label)}|${requiredDocument.portalDocType}`,
    )
    .join(";");
}

function isDocType(value: string): value is DocType {
  return (DOC_TYPES as readonly string[]).includes(value);
}

/** Split on an unescaped separator, keeping escape sequences intact for later unescaping. */
function splitUnescaped(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "\\" && index + 1 < text.length) {
      current += character + text[index + 1]!;
      index += 1;
      continue;
    }
    if (character === separator) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

function unescapeDocumentText(text: string): string {
  return text.replace(/\\([\\;|])/g, "$1");
}

/**
 * Legacy cells were `PASSPORT_BIO|PHOTO` (DocType enums only). When every
 * `|` segment is a DocType, coerce via the shared legacy bridge.
 */
function looksLikeLegacyDocTypeCell(cell: string): boolean {
  if (cell.includes(";") || cell.includes("\\")) return false;
  const segments = cell.split("|").map((segment) => segment.trim());
  return segments.length > 0 && segments.every((segment) => isDocType(segment));
}

export function parseRequiredDocuments(
  cell: string,
): { requiredDocuments: RequiredDocument[]; error: string | null } {
  const trimmed = cell.trim();
  if (trimmed.length === 0) return { requiredDocuments: [], error: null };
  if (looksLikeLegacyDocTypeCell(trimmed)) {
    const docTypes = trimmed.split("|").map((segment) => segment.trim()) as DocType[];
    return { requiredDocuments: requiredDocumentsFromLegacyDocTypes(docTypes), error: null };
  }
  const requiredDocuments: RequiredDocument[] = [];
  for (const entry of splitUnescaped(trimmed, ";")) {
    if (entry.trim().length === 0) continue;
    const segments = splitUnescaped(entry, "|");
    if (segments.length > 2) {
      return {
        requiredDocuments: [],
        error: `requiredDocuments: "${entry.trim()}" has more than one "|" (escape a literal pipe with a backslash)`,
      };
    }
    const label = unescapeDocumentText(segments[0]!).trim();
    if (label.length === 0) {
      return { requiredDocuments: [], error: "requiredDocuments: document label is empty" };
    }
    const docTypeText = segments[1]?.trim() ?? "";
    if (docTypeText.length === 0) {
      requiredDocuments.push({ label });
      continue;
    }
    if (!isDocType(docTypeText)) {
      return {
        requiredDocuments: [],
        error: `requiredDocuments: unknown portal DocType "${docTypeText}"`,
      };
    }
    requiredDocuments.push({ label, portalDocType: docTypeText });
  }
  return { requiredDocuments, error: null };
}

function productToCsvRow(countryProduct: CountryProduct): string {
  const cells: string[] = CONFIG_CSV_HEADERS.map((header) => {
    if (header === "requiredDocuments") {
      return escapeCsvCell(serializeRequiredDocuments(countryProduct.requiredDocuments));
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

  if (!("requiredDocuments" in raw) && LEGACY_DOCS_HEADER in raw) {
    raw.requiredDocuments = raw[LEGACY_DOCS_HEADER]!;
  }

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

  const { requiredDocuments, error: requiredDocumentsError } = parseRequiredDocuments(
    raw.requiredDocuments ?? "",
  );
  if (requiredDocumentsError !== null) {
    return { product: null, error: requiredDocumentsError };
  }

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
    requiredDocuments,
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
    (header) =>
      header !== "officialUrl" &&
      !headerCells.includes(header) &&
      !(header === "requiredDocuments" && headerCells.includes(LEGACY_DOCS_HEADER)),
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
    leftProduct.requiredDocuments.length === rightProduct.requiredDocuments.length &&
    leftProduct.requiredDocuments.every(
      (requiredDocument, index) =>
        requiredDocument.label === rightProduct.requiredDocuments[index]?.label &&
        requiredDocument.portalDocType === rightProduct.requiredDocuments[index]?.portalDocType,
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
