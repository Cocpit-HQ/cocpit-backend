const { describe, beforeEach, afterAll, it, expect } = require("@jest/globals");
const { ownedPostRawKey } = require("./postMediaKey");

describe("ownedPostRawKey", () => {
  const previousPublicUrl = process.env.R2_PUBLIC_URL;
  const previousCdnUrl = process.env.R2_CDN_BASE_URL;

  beforeEach(() => {
    process.env.R2_PUBLIC_URL = "https://media.example.test";
    delete process.env.R2_CDN_BASE_URL;
  });

  afterAll(() => {
    if (previousPublicUrl === undefined) delete process.env.R2_PUBLIC_URL;
    else process.env.R2_PUBLIC_URL = previousPublicUrl;
    if (previousCdnUrl === undefined) delete process.env.R2_CDN_BASE_URL;
    else process.env.R2_CDN_BASE_URL = previousCdnUrl;
  });

  it("accepts a flat post key owned by the uploader", () => {
    expect(ownedPostRawKey("https://media.example.test/raw/posts/user-123-file.jpg", "user"))
      .toBe("raw/posts/user-123-file.jpg");
  });

  it("keeps legacy nested post keys readable", () => {
    expect(ownedPostRawKey("https://media.example.test/raw/posts/user/file.jpg", "user"))
      .toBe("raw/posts/user/file.jpg");
  });

  it.each([
    "https://evil.example.test/raw/posts/user-123-file.jpg",
    "https://media.example.test/raw/posts/other-123-file.jpg",
    "https://media.example.test/raw/posts/user2/file.jpg",
    "https://media.example.test/display/posts/user-123-file.jpg",
  ])("rejects a foreign or non-original URL: %s", (url) => {
    expect(ownedPostRawKey(url, "user")).toBeNull();
  });
});
