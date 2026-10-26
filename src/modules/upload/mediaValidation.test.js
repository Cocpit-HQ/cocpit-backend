const {
  MAX_IMAGE_BYTES,
  validateImageBuffer,
  validateUploadBatch,
  detectImageMime,
} = require("./mediaValidation");

describe("feed media validation", () => {
  test.each([
    ["photo.jpg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0x00])],
    ["photo.png", "image/png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
    ["photo.webp", "image/webp", Buffer.from("RIFF0000WEBP")],
    ["photo.avif", "image/avif", Buffer.from("0000ftypavif")],
    ["photo.heic", "image/heic", Buffer.from("0000ftypheic")],
    ["photo.heif", "image/heif", Buffer.from("0000ftypmif1")],
  ])("detects supported image signatures for %s", (name, mime, bytes) => {
    expect(detectImageMime(bytes)).toBe(mime === "image/heif" ? "image/heic" : mime);
    expect(() => validateImageBuffer(bytes, name, mime)).not.toThrow();
  });

  test("rejects mismatched extensions, MIME declarations, and invalid bytes", () => {
    expect(() => validateImageBuffer(Buffer.from("not an image"), "photo.jpg", "image/jpeg")).toThrow(/invalid image content/i);
    expect(() => validateImageBuffer(Buffer.from([0xff, 0xd8, 0xff]), "photo.png", "image/jpeg")).toThrow(/extension/i);
    expect(() => validateImageBuffer(Buffer.from([0xff, 0xd8, 0xff]), "photo.jpg", "image/png")).toThrow(/content/i);
  });

  test("enforces per-image and aggregate image limits while accepting empty HEIC MIME", () => {
    expect(() => validateUploadBatch([{ name: "large.jpg", type: "image/jpeg", size: MAX_IMAGE_BYTES + 1 }])).toThrow(/10 MB/i);
    expect(() => validateUploadBatch(Array.from({ length: 11 }, (_, index) => ({
      name: `photo-${index}.jpg`, type: "image/jpeg", size: MAX_IMAGE_BYTES,
    })))).toThrow(/100 MB total/i);
    expect(() => validateUploadBatch([{ name: "iphone.heic", type: "", size: 1000 }])).not.toThrow();
  });

  test("rejects unsupported extensions and incompatible declared video types", () => {
    expect(() => validateUploadBatch([{ name: "animation.gif", type: "image/gif", size: 1000 }])).toThrow(/unsupported/i);
    expect(() => validateUploadBatch([{ name: "clip.mov", type: "image/jpeg", size: 1000 }])).toThrow(/declared media type/i);
  });
});
