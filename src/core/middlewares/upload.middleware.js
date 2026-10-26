const multer = require("multer");
const createR2Storage = require("../infrastructure/r2MulterStorage");
const fs = require("fs");
const path = require("path");

// --- Ensure uploads directories exist for local fallback ---
const createDir = (dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const uploadsDir = "uploads";
createDir(path.join(uploadsDir, "avatars"));
createDir(path.join(uploadsDir, "posts"));
createDir(path.join(uploadsDir, "resumes"));
createDir(path.join(uploadsDir, "events"));
createDir(path.join(uploadsDir, "communities"));
createDir(path.join(uploadsDir, "stories"));
createDir(path.join(uploadsDir, "covers"));
createDir(path.join(uploadsDir, "audio"));
createDir(path.join(uploadsDir, "tasks"));
createDir(path.join(uploadsDir, "chat"));
createDir(path.join(uploadsDir, "project_media"));
createDir(path.join(uploadsDir, "support"));
createDir(path.join(uploadsDir, "verifications"));

const hasR2 = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET_NAME &&
  (process.env.R2_PUBLIC_URL || process.env.R2_CDN_BASE_URL)
);

console.log(`[UploadMiddleware] Storage Engine: ${hasR2 ? "Cloudflare R2 ✅" : "Local Disk (dev fallback) ⚠️"}`);

// Helper to choose R2 storage or local diskStorage
function buildStorage({ folder, getFilename, diskSubdir }) {
  if (hasR2) {
    return createR2Storage({ folder, filename: getFilename });
  }
  return multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(uploadsDir, diskSubdir || folder);
      createDir(dir);
      cb(null, dir + "/");
    },
    filename: (req, file, cb) => {
      if (getFilename) {
        cb(null, getFilename(req, file));
      } else {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname);
        cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
      }
    },
  });
}

// 1. General & Post Storage
const storage = buildStorage({
  folder: "posts",
  diskSubdir: "posts",
  getFilename: (req, file) => `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.]/g, "_")}`,
});

// 2. Avatar Storage
const avatarStorage = buildStorage({
  folder: "avatars",
  diskSubdir: "avatars",
  getFilename: (req, file) => `avatar-${req.user?.sub || "anon"}-${Date.now()}${path.extname(file.originalname)}`,
});

// 3. Resume Storage
const resumeStorage = buildStorage({
  folder: "resumes",
  diskSubdir: "resumes",
  getFilename: (req, file) => `resume-${req.user?.sub || "anon"}-${Date.now()}${path.extname(file.originalname)}`,
});

// 4. Event Banner Storage
const eventBannerStorage = buildStorage({
  folder: "events",
  diskSubdir: "events",
  getFilename: (req, file) => `banner-${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.]/g, "_")}`,
});

// 5. Community Banner Storage
const communityBannerStorage = buildStorage({
  folder: "communities",
  diskSubdir: "communities",
  getFilename: (req, file) => `banner-${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.]/g, "_")}`,
});

// 6. Story Storage
const storyStorage = buildStorage({
  folder: "stories",
  diskSubdir: "stories",
  getFilename: (req, file) => `story-${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.]/g, "_")}`,
});

// 7. Cover Photo Storage
const coverStorage = buildStorage({
  folder: "covers",
  diskSubdir: "covers",
  getFilename: (req, file) => `cover-${req.user?.sub || "anon"}-${Date.now()}${path.extname(file.originalname)}`,
});

// 8. Audio Pitch Storage
// 9. Task Submission Storage
const taskSubmissionStorage = buildStorage({
  folder: "task_submissions",
  diskSubdir: "tasks",
  getFilename: (req, file) => `task-${req.user?.sub || "anon"}-${Date.now()}${path.extname(file.originalname) || ".webm"}`,
});

// 10. Chat Media Storage
const chatMediaStorage = buildStorage({
  folder: "chat_media",
  diskSubdir: "chat",
  getFilename: (req, file) => `chat-${req.user?.sub || "anon"}-${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.]/g, "_")}`,
});

// 11. Project Media Storage
const projectMediaStorage = buildStorage({
  folder: "project_media",
  diskSubdir: "project_media",
  getFilename: (req, file) => `proj-${req.user?.sub || "anon"}-${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.]/g, "_")}`,
});

// 12. Support Ticket Storage
const supportStorage = buildStorage({
  folder: "support",
  diskSubdir: "support",
  getFilename: (req, file) => `ticket-${req.user?.sub || "anon"}-${Date.now()}${path.extname(file.originalname)}`,
});

