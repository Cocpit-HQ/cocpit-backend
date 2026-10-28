/* global jest */
const { describe, beforeEach, test, expect } = require("@jest/globals");
const { verifyDirectPostUploads } = require("./postUploadTickets");

const owner = "fe6f90e1-8569-4906-95a8-3ab84d0c8001";
const base = "https://media.example.test";
const ticket = (name = "photo.heic", size = 1024, mediaType = "image") => {
  const rawKey = `raw/posts/${owner}-123-id-${name}`;
  return {
    rawKey,
    master_url: `${base}/${rawKey}`,
    filename: name,
    contentType: mediaType === "video" ? "video/mp4" : "image/heic",
    size,
    media_type: mediaType,
  };
};

describe("direct post upload tickets", () => {
  beforeEach(() => { process.env.R2_PUBLIC_URL = base; });

  test("accepts a verified image and legacy owner path", async () => {
    const first = ticket();
    const legacy = ticket("other.heic");
    legacy.rawKey = `raw/posts/${owner}/other.heic`;
    legacy.master_url = `${base}/${legacy.rawKey}`;
    const head = jest.fn(async () => ({ ContentLength: 1024 }));
    await expect(verifyDirectPostUploads([first, legacy], owner, head)).resolves.toBeUndefined();
    expect(head).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["foreign owner", (item) => { item.rawKey = "raw/posts/another-user-photo.heic"; item.master_url = `${base}/${item.rawKey}`; }],
    ["mismatched key", (item) => { item.rawKey += "-different"; }],
    ["missing ticket", (item) => { delete item.rawKey; }],
    ["wrong media type", (item) => { item.media_type = "video"; }],
    ["misreported image MIME", (item) => { item.contentType = "image/png"; }],
    ["oversized image", (item) => { item.size = 10 * 1024 * 1024 + 1; }],
  ])("rejects %s", async (_label, change) => {
    const item = ticket();
    change(item);
    await expect(verifyDirectPostUploads([item], owner, async () => ({ ContentLength: item.size }))).rejects.toThrow();
  });

  test("rejects a missing or mismatched R2 object", async () => {
    await expect(verifyDirectPostUploads([ticket()], owner, async () => null)).rejects.toThrow(/missing or its size/);
    await expect(verifyDirectPostUploads([ticket()], owner, async () => ({ ContentLength: 1023 }))).rejects.toThrow(/missing or its size/);
  });

  test("rejects mixed image/video and multiple videos", async () => {
    const video = ticket("clip.mp4", 2048, "video");
    await expect(verifyDirectPostUploads([ticket(), video], owner, async () => ({ ContentLength: 2048 }))).rejects.toThrow(/one video/);
    await expect(verifyDirectPostUploads([video, ticket("second.mp4", 2048, "video")], owner, async () => ({ ContentLength: 2048 }))).rejects.toThrow(/one video/);
  });
});
