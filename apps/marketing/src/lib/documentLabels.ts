import { documentLabelsFromProduct, type CountryProduct } from "@rgs/shared";

/** Document list shown on the public country page: the product's checklist labels, in order. */
export function documentLabelsForMarketing(product: CountryProduct): string[] {
  return documentLabelsFromProduct(product);
}
