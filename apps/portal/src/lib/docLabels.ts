/**
 * Re-exported, not redeclared: one map in `@rgs/shared` names every portal
 * DocType, so the wizard's upload slots, its guidance copy and the review
 * screens agree on what each slot is called.
 *
 * Not the same thing as the client-visible checklist copy: marketing and the
 * CRM case stamp render `CountryProduct.requiredDocuments[].label`, which an
 * admin can rename per country. Rename a portal-backed row and the wizard
 * slot keeps this generic name.
 */
export { DOC_TYPE_LABELS } from "@rgs/shared";
