/** Default Finnish sales pipeline (§18). Seeded per org at onboarding. */
export const DEFAULT_PIPELINE_STAGES = [
  { name: "Uusi liidi", order: 0, probability: 10 },
  { name: "Yhteydenotto", order: 1, probability: 25 },
  { name: "Tarjous", order: 2, probability: 50 },
  { name: "Neuvottelu", order: 3, probability: 75 },
  { name: "Voitettu", order: 4, probability: 100, isWon: true },
  { name: "Hävitty", order: 5, probability: 0, isLost: true },
] as const;
