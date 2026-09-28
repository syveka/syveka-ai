/**
 * Server-side audio duration for chat voice uploads, measured from the audio
 * frames themselves — the same frames the transcription provider decodes and
 * bills — never from container headers or timestamps, which the client
 * controls. A small file can still hold a long recording at a low bitrate, so
 * the upload size cap alone does not bound duration.
 *
 * Supported: what MediaRecorder produces for the chat client — WebM with
 * Opus (Chrome, Edge, Firefox, Android) and fragmented or plain MP4 with Opus
 * or AAC (Safari; Chrome's audio/mp4). Anything that can't be measured
 * (other codecs, laced blocks, several tracks, truncated structure) returns
 * null so the caller can refuse it before any paid processing.
 */

class Unmeasurable extends Error {}
const fail = (): never => {
  throw new Unmeasurable();
};

/** Opus packet duration in ms from its TOC byte(s) (RFC 6716 §3.1). */
export function opusPacketMs(packet: Uint8Array): number {
  if (packet.length < 1) fail();
  const toc = packet[0]!;
  const config = toc >> 3;
  const frameMs =
    config < 12
      ? [10, 20, 40, 60][config % 4]! // SILK
      : config < 16
        ? [10, 20][config % 2]! // Hybrid
        : [2.5, 5, 10, 20][config % 4]!; // CELT
  const code = toc & 0x03;
  let frames = code === 0 ? 1 : code === 3 ? -1 : 2;
  if (code === 3) {
    if (packet.length < 2) fail();
    frames = packet[1]! & 0x3f;
  }
  const ms = frames * frameMs;
  if (frames < 1 || ms > 120) fail(); // RFC 6716: at most 120 ms per packet
  return ms;
}

// ── WebM / Matroska (EBML) ──────────────────────────────────────────────

const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const CLUSTER = 0x1f43b675;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7;
const CODEC_ID = 0x86;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;

