const { uploadBufferToR2, deleteObjectsFromR2 } = require("./r2.client");
const path = require("path");

/**
 * Custom Multer Storage Engine for Cloudflare R2
 * Streams incoming multipart files directly to R2 and attaches public CDN URLs
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
    const chunks = [];
    file.stream.on("data", (chunk) => chunks.push(chunk));
    file.stream.on("end", async () => {
      try {
        const buffer = Buffer.concat(chunks);
        const filename = typeof this.getFilename === "function" 
          ? this.getFilename(req, file) 
          : `${Date.now()}-${file.originalname}`;
        const safeFilename = String(filename).split("/").map((part) => part.replace(/[^a-zA-Z0-9._-]/g, "_")).join("/");
        const key = `${this.folder}/${safeFilename}`;
        
        const publicUrl = await uploadBufferToR2({
          key,
          body: buffer,
          contentType: file.mimetype,
        });

        cb(null, {
          path: publicUrl,
          secure_url: publicUrl,
          url: publicUrl,
          key,
          filename,
          size: buffer.length,
          mimetype: file.mimetype,
          originalname: file.originalname,
        });
      } catch (err) {
        console.error(`[R2StorageEngine] Error uploading ${file.originalname} to R2:`, err);
        cb(err);
      }
    });

    file.stream.on("error", (err) => cb(err));
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
