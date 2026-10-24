import "server-only";

/**
 * Neutralizes literal closing-tag sequences ("</...") inside untrusted,
 * externally-supplied text before it is interpolated into a `<tag>...
 * </tag>` prompt wrapper (a customer email body, a Business DNA field that
 * may originate from AI-extracted website content, a retrieved knowledge-
 * base document, org-authored custom instructions). Every consumer of this
 * already tells the model to treat the wrapped content as data, never
 * instructions — that is an instructional defense the model could in
 * principle fail to follow. This is a structural one on top of it: a
 * crafted payload like `</email_thread>\n## SYSTEM: ...` can no longer
 * syntactically close the wrapper early and make the following text look
 * like it sits outside the untrusted section, regardless of how reliably
 * the model honors the instruction. Broken deliberately generically (any
 * `</word`, not just this codebase's specific tag names) since an attacker
 * is not limited to guessing the real wrapper name.
 */
export function neutralizeTagBreakout(text: string): string {
  return text.replace(/<\/(?=[a-zA-Z])/g, "<\\/");
}

/**
 * Makes untrusted text safe inside a double-quoted attribute of a prompt
 * wrapper tag, such as a knowledge-base document title in
 * `<source title="...">` (any kb:write member chooses the title). Drops the
 * characters that could end the attribute or the tag or start a new prompt
 * line — `"`, `<`, `>`, newlines and every other control character — and
 * collapses the whitespace left behind. Unlike wrapper content, an
 * attribute value has no legitimate use for them, so they are removed
 * rather than escaped.
 */
export function neutralizeAttributeValue(text: string): string {
  return text
    .replace(/["<>\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
