import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Tailwind 4 generates a utility such as `bg-crm-canvas` only when the
 * `--color-crm-canvas` variable is declared in the stylesheet Tailwind itself
 * compiles. `crm/theme.css` was once imported from `CrmLayout.tsx` instead,
 * so the built CSS contained none of the CRM colours and every CRM screen
 * shipped monochrome with see-through popovers (staging, 2026-09-16). jsdom
 * renders no CSS, so no rendering test can see this; the import chain is the
 * thing to assert.
 */
describe("CRM theme import chain", () => {
  it("styles.css imports crm/theme.css so Tailwind compiles its @theme block", () => {
    const stylesSource = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    expect(stylesSource).toMatch(/@import\s+"\.\/crm\/theme\.css";/);
  });

  it("no component imports theme.css on its own, which Tailwind would ignore", () => {
    const layoutSource = readFileSync(resolve(process.cwd(), "src/crm/CrmLayout.tsx"), "utf8");
    expect(layoutSource).not.toMatch(/theme\.css/);
  });
});