// 13. Verification Document Storage
const verificationDocumentStorage = buildStorage({
  folder: "verifications",
  diskSubdir: "verifications",
  getFilename: (req, file) => `verify-${req.user?.sub || "org"}-${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.]/g, "_")}`,
});

// ─── Exported Multer Middleware Instances ─────────────────────────────────────

const upload = multer({ storage });

const uploadResume = multer({
  storage: resumeStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Invalid file format. Allowed: PDF, DOC, DOCX."));
    }
    cb(null, true);
  },
});

const uploadResumeMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["application/pdf"];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Invalid file format. Allowed: PDF."));
    }
    cb(null, true);
  },
});

const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Format not supported. Allowed: JPEG, JPG, PNG, WEBP, HEIC, HEIF."));
    }
    cb(null, true);
  },
});

const uploadCover = multer({
  storage: coverStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Format not supported"));
    }
    cb(null, true);
  },
});

const uploadEventBanner = multer({
  storage: eventBannerStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

const uploadCommunityBanner = multer({
  storage: communityBannerStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

const uploadStory = multer({
  storage: storyStorage,
  limits: { fileSize: 100 * 1024 * 1024 },
});

const uploadApplicationFiles = multer({
  storage: resumeStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "resume") {
      const allowed = [
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "image/png",
        "image/jpeg",
        "image/jpg",
      ];
      if (!allowed.includes(file.mimetype)) return cb(new Error("Invalid resume format"));
    }
    cb(null, true);
  },
}).single("resume");

const uploadTaskSubmission = multer({
  storage: taskSubmissionStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "audio/webm",
      "audio/mp4",
      "audio/mpeg",
      "audio/wav",
      "audio/ogg",
      "video/webm",
      "video/mp4",
      "video/quicktime",
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Invalid file format. Please upload video or audio."));
    }
    cb(null, true);
  },
}).single("file");

const uploadChatMedia = multer({
  storage: chatMediaStorage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/jpg",
      "video/mp4",
      "video/webm",
      "video/quicktime",
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(
        new Error(
          "Invalid file format. Allowed: JPEG, PNG, WEBP, MP4, WebM, PDF, DOC, DOCX."
        )
      );
    }
    cb(null, true);
  },
});

const uploadPostMedia = multer({
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
      "video/mp4",
      "video/mov",
      "video/quicktime",
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(
        new Error(
          "Invalid file format. Allowed: JPEG, JPG, PNG, WEBP, HEIC, MP4, MOV."
        )
      );
    }
    cb(null, true);
  },
}).fields([
  { name: "media", maxCount: 20 },
  { name: "cover_media", maxCount: 1 },
]);

const uploadProjectMedia = multer({
  storage: projectMediaStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/jpg",
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "text/plain",
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(
        new Error(
          "Invalid format. Allowed: Images, PDF, DOC, DOCX, PPT, PPTX, TXT."
        )
      );
    }
    cb(null, true);
  },
});

const uploadSupportAttachment = multer({
  storage: supportStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
      "application/pdf",
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed.includes(file.mimetype) && ext !== ".pdf") {
      const err = new Error("Invalid format. Allowed formats: JPG, PNG, WEBP, PDF.");
      err.statusCode = 400;
      return cb(err);
    }
    cb(null, true);
  },
});

const uploadVerificationDocument = multer({
  storage: verificationDocumentStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/jpg",
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    const allowedExts = [".pdf", ".png", ".jpg", ".jpeg", ".webp", ".doc", ".docx"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowedMimes.includes(file.mimetype) && !allowedExts.includes(ext)) {
      const err = new Error(
        "Invalid document format. Allowed: PDF, PNG, JPG, JPEG, WEBP, DOC, DOCX."
      );
      err.statusCode = 400;
      return cb(err);
    }
    cb(null, true);
  },
});

module.exports = {
  upload,
  uploadResume,
  uploadResumeMemory,
  uploadAvatar,
  uploadEventBanner,
  uploadCommunityBanner,
  uploadStory,
  uploadCover,
  uploadApplicationFiles,
  uploadTaskSubmission,
  uploadChatMedia,
  uploadPostMedia,
  uploadProjectMedia,
  uploadSupportAttachment,
  uploadVerificationDocument,
  uploadOrgVerificationDocument: uploadVerificationDocument,
};
