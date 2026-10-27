const crypto = require("crypto");
const { describe, expect, jest: jestObject, test } = require("@jest/globals");
jestObject.mock("../../core/db/pool", () => ({ query: jestObject.fn() }));
jestObject.mock("../../core/db/redis", () => ({ isOpen: false, get: jestObject.fn(), set: jestObject.fn() }));
jestObject.mock("../../core/infrastructure/socket.service", () => ({ broadcastGlobal: jestObject.fn(), notifyUser: jestObject.fn() }));
const pool = require("../../core/db/pool");
const { verifyWebhookSignature, handleStreamWebhook } = require("./streamWebhook.controller");

describe("Cloudflare Stream webhook signatures", () => {
  const secret = "test-webhook-secret";
  const now = 1_800_000_000;

  function signatureFor(body, timestamp = now) {
    const digest = crypto.createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
    return `time=${timestamp},sig1=${digest}`;
  }

  test("accepts an exact, fresh signature", () => {
    const body = Buffer.from('{"uid":"video-1"}');
    expect(verifyWebhookSignature(body, signatureFor(body), secret, now)).toBe(true);
  });

  test.each([
    [Buffer.from("different"), () => signatureFor(Buffer.from("other"))],
    [Buffer.from("body"), () => "time=1800000000,sig1=not-hex"],
    [Buffer.from("body"), (body) => signatureFor(body, now - 301)],
  ])("rejects invalid signature input", (body, makeHeader) => {
    expect(verifyWebhookSignature(body, makeHeader(body), secret, now)).toBe(false);
  });

  test("rejects missing body, secret, or signature", () => {
    expect(verifyWebhookSignature(null, "header", secret, now)).toBe(false);
    expect(verifyWebhookSignature(Buffer.from("body"), "header", "", now)).toBe(false);
    expect(verifyWebhookSignature(Buffer.from("body"), "", secret, now)).toBe(false);
  });

  test("persists ready playback URLs and tolerates duplicate/out-of-order events", async () => {
    process.env.CLOUDFLARE_STREAM_CUSTOMER_CODE = "customer-code";
    pool.query.mockReset()
      .mockResolvedValueOnce({ rows: [{ media_id: "media-1", post_id: "post-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ post_id: "post-1", visibility: "public", author_id: "user-1" }] });
    const result = await handleStreamWebhook({ uid: "stream-1", readyToStream: true, status: { state: "ready", pctComplete: "100" } });
    expect(result.status).toBe("ready");
    expect(pool.query.mock.calls[0][1][0]).toBe("ready");
    expect(pool.query.mock.calls[0][1][2]).toContain("manifest/video.m3u8");

    pool.query.mockReset().mockResolvedValueOnce({ rows: [{ processing_status: "ready" }] }).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const staleError = await handleStreamWebhook({ uid: "stream-1", readyToStream: false, status: { state: "error", errReasonText: "stale error" } });
    expect(staleError.status).toBe("ready");
    expect(pool.query.mock.calls[1][1][0]).toBe("ready");
  });
});
