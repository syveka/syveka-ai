-- Google's watch API and Microsoft Graph's subscriptions API both support an opaque
-- caller-supplied value (Google: `token`, echoed back as X-Goog-Channel-Token; Microsoft:
-- `clientState`, echoed back on every notification) that lets a webhook receiver confirm a
-- notification really originated from the subscription it claims to belong to. Neither was
-- previously being set or verified (P0.2), so any request naming a known subscription/channel
-- id could trigger a sync.
--
-- Only a SHA-256 hash of the generated secret is ever persisted -- the raw value is sent to
-- the provider once, at subscription time, and never needs to be recovered afterward, only
-- compared. Nullable and additive: existing rows get NULL until their next subscription
-- renewal, at which point a fresh secret is generated and this column is populated for real.

ALTER TABLE "calendar_sync_states" ADD COLUMN "webhook_verification_secret_hash" TEXT;
