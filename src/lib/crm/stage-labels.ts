import { DEFAULT_PIPELINE_STAGES } from "@/lib/constants";

/**
 * Display labels for pipeline stages.
 *
 * Stage names are organization data (PipelineStage.name). Every
 * organization's pipeline is seeded with DEFAULT_PIPELINE_STAGES, whose
 * names are Finnish, and customers can rename, add and delete stages.
 *
 * A stage is shown with a translated label only when it is the untouched
 * system default: its stored name is exactly the seeded name AT ITS SEEDED
 * POSITION (`order`), with the seeded won/lost flags. Stages are never
 * reordered, a rename changes the name and new stages are appended after
 * the seeded ones, so renamed and custom stages keep exactly what the
 * customer entered. A name alone is never translated: "Tarjous" at another
 * position, or with other flags, is shown as stored.
 *
 * This only affects display; stored data is never changed.
 */
export type DefaultStageKey = "newLead" | "contacted" | "proposal" | "negotiation" | "won" | "lost";

/** Translation keys of the seeded stages, by seeded order. */
const KEYS_BY_ORDER: readonly DefaultStageKey[] = [
  "newLead",
  "contacted",
  "proposal",
  "negotiation",
  "won",
  "lost",
];

type StageIdentity = { name: string; order: number; isWon: boolean; isLost: boolean };

export function defaultStageKey(stage: StageIdentity): DefaultStageKey | null {
  const seeded = DEFAULT_PIPELINE_STAGES[stage.order];
  const key = KEYS_BY_ORDER[stage.order];
  if (!seeded || !key) return null;
  const seededWon = "isWon" in seeded && seeded.isWon === true;
  const seededLost = "isLost" in seeded && seeded.isLost === true;
  if (stage.name !== seeded.name || stage.isWon !== seededWon || stage.isLost !== seededLost) {
    return null;
  }
  return key;
}

/** The label to show: a translation for an untouched default, otherwise the stored name. */
export function stageLabel(stage: StageIdentity, translate: (key: DefaultStageKey) => string) {
  const key = defaultStageKey(stage);
  return key ? translate(key) : stage.name;
}
