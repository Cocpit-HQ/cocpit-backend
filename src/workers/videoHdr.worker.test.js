const { describe, expect, jest: jestObject, test } = require("@jest/globals");
jestObject.mock("../queues/media.queue", () => ({ getRedisConnectionOptions: () => ({}) }));
jestObject.mock("../core/db/pool", () => ({ query: jestObject.fn() }));
jestObject.mock("../core/db/redis", () => ({ isOpen: false, get: jestObject.fn(), set: jestObject.fn() }));
const { createMasterPlaylist, parseHdrMetadata, sdrToneMapFilter } = require("./videoHdr.worker");

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

  test('parses static mastering and content light metadata without claiming dynamic preservation', () => {
    const metadata = parseHdrMetadata({ streams: [{ side_data_list: [{
      side_data_type: 'Mastering display metadata',
      green_x: '13250/50000', green_y: '34500/50000',
      blue_x: '7500/50000', blue_y: '3000/50000',
      red_x: '34000/50000', red_y: '16000/50000',
      white_point_x: '15635/50000', white_point_y: '16450/50000',
      max_luminance: '10000000/10000', min_luminance: '1/10000',
    }] }], frames: [{ side_data_list: [
      { side_data_type: 'Content light level metadata', max_content: 1000, max_average: 400 },
      { side_data_type: 'DOVI configuration record', dv_profile: 5 },
    ] }] });
    expect(metadata.masterDisplay).toBe('G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)');
    expect(metadata.maxCll).toBe('1000,400');
    expect(metadata.dynamicMetadataTypes).toEqual(['DOVI configuration record']);
    expect(metadata.dolbyVisionProfile).toBe(5);
    expect(sdrToneMapFilter(metadata)).toContain('npl=1000');
  });
});
