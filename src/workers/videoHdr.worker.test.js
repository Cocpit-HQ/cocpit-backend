const { describe, expect, jest: jestObject, test } = require("@jest/globals");
jestObject.mock("../queues/media.queue", () => ({ getRedisConnectionOptions: () => ({}) }));
jestObject.mock("../core/db/pool", () => ({ query: jestObject.fn() }));
jestObject.mock("../core/db/redis", () => ({ isOpen: false, get: jestObject.fn(), set: jestObject.fn() }));
const { createMasterPlaylist } = require("./videoHdr.worker");

describe("HDR HLS playlist generation", () => {
  const variants = [
    { name: "1080p", width: 1920, height: 1080, bitrate: "10M" },
    { name: "720p", width: 1280, height: 720, bitrate: "5M" },
  ];

  test("uses the measured rendition dimensions and PQ range", () => {
    const playlist = createMasterPlaylist(variants, "smpte2084");
    expect(playlist).toContain("RESOLUTION=1920x1080,VIDEO-RANGE=PQ");
    expect(playlist).toContain("RESOLUTION=1280x720,VIDEO-RANGE=PQ");
    expect(playlist).toContain("1080p.m3u8");
  });

  test("marks HLG renditions correctly", () => {
    expect(createMasterPlaylist(variants, "arib-std-b67")).toContain("VIDEO-RANGE=HLG");
  });
});
