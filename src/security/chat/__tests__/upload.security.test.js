const fs = require('fs');
const path = require('path');
const os = require('os');
const { validateUploadedMediaSignatures } = require('../../../core/middlewares/upload.middleware');

describe('VULN-07: Upload Security & Magic Byte Signature Validation', () => {
  let tempDir;
  let req, res, next;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-upload-test-'));
  });

  afterAll(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {
      // ignore cleanup failure
    }
  });

  beforeEach(() => {
    req = { files: [] };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
  });

  test('passes when no files uploaded', () => {
    validateUploadedMediaSignatures(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('accepts legitimate JPEG file with valid magic bytes', () => {
    const filePath = path.join(tempDir, 'sample.jpg');
    // FF D8 FF E0
    fs.writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]));

    req.files = [
      {
        path: filePath,
        mimetype: 'image/jpeg',
        originalname: 'sample.jpg',
      },
    ];

    validateUploadedMediaSignatures(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('accepts legitimate PNG file with valid magic bytes', () => {
    const filePath = path.join(tempDir, 'sample.png');
    // 89 50 4E 47 0D 0A 1A 0A
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));

    req.files = [
      {
        path: filePath,
        mimetype: 'image/png',
        originalname: 'sample.png',
      },
    ];

    validateUploadedMediaSignatures(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('accepts legitimate PDF file with %PDF magic bytes', () => {
    const filePath = path.join(tempDir, 'document.pdf');
    // 25 50 44 46
    fs.writeFileSync(filePath, Buffer.from('%PDF-1.4 test content'));

    req.files = [
      {
        path: filePath,
        mimetype: 'application/pdf',
        originalname: 'document.pdf',
      },
    ];

    validateUploadedMediaSignatures(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('blocks spoofed executable/script disguised as an image (mime mismatch)', () => {
    const fakePngPath = path.join(tempDir, 'malware.png');
    // DOS MZ header: 4D 5A
    fs.writeFileSync(fakePngPath, Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]));

    req.files = [
      {
        path: fakePngPath,
        mimetype: 'image/png',
        originalname: 'malware.png',
      },
    ];

    validateUploadedMediaSignatures(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/does not match|signature mismatch/i),
      })
    );
    expect(next).not.toHaveBeenCalled();
    // File should be deleted on disk
    expect(fs.existsSync(fakePngPath)).toBe(false);
  });

  test('blocks HTML / SVG with embedded scripts', () => {
    const fakeImgPath = path.join(tempDir, 'xss.png');
    fs.writeFileSync(fakeImgPath, Buffer.from('<svg onload=alert(1)>'));

    req.files = [
      {
        path: fakeImgPath,
        mimetype: 'image/png',
        originalname: 'xss.png',
      },
    ];

    validateUploadedMediaSignatures(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
    expect(fs.existsSync(fakeImgPath)).toBe(false);
  });
});
