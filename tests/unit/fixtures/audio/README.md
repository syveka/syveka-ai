Real `MediaRecorder` output from Chromium's synthetic fake audio device
(`--use-fake-device-for-media-stream`): no microphone, no personal audio.
Recorded for ~2 s each; used by `audio-duration.test.ts`.

- `chrome-opus-2s.webm` — `audio/webm;codecs=opus`
- `chrome-opus-2s.mp4` — `audio/mp4` (Chromium chose Opus)
- `chrome-aac-2s.mp4` — `audio/mp4;codecs=mp4a.40.2`
