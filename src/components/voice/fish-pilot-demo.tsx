"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  PILOT_LANGUAGES,
  PILOT_MOCK_FAILURES,
  PILOT_SCENARIOS,
  type PilotEvent,
  type PilotLanguage,
  type PilotMockFailure,
  type PilotScenario,
} from "@/lib/voice/fish-pilot-scenarios";

const SELECT_CLASS = "rounded-md border bg-background px-2 py-1 text-sm";

function pcm16ToFloat32(base64: string): Float32Array<ArrayBuffer> {
  const binary = atob(base64);
  const samples = new Float32Array(Math.floor(binary.length / 2));
  for (let i = 0; i < samples.length; i++) {
    const value = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
    samples[i] = (value >= 0x8000 ? value - 0x10000 : value) / 0x8000;
  }
  return samples;
}

export function FishPilotDemo() {
  const [language, setLanguage] = useState<PilotLanguage>("fi");
  const [scenario, setScenario] = useState<PilotScenario>("greeting");
  const [mockFailure, setMockFailure] = useState<PilotMockFailure>("none");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const abort = useRef<AbortController | null>(null);
  const audio = useRef<{ context: AudioContext; sources: AudioBufferSourceNode[] } | null>(null);

  const append = (line: string) => setLog((lines) => [...lines, line]);

  function stopAudio() {
    audio.current?.sources.forEach((source) => source.stop());
    void audio.current?.context.close();
    audio.current = null;
  }

  function interrupt() {
    abort.current?.abort();
    stopAudio();
    append("-- interrupted");
  }

  async function runTurn() {
    stopAudio();
    const controller = new AbortController();
    abort.current = controller;
    const context = new AudioContext();
    const sources: AudioBufferSourceNode[] = [];
    audio.current = { context, sources };
    let nextStart = context.currentTime;
    setBusy(true);

    const handle = (event: PilotEvent) => {
      if (event.type === "reply") {
        append(`caller: ${event.caller}`);
        append(`assistant: ${event.text}`);
        event.toolResults.forEach((t) => append(`tool ${t.tool}: ${t.result}`));
      } else if (event.type === "audio") {
        const samples = pcm16ToFloat32(event.data);
        const buffer = context.createBuffer(1, samples.length, event.sampleRate);
        buffer.copyToChannel(samples, 0);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        nextStart = Math.max(nextStart, context.currentTime);
        source.start(nextStart);
        nextStart += buffer.duration;
        sources.push(source);
      } else if (event.type === "done") {
        const label = event.syntheticTiming ? " (SYNTHETIC: mock delays, not a provider)" : "";
        append(
          `${event.provider}: first audio ${event.firstAudioMs} ms, total ${event.totalMs} ms, ${event.audioBytes} bytes${label}`,
        );
      } else {
        append(`error: ${event.code}`);
      }
    };

    try {
      const response = await fetch("/api/v1/dev/fish-voice-pilot/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          turnId: crypto.randomUUID(),
          language,
          scenario,
          mockFailure,
        }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        append(`refused: HTTP ${response.status}`);
        return;
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let pending = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += value;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        lines.filter(Boolean).forEach((line) => handle(JSON.parse(line) as PilotEvent));
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        append(`error: ${error instanceof Error ? error.name : "unknown"}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Fish Audio voice pilot (development only)</h1>
      <p className="text-sm text-muted-foreground">
        Scripted caller, no LLM, mock CRM and calendar. Plays a test tone unless real calls were
        explicitly allowed on the server.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Language"
          className={SELECT_CLASS}
          value={language}
          onChange={(e) => setLanguage(e.target.value as PilotLanguage)}
        >
          {PILOT_LANGUAGES.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <select
          aria-label="Scenario"
          className={SELECT_CLASS}
          value={scenario}
          onChange={(e) => setScenario(e.target.value as PilotScenario)}
        >
          {PILOT_SCENARIOS.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <select
          aria-label="Injected mock failure"
          className={SELECT_CLASS}
          value={mockFailure}
          onChange={(e) => setMockFailure(e.target.value as PilotMockFailure)}
        >
          {PILOT_MOCK_FAILURES.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <Button onClick={() => void runTurn()} disabled={busy}>
          Run turn
        </Button>
        <Button variant="outline" onClick={interrupt} disabled={!busy}>
          Interrupt
        </Button>
      </div>
      <ul className="space-y-1 rounded-md border p-3 font-mono text-xs" aria-live="polite">
        {log.map((line, index) => (
          <li key={index} dir="auto">
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}
