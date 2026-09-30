import type { CountryProduct } from "@rgs/shared";
import { DOC_TYPE_LABELS } from "./countryContent";

/**
 * Document list shown on the public country page. CRM checklist labels (merged
 * into the catalog by the API) win; otherwise map the product's DocTypes.
 */
export function documentLabelsForMarketing(product: CountryProduct): string[] {
  if (product.requiredDocumentLabels && product.requiredDocumentLabels.length > 0) {
    return [...product.requiredDocumentLabels];
  }
  return product.docsRequired.map((docType) => DOC_TYPE_LABELS[docType]);
}
