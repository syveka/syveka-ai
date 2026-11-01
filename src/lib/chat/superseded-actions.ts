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
 */
export function supersededActionIds(
  actionsInOrder: readonly ActionInThread[],
  now: number = Date.now(),
): Set<string> {
  const open = actionsInOrder.filter(
    (a) => a.details.tool === "proposeBusinessDnaUpdate" && !a.restored && a.expiresAt > now,
  );
  const superseded = new Set<string>();
  for (let i = 0; i < open.length; i++) {
    const fields = new Set(changedFields(open[i]!));
    for (let j = i + 1; j < open.length; j++) {
      if (changedFields(open[j]!).some((f) => fields.has(f))) {
        superseded.add(open[i]!.id);
        break;
      }
    }
  }
  return superseded;
}
