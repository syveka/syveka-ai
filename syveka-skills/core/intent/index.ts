/**
 * Intent classification.
 *
 * Important design note (see docs/architecture.md "Where the LLM fits"):
 * Syveka Master Skill is designed to run INSIDE an LLM agent (Claude Code,
 * Codex, Gemini CLI). In real usage, the HOST AGENT's own reasoning is the
 * primary intent classifier and planner - it reads the capability taxonomy
 * below and the SKILL.md-equivalent instructions, then decides what's
 * needed, the same way it decides which of its other tools to call. This
 * module does not try to reimplement that with a bespoke NLU model.
 *
 * What this module provides instead is a small, deterministic, testable
 * fallback classifier: a keyword-based mapping from request text to a
 * TaskType + starting capability list. It exists so the orchestrator's
 * core logic (routing, permissions, evidence, verification) can be
 * exercised and eval-tested end-to-end without a live LLM call in the
 * loop, and so a host agent has a documented, inspectable default to fall
 * back on rather than guessing silently.
 */

export type TaskType =
  | "ui_improvement"
  | "bug_fix"
  | "skill_discovery"
  | "web_research"
  | "video_analysis"
  | "documentation"
  | "skill_development"
  | "clarification_needed";

export interface IntentResult {
  taskType: TaskType;
  capabilities: string[];
  confidence: "high" | "low";
}

interface Rule {
  taskType: TaskType;
  capabilities: string[];
  keywords: RegExp;
}

const RULES: Rule[] = [
  {
    taskType: "bug_fix",
    // Deliberately does NOT include a "write the fix" capability: this
    // orchestrator governs and verifies, it does not write code itself -
    // that's the host LLM agent's job, same as in real usage (see
    // core/intent/index.ts's module doc comment). engineering.test proves
    // RED/GREEN; engineering.diff_capture proves what changed.
    capabilities: ["engineering.test", "engineering.diff_capture"],
    keywords: /\b(fix|bug|broken|fail(ing|ed)?|error|crash)\b/i,
  },
  {
    taskType: "ui_improvement",
    capabilities: ["ui.component.search", "ui.taste.evaluate"],
    // "page" was deliberately removed from this list (found during
    // Milestone 2's Scrapling work): it's too generic and false-positived
    // on genuinely non-UI requests like "research the competitor's
    // pricing page" - see evals/scrapling-provider.test.ts. dashboard/ui/
    // component/design/frontend/layout are all much more specifically
    // UI-shaped signals.
    keywords: /\b(dashboard|ui|component|design|frontend|layout)\b/i,
  },
  {
    taskType: "skill_discovery",
    capabilities: ["skill.discovery"],
    keywords: /\b(find (a )?skill|skill for|plugin for|tool for)\b/i,
  },
  {
    taskType: "web_research",
    capabilities: ["web.research"],
    keywords: /\b(research|competitor|website analysis|scrape|extract data from)\b/i,
  },
  {
    taskType: "video_analysis",
    capabilities: ["video.analyze"],
    keywords: /\b(video|watch this|recreate the interface|transcript)\b/i,
  },
  {
    taskType: "documentation",
    capabilities: ["docs.write", "docs.organize"],
    keywords: /\b(document|write docs|readme|changelog)\b/i,
  },
  {
    taskType: "skill_development",
    capabilities: ["skill.create", "skill.eval", "skill.security_review", "skill.package"],
    keywords: /\b(create a skill|new skill|build a skill)\b/i,
  },
];

/**
 * Deterministic, order-sensitive matching (first rule wins) rather than a
 * scored/ranked model - simple enough to unit test exhaustively, which
 * matters more for this fallback path than sophistication does. A request
 * matching no rule returns clarification_needed with low confidence rather
 * than guessing - see evals/ambiguous-requests.test.ts.
 */
export function classifyIntent(request: string): IntentResult {
  for (const rule of RULES) {
    if (rule.keywords.test(request)) {
      return { taskType: rule.taskType, capabilities: rule.capabilities, confidence: "high" };
    }
  }
  return { taskType: "clarification_needed", capabilities: [], confidence: "low" };
}
