import type { IntentResult } from "../intent/index.js";
import type { Plan } from "../../schemas/index.js";

const DESCRIPTIONS: Record<string, string> = {
  "engineering.reproduce": "Reproduce the reported failure",
  "engineering.fix": "Apply a fix",
  "engineering.test": "Run the relevant test suite",
  "engineering.implement": "Implement the requested change",
  "evidence.verify": "Verify the result against collected evidence",
  "ui.component.search": "Search for a suitable UI component provider",
  "ui.taste.evaluate": "Evaluate visual/UX quality",
  "skill.discovery": "Discover candidate skills for the requested capability",
  "skill.security_review": "Run provenance/license/security review on candidates",
  "web.research": "Fetch and extract content from the target page(s)",
  "video.analyze": "Extract frames/transcript and analyze the video",
  "docs.write": "Write or update documentation",
  "docs.organize": "Organize documentation structure",
  "skill.create": "Create a new skill from requirements",
  "skill.eval": "Generate and run evals for the new skill",
  "skill.package": "Package and version the skill for the registry",
};

/**
 * Template-based planning: turns an intent's capability list into an
 * ordered Plan. Deliberately not a search/optimization planner - the
 * capability order in core/intent/index.ts's rules already encodes the
 * sensible sequence for each task type, so planning here is a direct,
 * auditable transcription, not a black box.
 */
export function buildPlan(intent: IntentResult): Plan {
  if (intent.capabilities.length === 0) {
    return {
      steps: [
        {
          capability: "clarification.request",
          description: "Request clarification - the request did not match a known task type",
        },
      ],
    };
  }
  return {
    steps: intent.capabilities.map((capability) => ({
      capability,
      description: DESCRIPTIONS[capability] ?? `Execute capability: ${capability}`,
    })),
  };
}
