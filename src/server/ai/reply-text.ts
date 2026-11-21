/**
 * The text of a model's reply. Selected by block type, not by position: newer models can put
 * a thinking block first, which would otherwise read as an empty reply and silently lose a
 * call summary or a workflow's output.
 */
export function replyText(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}
