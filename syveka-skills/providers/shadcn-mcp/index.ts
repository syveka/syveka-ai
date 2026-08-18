import { createUnavailableStubProvider } from "../unavailable-stub.js";

export const shadcnMcpProvider = createUnavailableStubProvider({
  id: "shadcn",
  reason:
    "shadcn/ui MCP is not connected in this environment - no live MCP session configured. " +
    "See docs/skills/SKILLS_REGISTRY.md; status REVIEW, not yet independently reviewed for this MVP.",
});
