import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { jobPayloadJson } from "@/server/jobs/payload";

/**
 * A malformed job body is an invalid payload (400, no retry), never a thrown
 * parse error that QStash retries and parks in its dead-letter queue.
 */
describe("jobPayloadJson", () => {
  it("parses a JSON body", () => {
    expect(jobPayloadJson('{"reminderId":"r-1"}')).toEqual({ reminderId: "r-1" });
  });

  it.each(["", "not json", "{", '{"a":', "\u0000"])(
    "%j is undefined, which no payload schema accepts",
    (body) => {
      const parsed = z.object({ reminderId: z.string() }).safeParse(jobPayloadJson(body));
      expect(parsed.success).toBe(false);
    },
  );
});

describe("every job route parses its verified body through jobPayloadJson", () => {
  const root = path.join(__dirname, "../../src/app/api/v1/jobs");
  const routes = fs.readdirSync(root).map((dir) => path.join(dir, "route.ts"));

  it.each(routes)("%s", (route) => {
    const source = fs.readFileSync(path.join(root, route), "utf8");
    // The job body is the verified raw text; a bare JSON.parse of it throws on
    // a malformed message. The two routes with optional bodies guard their
    // parse with try/catch; the others use the helper.
    const bare = source.match(/JSON\.parse\((rawBody|body)\)/g) ?? [];
    const guarded =
      source.includes("jobPayloadJson(") ||
      /try\s*\{[^}]*JSON\.parse\((rawBody|body)\)/s.test(source);
    expect(guarded || bare.length === 0, `${route}: guard the body parse`).toBe(true);
  });
});
