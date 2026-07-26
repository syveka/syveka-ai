import { beforeEach, describe, expect, it, vi } from "vitest";

const { publishJSONMock } = vi.hoisted(() => ({
  publishJSONMock: vi.fn(async (_request: Record<string, unknown>) => ({ messageId: "msg-1" })),
}));

vi.mock("@upstash/qstash", () => ({
  Client: vi.fn().mockImplementation(() => ({ publishJSON: publishJSONMock })),
}));

import { enqueue } from "@/server/jobs/queue";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("enqueue", () => {
  it("passes deduplicationId through to QStash when provided", async () => {
    await enqueue(
      "post-call",
      { vapiCallId: "call-1", orgId: "org-a" },
      { deduplicationId: "vapi-eocr-org-a-call-1" },
    );
    expect(publishJSONMock).toHaveBeenCalledTimes(1);
    const request = publishJSONMock.mock.calls[0]![0];
    expect(request.deduplicationId).toBe("vapi-eocr-org-a-call-1");
  });

  it("existing callers without deduplicationId behave unchanged (property omitted)", async () => {
    await enqueue("embed-document", { documentId: "doc-1" });
    expect(publishJSONMock).toHaveBeenCalledTimes(1);
    const request = publishJSONMock.mock.calls[0]![0];
    expect(request).not.toHaveProperty("deduplicationId");
    expect(request.body).toEqual({ documentId: "doc-1" });
    expect(request.retries).toBe(3);
  });

  it("existing delaySeconds-only callers are unaffected by the new option", async () => {
    await enqueue("send-reminder", { reminderId: "rem-1" }, { delaySeconds: 30 });
    const request = publishJSONMock.mock.calls[0]![0];
    expect(request.delay).toBe(30);
    expect(request).not.toHaveProperty("deduplicationId");
  });
});
