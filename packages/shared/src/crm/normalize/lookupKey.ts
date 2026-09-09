/**
 * Shared lookup-key normalization: uppercases, trims, folds curly
 * apostrophes (’) to straight ('), and collapses runs of whitespace to a
 * single space. Used wherever a raw sheet value is matched against a
 * canonical map of spellings.
 */
export function buildLookupKey(rawValue: string): string {
  return rawValue.trim().toUpperCase().replace(/’/g, "'").replace(/\s+/g, " ");
}
