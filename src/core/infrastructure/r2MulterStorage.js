const { uploadFileToR2, deleteObjectsFromR2 } = require("./r2.client");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { pipeline } = require("stream/promises");

/**
 * Custom Multer Storage Engine for Cloudflare R2
 * Spools incoming multipart files to bounded disk space, then streams them to R2.
 * This keeps large uploads out of the Node.js heap and attaches public CDN URLs
 * to req.file.path, req.file.secure_url, and req.file.url for 100% backward compatibility
 * with all existing controllers (profile, avatars, covers, resumes, stories, events, etc.).
 */
class R2StorageEngine {
  constructor(opts = {}) {
    this.folder = opts.folder || "uploads";
    this.getFilename = opts.filename || ((req, file) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      const ext = path.extname(file.originalname);
      return `${file.fieldname}-${uniqueSuffix}${ext}`;
    });
  }

  _handleFile(req, file, cb) {
    void (async () => {
      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cocpit-upload-"));
      const tempPath = path.join(tempDir, "upload");
      try {
        await pipeline(file.stream, fs.createWriteStream(tempPath));
        const { size } = await fs.promises.stat(tempPath);
        const filename = typeof this.getFilename === "function" 
          ? this.getFilename(req, file) 
          : `${Date.now()}-${file.originalname}`;
        const safeFilename = String(filename).split("/").map((part) => part.replace(/[^a-zA-Z0-9._-]/g, "_")).join("/");
        const key = `${this.folder}/${safeFilename}`;
        
        const publicUrl = await uploadFileToR2({
          key,
          filePath: tempPath,
          contentType: file.mimetype,
        });

        cb(null, {
          path: publicUrl,
          secure_url: publicUrl,
          url: publicUrl,
          key,
          filename,
          size,
          mimetype: file.mimetype,
          originalname: file.originalname,
        });
      } catch (err) {
        console.error(`[R2StorageEngine] Error uploading ${file.originalname} to R2:`, err);
        cb(err);
      } finally {
        await fs.promises.unlink(tempPath).catch(() => {});
        await fs.promises.rmdir(tempDir).catch(() => {});
      }
    })().catch(cb);
  }

  async _removeFile(req, file, cb) {
    try {
      if (file.key) {
        await deleteObjectsFromR2([file.key]);
      }
      cb(null);
    } catch (err) {
      cb(err);
    }
  }
}

module.exports = function createR2Storage(opts) {
  return new R2StorageEngine(opts);
};