function readVint(b: Uint8Array, at: number, keepMarker: boolean) {
  if (at >= b.length) fail();
  const first = b[at]!;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || at + length > b.length) fail();
  let value = keepMarker ? first : first & ((0x80 >> (length - 1)) - 1);
  let allOnes = value === (0x80 >> (length - 1)) - 1;
  for (let i = 1; i < length; i++) {
    value = value * 256 + b[at + i]!;
    if (b[at + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function webmOpusSeconds(b: Uint8Array): number {
  let opusTrack: number | null = null;
  let tracks = 0;
  let totalMs = 0;

  const block = (start: number, end: number) => {
    const track = readVint(b, start, false);
    if (opusTrack === null || track.value !== opusTrack) fail();
    const flags = b[start + track.length + 2];
    if (flags === undefined || (flags & 0x06) !== 0) fail(); // lacing: not produced by MediaRecorder
    totalMs += opusPacketMs(b.subarray(start + track.length + 3, end));
  };

  const readTracks = (start: number, end: number) => {
    let at = start;
    while (at < end) {
      const id = readVint(b, at, true);
      const size = readVint(b, at + id.length, false);
      const body = at + id.length + size.length;
      if (size.unknown || body + size.value > end) fail();
      if (id.value === TRACK_ENTRY) {
        tracks++;
        let number: number | null = null;
        let codec = "";
        let p = body;
        while (p < body + size.value) {
          const cid = readVint(b, p, true);
          const csize = readVint(b, p + cid.length, false);
          const cbody = p + cid.length + csize.length;
          if (csize.unknown || cbody + csize.value > body + size.value) fail();
          if (cid.value === TRACK_NUMBER) {
            number = 0;
            for (let i = 0; i < csize.value; i++) number = number * 256 + b[cbody + i]!;
          }
          if (cid.value === CODEC_ID) {
            codec = String.fromCharCode(...b.subarray(cbody, cbody + csize.value));
          }
          p = cbody + csize.value;
        }
        if (codec === "A_OPUS" && number !== null) opusTrack = number;
      }
      at = body + size.value;
    }
  };

  // Walks a level. Segment and Cluster may have unknown size (streamed by
  // MediaRecorder): their content then runs to the end of the parent.
  const walk = (start: number, end: number) => {
    let at = start;
    while (at < end) {
      const id = readVint(b, at, true);
      const size = readVint(b, at + id.length, false);
      const body = at + id.length + size.length;
      const bodyEnd = size.unknown ? end : body + size.value;
      if (bodyEnd > end) fail();
      if (id.value === SEGMENT) {
        // Nothing may follow the (single) segment: a decoder could read it.
        if (bodyEnd !== end) fail();
        walk(body, bodyEnd);
        return;
      }
      if (id.value === CLUSTER) {
        // An unknown-size cluster ends where the next cluster begins, which
        // at this level simply appears as a sibling element.
        if (size.unknown) {
          at = body;
          continue;
        }
        walk(body, bodyEnd);
      } else if (id.value === TRACKS) {
        readTracks(body, bodyEnd);
        if (tracks !== 1 || opusTrack === null) fail();
      } else if (id.value === SIMPLE_BLOCK) {
        block(body, bodyEnd);
      } else if (id.value === BLOCK_GROUP) {
        walk(body, bodyEnd);
      } else if (id.value === BLOCK) {
        block(body, bodyEnd);
      } else if (size.unknown) {
        fail(); // only Segment/Cluster may stream with unknown size
      }
      at = bodyEnd;
    }
  };

  if (readVint(b, 0, true).value !== EBML) fail();
  walk(0, b.length);
  if (opusTrack === null) fail();
  return totalMs / 1000;
}

// ── MP4 / ISO BMFF ─────────────────────────────────────────────────────

const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

type Box = { type: string; start: number; body: number; end: number };

function boxes(b: Uint8Array, start: number, end: number): Box[] {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Box[] = [];
  let at = start;
  while (at < end) {
    if (at + 8 > end) fail();
    let size = view.getUint32(at);
    const type = String.fromCharCode(...b.subarray(at + 4, at + 8));
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) fail();
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) fail();
    out.push({ type, start: at, body: at + header, end: at + size });
    at += size;
  }
  return out;
}

const child = (b: Uint8Array, box: Box, type: string, skip = 0) =>
  boxes(b, box.body + skip, box.end).filter((x) => x.type === type);

/** MPEG-4 descriptor header (tag, size) at `at` (ISO/IEC 14496-1 §8.3.3). */
function descriptor(b: Uint8Array, at: number, end: number) {
  if (at >= end) fail();
  const tag = b[at]!;
  let size = 0;
  let p = at + 1;
  for (let k = 0; k < 4; k++) {
    if (p >= end) fail();
    const byte = b[p++]!;
    size = (size << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) break;
  }
  if (p + size > end) fail();
  return { tag, body: p, end: p + size };
}

/** Core sampling rate from the AudioSpecificConfig the decoder uses. */
function aacSampleRate(b: Uint8Array, esds: Box): number {
  const es = descriptor(b, esds.body + 4, esds.end); // skip version/flags
  if (es.tag !== 0x03) fail();
  const esFlags = b[es.body + 2]!;
  let p = es.body + 3;
  if (esFlags & 0x80) p += 2; // dependsOn_ES_ID
  if (esFlags & 0x40) p += 1 + b[p]!; // URL
  if (esFlags & 0x20) p += 2; // OCR_ES_Id
  const config = descriptor(b, p, es.end);
  if (config.tag !== 0x04) fail();
  const info = descriptor(b, config.body + 13, config.end);
  if (info.tag !== 0x05 || info.end - info.body < 2) fail();
  const bits = (b[info.body]! << 16) | (b[info.body + 1]! << 8) | (b[info.body + 2] ?? 0);
  const escaped = bits >> 19 === 31; // audioObjectType escape: 6 more bits
  const index = (bits >> (escaped ? 9 : 15)) & 0x0f;
  const rate = AAC_SAMPLE_RATES[index];
  if (!rate) fail(); // explicit 24-bit rates aren't produced by browsers
  return rate!;
}

function mp4Seconds(b: Uint8Array): number {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const top = boxes(b, 0, b.length);
  const moov = top.filter((x) => x.type === "moov");
  if (moov.length !== 1) fail();
  const traks = child(b, moov[0]!, "trak");
  if (traks.length !== 1) fail();
  const mdia = child(b, traks[0]!, "mdia")[0] ?? fail();
  const mdhd = child(b, mdia, "mdhd")[0] ?? fail();
  const timescale = view.getUint32(mdhd.body + (b[mdhd.body] === 1 ? 20 : 12));
  if (!timescale) fail();
  const stbl = child(b, child(b, mdia, "minf")[0] ?? fail(), "stbl")[0] ?? fail();
  const stsd = child(b, stbl, "stsd")[0] ?? fail();
  const entries = boxes(b, stsd.body + 8, stsd.end);
  if (entries.length !== 1) fail();
  const entry = entries[0]!;
  let codec: "opus" | "aac";
  let aacRate = 0;
  if (entry.type === "Opus") codec = "opus";
  else if (entry.type === "mp4a") {
    codec = "aac";
    aacRate = aacSampleRate(b, child(b, entry, "esds", 28)[0] ?? fail());
  } else return fail();

  // Samples: (offset, size, declared duration) from fragments or the sample table.
  const samples: Array<{ offset: number; size: number; duration: number }> = [];
  const mvex = child(b, moov[0]!, "mvex")[0];
  const trex = mvex ? child(b, mvex, "trex")[0] : undefined;
  const trexDuration = trex ? view.getUint32(trex.body + 12) : 0;
  const trexSize = trex ? view.getUint32(trex.body + 16) : 0;

  for (const moof of top.filter((x) => x.type === "moof")) {
    for (const traf of child(b, moof, "traf")) {
      const tfhd = child(b, traf, "tfhd")[0] ?? fail();
      const tf = view.getUint32(tfhd.body) & 0xffffff;
      let p = tfhd.body + 8; // version/flags + track_ID
      let base = moof.start; // default-base-is-moof (browsers) or moof start
      if (tf & 0x1) {
        base = Number(view.getBigUint64(p));
        p += 8;
      }
      if (tf & 0x2) p += 4;
      let defDuration = trexDuration;
      let defSize = trexSize;
      if (tf & 0x8) {
        defDuration = view.getUint32(p);
        p += 4;
      }
      if (tf & 0x10) defSize = view.getUint32(p);
      let dataAt = base;
      for (const trun of child(b, traf, "trun")) {
        const rf = view.getUint32(trun.body) & 0xffffff;
        const count = view.getUint32(trun.body + 4);
        let q = trun.body + 8;
        if (rf & 0x1) {
          dataAt = base + view.getInt32(q);
          q += 4;
        }
        if (rf & 0x4) q += 4;
        for (let i = 0; i < count; i++) {
          let duration = defDuration;
          let size = defSize;
          if (rf & 0x100) ((duration = view.getUint32(q)), (q += 4));
          if (rf & 0x200) ((size = view.getUint32(q)), (q += 4));
          if (rf & 0x400) q += 4;
          if (rf & 0x800) q += 4;
          if (q > trun.end) fail();
          samples.push({ offset: dataAt, size, duration });
          dataAt += size;
        }
      }
    }
  }

  if (samples.length === 0) {
    // Non-fragmented: stsz sizes + stco/co64 chunk offsets via stsc, stts durations.
    const stsz = child(b, stbl, "stsz")[0] ?? fail();
    const fixed = view.getUint32(stsz.body + 4);
    const count = view.getUint32(stsz.body + 8);
    // Every sample occupies at least one byte of this file.
    if (count > b.length || (!fixed && stsz.body + 12 + count * 4 > stsz.end)) fail();
    const sizes = Array.from(
      { length: count },
      (_, i) => fixed || view.getUint32(stsz.body + 12 + i * 4),
    );
    const stco = child(b, stbl, "stco")[0];
    const co64 = child(b, stbl, "co64")[0];
    const chunkBox = stco ?? co64 ?? fail();
    const chunks = view.getUint32(chunkBox.body + 4);
    const chunkOffset = (i: number) =>
      stco
        ? view.getUint32(chunkBox.body + 8 + i * 4)
        : Number(view.getBigUint64(chunkBox.body + 8 + i * 8));
    const stsc = child(b, stbl, "stsc")[0] ?? fail();
    const runs = view.getUint32(stsc.body + 4);
    const stts = child(b, stbl, "stts")[0] ?? fail();
    const durations: number[] = [];
    for (let i = 0; i < view.getUint32(stts.body + 4); i++) {
      const n = view.getUint32(stts.body + 8 + i * 8);
      const d = view.getUint32(stts.body + 12 + i * 8);
      if (durations.length + n > count) fail();
      for (let k = 0; k < n; k++) durations.push(d);
    }
    let sample = 0;
    for (let r = 0; r < runs; r++) {
      const first = view.getUint32(stsc.body + 8 + r * 12) - 1;
      const perChunk = view.getUint32(stsc.body + 12 + r * 12);
      const last = r + 1 < runs ? view.getUint32(stsc.body + 8 + (r + 1) * 12) - 1 : chunks;
      for (let c = first; c < last && sample < count; c++) {
        let at = chunkOffset(c);
        for (let k = 0; k < perChunk && sample < count; k++) {
          samples.push({ offset: at, size: sizes[sample]!, duration: durations[sample] ?? 0 });
          at += sizes[sample]!;
          sample++;
        }
      }
    }
    if (sample !== count) fail();
  }

  let frameSeconds = 0;
  let declared = 0;
  for (const s of samples) {
    if (s.offset < 0 || s.size < 1 || s.offset + s.size > b.length) fail();
    declared += s.duration;
    frameSeconds +=
      codec === "opus"
        ? opusPacketMs(b.subarray(s.offset, s.offset + s.size)) / 1000
        : 1024 / aacRate; // one AAC frame decodes to 1024 samples per channel
  }
  // Report the longer of what the frames decode to and what the file claims.
  return Math.max(frameSeconds, declared / timescale);
}

export type MeasuredAudio = { container: "webm" | "mp4"; seconds: number };

/** Decoded duration of a chat voice upload, or null when it can't be verified. */
export function measureAudioDuration(bytes: Uint8Array): MeasuredAudio | null {
  try {
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      return { container: "webm", seconds: webmOpusSeconds(bytes) };
    }
    if (String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp") {
      return { container: "mp4", seconds: mp4Seconds(bytes) };
    }
    return null;
  } catch (e) {
    if (e instanceof Unmeasurable || e instanceof RangeError) return null;
    throw e;
  }
}
