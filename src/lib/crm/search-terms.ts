/**
 * Splits a CRM list search into terms. Every term must match some field of a
 * record, so "Pilot Guest" finds a contact whose first name is "Pilot" and
 * last name "Guest", and no longer matches "Pilot Test Contact". A query of
 * only whitespace yields no terms (no filter), never an empty `contains`
 * that would match everything.
 */
export const MAX_SEARCH_TERMS = 8;

export function searchTerms(q: string | undefined): string[] {
  if (!q) return [];
  const terms = q.trim().split(/\s+/).filter(Boolean);
  return [...new Set(terms)].slice(0, MAX_SEARCH_TERMS);
}
