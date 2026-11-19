-- The owner's call-recording choice for each phone assistant, sent to Vapi on every sync as
-- artifactPlan.recordingEnabled (src/server/integrations/vapi.ts).
--
-- Nullable with no default on purpose. Existing assistants get NULL, which means no choice was
-- made in Syveka: a sync then leaves recording as set in Vapi's dashboard, as it does today.
-- New assistants are created with an explicit false by the application (services/voice.ts),
-- because Vapi's own default for a new assistant records. Additive: no existing row changes.
ALTER TABLE "voice_assistants" ADD COLUMN "recording_enabled" BOOLEAN;
