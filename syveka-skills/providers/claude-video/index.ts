import { createUnavailableStubProvider } from "../unavailable-stub.js";

export const claudeVideoProvider = createUnavailableStubProvider({
  id: "claude-video",
  reason:
    "claude-video (bradautomates/claude-video) has not completed a Syveka security review " +
    "yet - status REVIEW in the registry, not installed.",
});
