import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * R79: the global constraint's `--crm-primary` rule, enforced instead of
 * reviewed.
 *
 * "#5645d4 marks exactly one control in the whole product" is a claim about the
 * PRODUCT, and every test that tried to hold it was scoped to one container:
 * `ProposalCard.test.tsx` queries `[class*='crm-primary']` inside the card's
 * own DOM, and `ViewChips.test.tsx` checks the Save button while the pressed
 * chip beside it carried the colour. Three separate task reviews each checked
 * the constraint within their own file and each passed, and all three of
 * finding #8's usages were written anyway. A container-scoped query cannot
 * enforce a product-wide reservation; reading every file can.
 *
 * This is the structural half -- WHERE the colour may appear. The rendered
 * half, that the one place it appears really is the Approve button a human
 * clicks, stays in `ProposalCard.test.tsx`'s "puts the one purple control in
 * the product on Approve, and nowhere else".
 */
const CRM_SOURCE_DIRECTORY = resolve(process.cwd(), "src/crm");

/** The token's own definition. It has to live somewhere, and this is where. */
const TOKEN_DEFINITION_FILE = "theme.css";
/** The one control in the product entitled to the colour. */
const APPROVE_BUTTON_FILE = join("agent", "ProposalCard.tsx");

function everySourceFileUnder(directoryPath: string): string[] {
  return readdirSync(directoryPath, { withFileTypes: true }).flatMap((directoryEntry) => {
    const entryPath = join(directoryPath, directoryEntry.name);
    return directoryEntry.isDirectory() ? everySourceFileUnder(entryPath) : [entryPath];
  });
}

/**
 * Blanks out `/* ... *\/` (JSX `{/* ... *\/}` included) and `// ...` while
 * keeping every newline, so a surviving match still reports its real line
 * number. The constraint is about what SHIPS: a file may explain at length why
 * it does not use the colour -- four of them do -- and those sentences must not
 * read as usages.
 */
function blankOutComments(fileContents: string): string {
  return fileContents
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (comment) => " ".repeat(comment.length));
}

interface PrimaryColourUse {
  relativePath: string;
  lineNumber: number;
  lineText: string;
}

function findEveryPrimaryColourUse(): { fileCount: number; uses: PrimaryColourUse[] } {
  const sourceFilePaths = everySourceFileUnder(CRM_SOURCE_DIRECTORY);
  const uses: PrimaryColourUse[] = [];
  for (const sourceFilePath of sourceFilePaths) {
    const shippedLines = blankOutComments(readFileSync(sourceFilePath, "utf8")).split("\n");
    shippedLines.forEach((lineText, lineIndex) => {
      if (!lineText.includes("crm-primary")) return;
      uses.push({
        relativePath: relative(CRM_SOURCE_DIRECTORY, sourceFilePath),
        lineNumber: lineIndex + 1,
        lineText: lineText.trim(),
      });
    });
  }
  return { fileCount: sourceFilePaths.length, uses };
}

describe("the product's one accent colour (R79, global constraint)", () => {
  it("appears in exactly two places under src/crm: its own definition, and the Approve button", () => {
    const { fileCount, uses } = findEveryPrimaryColourUse();

    // Guard first. A walk that found nothing -- a wrong working directory, a
    // moved directory -- or a comment-blanker that ate the whole file would
    // make every assertion below trivially true, which is the exact failure
    // mode this test exists to replace.
    expect(existsSync(join(CRM_SOURCE_DIRECTORY, TOKEN_DEFINITION_FILE))).toBe(true);
    expect(fileCount).toBeGreaterThan(15);
    expect(uses.length).toBeGreaterThan(0);

    expect(uses.map((use) => use.relativePath).sort()).toEqual([
      APPROVE_BUTTON_FILE,
      TOKEN_DEFINITION_FILE,
    ]);

    const tokenDefinition = uses.find((use) => use.relativePath === TOKEN_DEFINITION_FILE)!;
    expect(tokenDefinition.lineText).toBe("--color-crm-primary: #5645d4;");

    const approveButtonUse = uses.find((use) => use.relativePath === APPROVE_BUTTON_FILE)!;
    expect(approveButtonUse.lineText).toContain("bg-crm-primary");
  });

  it("is on the Approve button itself, not merely somewhere in that file", () => {
    // A proximity check, deliberately: this file reads text, so the strongest
    // thing it can say about WHICH control carries the colour is that the
    // button's own label is two lines below its className. The rendered proof
    // is `ProposalCard.test.tsx`'s own scoped assertion, which is exactly right
    // once "nowhere else in the product" is established above.
    const { uses } = findEveryPrimaryColourUse();
    const approveButtonUse = uses.find((use) => use.relativePath === APPROVE_BUTTON_FILE)!;

    const proposalCardLines = readFileSync(join(CRM_SOURCE_DIRECTORY, APPROVE_BUTTON_FILE), "utf8").split("\n");
    const linesJustBelow = proposalCardLines
      .slice(approveButtonUse.lineNumber, approveButtonUse.lineNumber + 3)
      .join("\n");

    expect(linesJustBelow).toContain("Approve");
  });
});
