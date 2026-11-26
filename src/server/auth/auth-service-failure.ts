/**
 * Whether a Supabase Auth `getUser()` error means the auth service failed
 * (it couldn't be reached, timed out, errored or refused the request), as
 * opposed to an expected answer about this request's session: no session,
 * an expired or invalid token, a user or session that no longer exists.
 *
 * Both reach the app as "no user". Only the first is an outage: it must stay
 * observable instead of being treated like a signed-out visitor.
 *
 * Based on @supabase/auth-js's own classification: a network failure or a
 * 502/503/504 is an AuthRetryableFetchError, a response it can't read is an
 * AuthUnknownError; answers about the session are 4xx (AuthSessionMissingError
 * is 400, a bad or expired JWT 401/403).
 */
export function isAuthServiceFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, status } = error as { name?: unknown; status?: unknown };
  if (name === "AuthRetryableFetchError" || name === "AuthUnknownError") return true;
  if (typeof status !== "number") return false;
  // 429: the service is refusing requests (rate limit), not judging the session.
  return status >= 500 || status === 429;
}

/**
 * The auth service failed while checking this request's session. Thrown by
 * the page guards instead of redirecting, so an outage reaches error
 * tracking. Carries no message from the provider.
 */
export class AuthServiceUnavailableError extends Error {
  constructor() {
    super("Auth service unavailable");
    this.name = "AuthServiceUnavailableError";
  }
}
