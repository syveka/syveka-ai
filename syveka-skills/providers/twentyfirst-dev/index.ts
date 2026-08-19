import { createUnavailableStubProvider } from "../unavailable-stub.js";

export const twentyFirstDevProvider = createUnavailableStubProvider({
  id: "21st-dev",
  reason:
    "21st.dev is a metered/remote-generation service requiring an API key and owner approval " +
    "before any live use - not connected in this environment.",
});
