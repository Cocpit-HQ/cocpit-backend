const { afterEach, beforeEach, describe, expect, jest: jestObject, test } = require("@jest/globals");
const { createStreamVideoFromUrl, deleteStreamVideo, isStreamConfigured } = require("./cloudflareStream.client");

describe("Cloudflare Stream API client", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
    jestObject.restoreAllMocks();
  });

  beforeEach(() => {
    process.env.CLOUDFLARE_STREAM_ACCOUNT_ID = "account-id";
    process.env.CLOUDFLARE_STREAM_API_TOKEN = "secret-token";
    process.env.CLOUDFLARE_STREAM_CUSTOMER_CODE = "customer-code";
  });

  test("copies a public R2 URL and returns playback endpoints", async () => {
    const fetchMock = jestObject.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { uid: "stream-uid" } }),
    });
    const result = await createStreamVideoFromUrl({ url: "https://media.example/video.mov", creator: "user", name: "clip.mov" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/account-id/stream/copy",
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ Authorization: "Bearer secret-token" }) })
    );
    expect(result.hlsUrl).toContain("customer-customer-code.cloudflarestream.com/stream-uid/manifest/video.m3u8");
  });

  test("deletes assets when Cloudflare returns an empty success response", async () => {
    const fetchMock = jestObject.spyOn(global, "fetch").mockResolvedValue({ ok: true, status: 204 });
    await expect(deleteStreamVideo("stream-uid")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("treats an already-removed Stream asset as an idempotent delete", async () => {
    jestObject.spyOn(global, "fetch").mockResolvedValue({ ok: false, status: 404 });
    await expect(deleteStreamVideo("already-deleted")).resolves.toBeUndefined();
  });

  test("requires all playback configuration before enabling Stream processing", () => {
    expect(isStreamConfigured()).toBe(true);
    delete process.env.CLOUDFLARE_STREAM_CUSTOMER_CODE;
    expect(isStreamConfigured()).toBe(false);
  });
});
