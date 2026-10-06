import { vi } from "vitest";

/**
 * Minimal fakes for getUserMedia + MediaRecorder. They model the event
 * order browsers use (dataavailable before stop) but record no real audio:
 * tests using them prove lifecycle logic, not real microphone capture.
 */
export class FakeTrack {
  stopped = false;
  enabled = true;
  stop() {
    this.stopped = true;
  }
}

export class FakeStream {
  tracks = [new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
}

export class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static supported = new Set(["audio/webm;codecs=opus", "audio/webm"]);
  static isTypeSupported(type: string) {
    return FakeMediaRecorder.supported.has(type);
  }
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  /** Bytes the fake "records" per stop. */
  static bytesPerRecording = 8192;

  constructor(
    public stream: FakeStream,
    options?: { mimeType?: string },
  ) {
    this.mimeType = options?.mimeType ?? "audio/webm";
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob([new Uint8Array(FakeMediaRecorder.bytesPerRecording)], {
        type: this.mimeType,
      }),
    });
    this.onstop?.();
  }
}

export function installFakeMedia(getUserMedia?: () => Promise<FakeStream>) {
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.supported = new Set(["audio/webm;codecs=opus", "audio/webm"]);
  FakeMediaRecorder.bytesPerRecording = 8192;
  const streams: FakeStream[] = [];
  const gum = vi.fn(
    getUserMedia ??
      (async () => {
        const s = new FakeStream();
        streams.push(s);
        return s;
      }),
  );
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: gum },
  });
  (window as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
  (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
  return { gum, streams };
}

export function uninstallFakeMedia() {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
  delete (window as unknown as { MediaRecorder?: unknown }).MediaRecorder;
  delete (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder;
}

export function domError(name: string) {
  return new DOMException(name, name);
}
