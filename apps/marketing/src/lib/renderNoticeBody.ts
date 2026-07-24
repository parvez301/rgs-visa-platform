import { marked } from "marked";
import DOMPurify from "dompurify";

const ALLOWED_TAGS = ["p", "br", "strong", "em", "ul", "ol", "li", "a"];
const ALLOWED_ATTR = ["href", "target", "rel"];

/** Parse Markdown then sanitize to a tight HTML allowlist for notice bodies. */
export function renderNoticeBody(markdownBody: string): string {
  const rawHtml = marked.parse(markdownBody, { async: false }) as string;
  if (typeof window === "undefined") {
    // SSG/prerender path: strip tags aggressively until client hydrates.
    return rawHtml
      .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
      .replace(/on\w+="[^"]*"/gi, "");
  }
  const sanitizedHtml = DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
  });
  return sanitizedHtml.replace(
    /<a /g,
    '<a target="_blank" rel="noopener noreferrer" ',
  );
}
