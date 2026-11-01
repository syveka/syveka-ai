import type { ProposedActionView, RestoredActionState } from "@/lib/validators/chat";

type ActionInThread = ProposedActionView & { restored?: RestoredActionState };

/** The Business DNA fields a proposal changes (empty for every other tool). */
function changedFields(action: ProposedActionView): string[] {
  return action.details.tool === "proposeBusinessDnaUpdate"
    ? action.details.changes.map((c) => c.field)
    : [];
}

/**
 * Earlier Business DNA proposals that a newer one in the same conversation
 * replaces: when the user corrects a fact ("actually we close at 16"), the
 * assistant proposes again, and the earlier card must not stay confirmable
 * with the superseded value. A proposal is superseded only by a later one
 * that is still undecided and changes at least one of the same fields;
 * proposals about different fields (hours, then languages) stay independent.
 *
 * Purely a view decision: the server still binds every confirmation to its
 * own proposal, and a superseded one that is confirmed through the API is
 * refused as stale once the newer one has been applied to the same field.
 * Outcomes decided in this session and outcomes restored on reload count
 * the same way, so the view agrees with itself after a reload.
 */
export function supersededActionIds(
  actionsInOrder: readonly ActionInThread[],
  now: number = Date.now(),
  /** Outcomes decided in this session (the card reports them), by action id. */
  decided: ReadonlyMap<string, RestoredActionState | "superseded"> = new Map(),
): Set<string> {
  const outcome = (a: ActionInThread) => a.restored ?? decided.get(a.id);
  const dna = actionsInOrder.filter((a) => a.details.tool === "proposeBusinessDnaUpdate");
  // Still confirmable: no outcome yet, and not expired.
  const isOpen = (a: ActionInThread) => !outcome(a) && a.expiresAt > now;
  // Replaces earlier ones about the same fields: still open, or applied (the
  // field now holds the newer value). A canceled, expired or failed newer
  // proposal replaces nothing: the earlier one is offered again.
  const replaces = (a: ActionInThread) => isOpen(a) || outcome(a) === "done";
  const superseded = new Set<string>();
  for (let i = 0; i < dna.length; i++) {
    if (!isOpen(dna[i]!)) continue;
    const fields = new Set(changedFields(dna[i]!));
    for (let j = i + 1; j < dna.length; j++) {
      if (replaces(dna[j]!) && changedFields(dna[j]!).some((f) => fields.has(f))) {
        superseded.add(dna[i]!.id);
        break;
      }
    }
  }
  return superseded;
}
