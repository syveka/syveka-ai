import type { ProposedActionView, RestoredActionState } from "@/lib/validators/chat";
import type { BusinessDnaChange } from "@/lib/validators/business-dna-patch";

type ActionInThread = ProposedActionView & { restored?: RestoredActionState };
type Field = BusinessDnaChange["field"];

/** What a replaced proposal's card is told. */
export type Supersession = {
  /** Fields of the replaced proposal that no replacing proposal changes: they are not carried over. */
  notCarriedOver: Field[];
};

/** The Business DNA fields a proposal changes (empty for every other tool). */
function changedFields(action: ProposedActionView): Field[] {
  return action.details.tool === "proposeBusinessDnaUpdate"
    ? action.details.changes.map((c) => c.field)
    : [];
}

/**
 * Earlier Business DNA proposals that a newer one in the same conversation
 * replaces: when the user corrects a fact ("actually we close at 16"), the
 * assistant proposes again, and the earlier card must not stay confirmable
 * with the superseded value. A proposal is superseded by a later one that
 * changes at least one of the same fields and is still open (undecided and
 * unexpired) or applied; proposals about different fields (hours, then
 * languages) stay independent.
 *
 * A canceled, expired or failed newer proposal replaces nothing, so the
 * earlier one is offered again if it is itself still open. When the newer
 * proposal covers only some of the earlier one's fields, the rest are
 * reported as not carried over, so a change is never dropped silently.
 *
 * Purely a view decision: the server still binds every confirmation to its
 * own proposal, and a superseded one that is confirmed through the API is
 * refused as stale once the newer one has been applied to the same field.
 * Outcomes decided in this session and outcomes restored on reload count
 * the same way, so the view agrees with itself after a reload.
 */
export function supersededActions(
  actionsInOrder: readonly ActionInThread[],
  now: number = Date.now(),
  /** Outcomes decided in this session (the card reports them), by action id. */
  decided: ReadonlyMap<string, RestoredActionState> = new Map(),
): Map<string, Supersession> {
  const outcome = (a: ActionInThread) => a.restored ?? decided.get(a.id);
  const dna = actionsInOrder.filter((a) => a.details.tool === "proposeBusinessDnaUpdate");
  // Still confirmable: no outcome yet, and not expired.
  const isOpen = (a: ActionInThread) => !outcome(a) && a.expiresAt > now;
  // Replaces earlier ones about the same fields: still open, or applied (the
  // field now holds the newer value).
  const replaces = (a: ActionInThread) => isOpen(a) || outcome(a) === "done";
  const superseded = new Map<string, Supersession>();
  for (let i = 0; i < dna.length; i++) {
    if (!isOpen(dna[i]!)) continue;
    const fields = changedFields(dna[i]!);
    const covered = new Set<Field>();
    for (let j = i + 1; j < dna.length; j++) {
      if (!replaces(dna[j]!)) continue;
      const later = changedFields(dna[j]!);
      if (later.some((f) => fields.includes(f))) later.forEach((f) => covered.add(f));
    }
    if (covered.size > 0) {
      superseded.set(dna[i]!.id, { notCarriedOver: fields.filter((f) => !covered.has(f)) });
    }
  }
  return superseded;
}
