/* global jest */
const { describe, expect, test, beforeEach } = require('@jest/globals');
const sharp = require('sharp');

let mockSourceBuffer;
const mockUploads = [];
jest.mock('../core/infrastructure/r2.client', () => ({
  downloadFromR2AsBuffer: jest.fn(async () => mockSourceBuffer),
  uploadBufferToR2: jest.fn(async ({ key, body, contentType }) => {
    mockUploads.push({ key, body, contentType });
    return `https://cdn.example/${key}`;
  }),
  getPublicUrl: jest.fn((key) => `https://cdn.example/${key}`),
}));
jest.mock('../queues/media.queue', () => ({ redisConnection: {}, mediaTranscodeQueue: {}, addTranscodeJob: jest.fn() }));
jest.mock('../queues/videoHdr.queue', () => ({ addVideoHdrJob: jest.fn() }));
jest.mock('../core/db/pool', () => ({ query: jest.fn() }));
jest.mock('../core/db/redis', () => ({ isOpen: false }));
jest.mock('../core/infrastructure/cloudflareStream.client', () => ({ isStreamConfigured: jest.fn(() => false) }));

const { processDualAsset } = require('./mediaTranscoder.worker');

describe('responsive feed image processing', () => {
  beforeEach(() => { mockUploads.length = 0; });

  test('keeps the master and writes compatible and AVIF widths without enlarging', async () => {
    mockSourceBuffer = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#bb4466' } })
      .jpeg().toBuffer();
    const original = Buffer.from(mockSourceBuffer);
    const result = await processDualAsset({ rawKey: 'raw/posts/a-photo.jpg', rawMasterUrl: 'https://cdn.example/raw/posts/a-photo.jpg' });
    expect(mockSourceBuffer.equals(original)).toBe(true);
    expect(result.url).toBe('https://cdn.example/display/posts/a-photo.jpg');
    expect(result.variants.fallback.map((item) => item.width)).toEqual([480, 960, 1440]);
    expect(result.variants.avif.map((item) => item.width)).toEqual([480, 960, 1440]);
    expect(result.avifUrl).toMatch(/-w1440\.avif$/);
    expect(mockUploads.filter((item) => item.contentType === 'image/avif')).toHaveLength(3);
    for (const item of mockUploads) {
      const meta = await sharp(item.body).metadata();
      expect(meta.width).toBeLessThanOrEqual(1600);
      expect(meta.icc).toBeDefined();
    }
  });

  test('keeps transparency and avoids upscaling a small PNG', async () => {
    mockSourceBuffer = await sharp({ create: { width: 300, height: 200, channels: 4, background: { r: 8, g: 80, b: 120, alpha: 0.4 } } })
      .png().toBuffer();
    const result = await processDualAsset({ rawKey: 'raw/posts/a-photo.png', rawMasterUrl: 'https://cdn.example/raw/posts/a-photo.png' });
    expect(result.format).toBe('png');
    expect(result.variants.fallback).toEqual([{ width: 300, url: result.url }]);
    expect(result.variants.avif).toHaveLength(1);
    const fallback = mockUploads.find((item) => item.key === 'display/posts/a-photo.png');
    expect((await sharp(fallback.body).metadata()).hasAlpha).toBe(true);
  });

  test('retains a source Display P3 ICC profile in compatible and AVIF copies', async () => {
    mockSourceBuffer = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#a66b55' } })
      .withIccProfile('p3').jpeg().toBuffer();
    const sourceIcc = (await sharp(mockSourceBuffer).metadata()).icc;
    await processDualAsset({ rawKey: 'raw/posts/p3.jpg', rawMasterUrl: 'https://cdn.example/raw/posts/p3.jpg' });
    for (const item of mockUploads) {
      expect((await sharp(item.body).metadata()).icc.equals(sourceIcc)).toBe(true);
    }
  });

  test('rejects invalid image bytes without publishing a display object', async () => {
    mockSourceBuffer = Buffer.from('not an image');
    await expect(processDualAsset({ rawKey: 'raw/posts/bad.jpg', rawMasterUrl: 'https://cdn.example/raw/posts/bad.jpg' }))
      .rejects.toThrow('Unsupported or invalid image content');
    expect(mockUploads).toHaveLength(0);
  });
});
