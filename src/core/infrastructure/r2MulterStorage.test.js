/* global jest */
const { describe, expect, test } = require('@jest/globals');
const fs = require('fs');
const { Readable } = require('stream');
let mockUploaded;
jest.mock('./r2.client', () => ({
  uploadFileToR2: jest.fn(async ({ key, filePath }) => {
    mockUploaded = { key, filePath, bytes: await require('fs').promises.readFile(filePath) };
    return `https://cdn.example/${key}`;
  }),
  deleteObjectsFromR2: jest.fn(),
}));
const createR2Storage = require('./r2MulterStorage');
const { uploadFileToR2 } = require('./r2.client');

describe('multipart R2 storage', () => {
  test('spools a multipart stream outside the heap and cleans the temporary file', async () => {
    uploadFileToR2.mockClear();
    const payload = Buffer.alloc(6 * 1024 * 1024, 42);
    const storage = createR2Storage({ folder: 'avatars', filename: () => 'photo.jpg' });
    const result = await new Promise((resolve, reject) => storage._handleFile({}, {
      fieldname: 'avatar', originalname: 'photo.jpg', mimetype: 'image/jpeg',
      stream: Readable.from([payload.subarray(0, 1024), payload.subarray(1024)]),
    }, (error, file) => error ? reject(error) : resolve(file)));
    expect(result.size).toBe(payload.length);
    expect(mockUploaded.key).toBe('avatars/photo.jpg');
    expect(mockUploaded.bytes.equals(payload)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fs.existsSync(mockUploaded.filePath)).toBe(false);
  });

  test('cleans the temporary file when R2 rejects the upload', async () => {
    uploadFileToR2.mockImplementationOnce(async ({ filePath }) => {
      mockUploaded = { filePath };
      throw new Error('R2 unavailable');
    });
    const storage = createR2Storage({ folder: 'resumes', filename: () => 'resume.pdf' });
    await expect(new Promise((resolve, reject) => storage._handleFile({}, {
      fieldname: 'resume', originalname: 'resume.pdf', mimetype: 'application/pdf',
      stream: Readable.from([Buffer.from('sample')]),
    }, (error, file) => error ? reject(error) : resolve(file)))).rejects.toThrow('R2 unavailable');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fs.existsSync(mockUploaded.filePath)).toBe(false);
  });

  test('does not publish an interrupted multipart stream', async () => {
    uploadFileToR2.mockClear();
    const storage = createR2Storage({ folder: 'avatars', filename: () => 'photo.jpg' });
    const interrupted = new Readable({ read() { this.destroy(new Error('connection interrupted')); } });
    await expect(new Promise((resolve, reject) => storage._handleFile({}, {
      fieldname: 'avatar', originalname: 'photo.jpg', mimetype: 'image/jpeg', stream: interrupted,
    }, (error, file) => error ? reject(error) : resolve(file)))).rejects.toThrow('connection interrupted');
    expect(uploadFileToR2).not.toHaveBeenCalled();
  });
});
