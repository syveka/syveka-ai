export function sniffMediaType(header: Buffer): "png" | "jpeg" | "webp" | "mp4" | null;
export function normalizeMedia(args: {
  inputDir: string;
  file: string;
  kind: "image" | "video";
  outputPath: string;
  scratchDir: string;
}): Promise<void>;
