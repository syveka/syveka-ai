# HyperFrames render worker (development only)

A proof of concept that turns validated JSON into short videos from fixed templates, inside an
isolated container. **Not part of the product:** nothing in `src/` imports it, no route calls it,
and no feature flag enables it.

Design and security model: [docs/architecture/creator-studio-render-worker.md](../../docs/architecture/creator-studio-render-worker.md).
Measured results: [docs/research/hyperframes-pilot-results.md](../../docs/research/hyperframes-pilot-results.md).

## Run it

Needs Docker on a local machine. The build downloads about 300 MB and needs about 1.5 GB of disk; rendering uses no
network. **On Docker Desktop with WSL, make sure the system drive has several GB free.**

```sh
cd experiments/hyperframes-render-worker
docker build -t syveka-hyperframes-render-worker:dev .
node scripts/sample-job.mjs demo product-ad > /tmp/job.json
# <inputDir> holds logo.png and photo.jpg. <outputDir> must not already hold these MP4 files.
node scripts/run-worker.mjs /tmp/job.json <inputDir> <outputDir>
```

Always start it through `scripts/run-worker.mjs`, which applies the isolation flags and enforces the
job deadline. The container has no writable host mount: `scripts/read-output.mjs` receives files over
stdout, applies its own limits, and writes them. It prints one JSON result: a per-render outcome with
`hostVerified`, and a stable error code on failure.

## Job format

`src/schema.mjs` is the contract. Each render takes a template (`product-ad`, `local-service`,
`social-announcement`), a language (`fi`, `en`, `ar`), an aspect ratio (`9:16`, `1:1`, `16:9`),
`brand`, `headline`, optional `description`, `callToAction`, four colors, and optional `logo` and
`media` file names. File names must be plain names inside the input directory. There is no field
that accepts HTML, CSS, JavaScript, a URL or a path.

## Tests

`tests/unit/hyperframes-render-worker.test.ts` runs in the root suite without Docker. Container
behaviour (network isolation, limits, malicious media) is measured by hand and recorded in the
pilot results.
