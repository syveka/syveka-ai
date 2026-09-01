import fs from "node:fs/promises";
import { test as setup } from "@playwright/test";
import { loginAsE2EUser, requireE2EUserCredentials } from "./helpers/auth";

const E2E_AUTH_STATE = "test-results/.auth/e2e-user.json";

setup("authenticate the staging E2E user once", async ({ page }) => {
  requireE2EUserCredentials();
  await loginAsE2EUser(page);
  await fs.mkdir("test-results/.auth", { recursive: true });
  await page.context().storageState({ path: E2E_AUTH_STATE });
});
