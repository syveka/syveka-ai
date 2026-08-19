/**
 * Pure builder for the `docker run` argv used to invoke Scrapling -
 * separated out so the isolation flags and timeout wiring can be asserted
 * directly (evals/scrapling-docker-args.test.ts) without needing a real
 * Docker daemon or network call to prove they're present and correct.
 */
export interface DockerArgsInput {
  image: string;
  scratchDir: string;
  url: string;
  outputFilename: string;
  timeoutSeconds: number;
  cssSelector?: string;
}

export function buildDockerArgs(input: DockerArgsInput): string[] {
  return [
    "run",
    "--rm",
    "--network",
    "bridge",
    "--memory",
    "512m",
    "--cpus",
    "1",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/tmp",
    "-v",
    `${input.scratchDir}:/app/out`,
    input.image,
    "extract",
    "get",
    input.url,
    `/app/out/${input.outputFilename}`,
    "--timeout",
    String(input.timeoutSeconds),
    "--ai-targeted",
    ...(input.cssSelector ? ["--css-selector", input.cssSelector] : []),
  ];
}
