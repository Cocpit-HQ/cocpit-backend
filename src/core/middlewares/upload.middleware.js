const multer = require("multer");
const multerS3 = require("multer-s3");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("../infrastructure/cloudinary.client");
const { r2Client, hasR2, bucketName, publicUrl } = require("../infrastructure/r2.client");
const fs = require("fs");
const path = require("path");

// Ensure local uploads directories exist as fallback
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
createDir(path.join(uploadsDir, "project_media"));
createDir(path.join(uploadsDir, "support"));
createDir(path.join(uploadsDir, "verifications"));

const hasCloudinary =
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET;

/**
 * Wraps S3 storage engine so that info.location, info.path, and info.secure_url
 * all point to the public Cloudflare R2 CDN URL. This guarantees 100% backward
 * compatibility with all existing controllers expecting req.file.path or secure_url.
 */
function wrapS3Storage(baseStorage, publicBaseUrl) {
  return {
    _handleFile: function (req, file, cb) {
      baseStorage._handleFile(req, file, function (err, info) {
        if (err) return cb(err);
        if (info && info.key && publicBaseUrl) {
          const finalUrl = `${publicBaseUrl}/${info.key}`;
          info.location = finalUrl;
          info.path = finalUrl;
          info.secure_url = finalUrl;
        }
        cb(null, info);
      });
    },
    _removeFile: function (req, file, cb) {
      baseStorage._removeFile(req, file, cb);
    },
  };
}

function getR2FolderPrefix(req) {
  const env = req?.currentEnvironment || req?.headers?.["x-environment"] || process.env.R2_FOLDER_PREFIX || "uat";
  return env.toLowerCase().trim();
}

/**
 * Creates an S3 storage engine for a given folder and key generator
 */
function createR2StorageEngine(folderName, keyFn) {
  const s3Engine = multerS3({
    s3: r2Client,
    bucket: bucketName,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: (req, file, cb) => {
      const prefix = getR2FolderPrefix(req);
      if (keyFn) {
        return keyFn(req, file, (err, subKey) => {
          if (err) return cb(err);
          const finalKey = (subKey && subKey.startsWith(`${prefix}/`)) ? subKey : `${prefix}/${subKey}`;
          cb(null, finalKey);
        });
      }
      const cleanName = file.originalname.replace(/[^a-zA-Z0-9.]/g, "_");
      cb(null, `${prefix}/${folderName}/${Date.now()}-${cleanName}`);
    },
  });

  return wrapS3Storage(s3Engine, publicUrl);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Post Media Storage (Images & Videos)
// ─────────────────────────────────────────────────────────────────────────────
let storage;
if (hasR2) {
  storage = createR2StorageEngine("posts", (req, file, cb) => {
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9.]/g, "_");
    cb(null, `posts/${Date.now()}-${cleanName}`);
  });
} else if (hasCloudinary) {
  storage = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => {
      const isVideo = file.mimetype.startsWith("video");
      return {
        folder: "posts",
        resource_type: isVideo ? "video" : "image",
        public_id: `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.]/g, "_")}`,
      };
    },
  });
} else {
  storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "uploads/posts/"),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname));
    },
  });
}

const upload = multer({ storage });

const uploadPostMedia = multer({
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit for video/large files
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif",
      "video/mp4", "video/mov", "video/quicktime",
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Invalid file format. Allowed: JPEG, JPG, PNG, WEBP, HEIC, MP4, MOV."));
    }
    cb(null, true);
  },
}).fields([{ name: "media", maxCount: 20 }, { name: "cover_media", maxCount: 1 }]);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Avatar Storage (Users, Orgs, Groups)
// ─────────────────────────────────────────────────────────────────────────────
let avatarStorage;
if (hasR2) {
  avatarStorage = createR2StorageEngine("avatars", (req, file, cb) => {
    const sub = req.user?.sub || req.user?.user_id || "usr";
    const ext = path.extname(file.originalname) || ".png";
    cb(null, `avatars/avatar-${sub}-${Date.now()}${ext}`);
  });
} else if (hasCloudinary) {
  avatarStorage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: "avatars",
      resource_type: "image",
      public_id: (req, file) => `avatar-${req.user?.sub || "usr"}-${Date.now()}`,
    },
  });
} else {
  avatarStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "uploads/avatars/"),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, "avatar-" + uniqueSuffix + path.extname(file.originalname));
    },
  });
}

const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif",
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("not supported file format"));
    }
    cb(null, true);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Resume Storage
// ─────────────────────────────────────────────────────────────────────────────
let resumeStorage;
if (hasR2) {
  resumeStorage = createR2StorageEngine("resumes", (req, file, cb) => {
    const sub = req.user?.sub || "usr";
    const ext = path.extname(file.originalname) || ".pdf";
    cb(null, `resumes/resume-${sub}-${Date.now()}${ext}`);
  });
} else if (hasCloudinary) {
  resumeStorage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: "resumes",
      resource_type: "raw",
      public_id: (req, file) =>
        `resume-${req.user?.sub || "usr"}-${Date.now()}${path.extname(file.originalname)}`,
    },
  });
} else {
  resumeStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "uploads/resumes/"),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, "resume-" + uniqueSuffix + path.extname(file.originalname));
    },
  });
}

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

// ─────────────────────────────────────────────────────────────────────────────
// 4. Event & Community Banners
// ─────────────────────────────────────────────────────────────────────────────
let eventBannerStorage;
if (hasR2) {
  eventBannerStorage = createR2StorageEngine("events", (req, file, cb) => {
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9.]/g, "_");
    cb(null, `events/banner-${Date.now()}-${cleanName}`);
  });
} else if (hasCloudinary) {
  eventBannerStorage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: "events",
      resource_type: "image",
      public_id: (req, file) =>
        `banner-${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.]/g, "_")}`,
    },
  });
} else {
  eventBannerStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "uploads/events/"),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, "event-" + uniqueSuffix + path.extname(file.originalname));
    },
  });
}

const uploadEventBanner = multer({
  storage: eventBannerStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

let communityBannerStorage;
if (hasR2) {
  communityBannerStorage = createR2StorageEngine("communities", (req, file, cb) => {
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9.]/g, "_");
    cb(null, `communities/banner-${Date.now()}-${cleanName}`);
  });
} else if (hasCloudinary) {
  communityBannerStorage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: "communities",
      resource_type: "image",
      public_id: (req, file) =>
        `banner-${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.]/g, "_")}`,
    },
  });
} else {
  communityBannerStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "uploads/communities/"),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, "community-" + uniqueSuffix + path.extname(file.originalname));
    },
  });
}

const uploadCommunityBanner = multer({
  storage: communityBannerStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Showcase Stories
// ─────────────────────────────────────────────────────────────────────────────
let storyStorage;
if (hasR2) {
  storyStorage = createR2StorageEngine("stories", (req, file, cb) => {
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9.]/g, "_");
    cb(null, `stories/story-${Date.now()}-${cleanName}`);
  });
} else if (hasCloudinary) {
  storyStorage = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => {
      const isVideo = file.mimetype.startsWith("video");
      if (isVideo) {
        return {
          folder: "stories",
          resource_type: "video",
          allowed_formats: ["mp4", "mov", "webm"],
          eager: [
            { streaming_profile: "hd", format: "m3u8" },
            { width: 720, aspectRatio: "9:16", crop: "fill", format: "jpg" },
          ],
          eager_async: true,
        };
      } else {
        return {
          folder: "stories",
          resource_type: "image",
          transformation: [{ width: 1080, height: 1920, crop: "fit" }],
        };
      }
    },
  });
} else {
  storyStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "uploads/stories/"),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, "story-" + uniqueSuffix + path.extname(file.originalname));
    },
  });
}

const uploadStory = multer({ storage: storyStorage });

// ─────────────────────────────────────────────────────────────────────────────
// 6. Cover Photos (User Profiles, Org Profiles, Folders)
// ─────────────────────────────────────────────────────────────────────────────
let coverStorage;
if (hasR2) {
  coverStorage = createR2StorageEngine("covers", (req, file, cb) => {
    const sub = req.user?.sub || "usr";
    const ext = path.extname(file.originalname) || ".png";
    cb(null, `covers/cover-${sub}-${Date.now()}${ext}`);
  });
} else if (hasCloudinary) {
  coverStorage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: "covers",
      resource_type: "image",
      public_id: (req, file) => `cover-${req.user?.sub || "usr"}-${Date.now()}`,
    },
  });
} else {
  coverStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "uploads/covers/"),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, "cover-" + uniqueSuffix + path.extname(file.originalname));
    },
  });
}

const uploadCover = multer({
  storage: coverStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif",
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Format not supported"));
    }
    cb(null, true);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Audio Pitches & Job Applications
// ─────────────────────────────────────────────────────────────────────────────
let audioStorage;
if (hasR2) {
  audioStorage = createR2StorageEngine("audio_pitches", (req, file, cb) => {
    const sub = req.user?.sub || "usr";
    const ext = path.extname(file.originalname) || ".webm";
    cb(null, `audio_pitches/pitch-${sub}-${Date.now()}${ext}`);
  });
} else if (hasCloudinary) {
  audioStorage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: "audio_pitches",
      resource_type: "video",
      public_id: (req, file) => `pitch-${req.user?.sub || "usr"}-${Date.now()}`,
    },
  });
} else {
  audioStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "uploads/audio/"),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, "pitch-" + uniqueSuffix + path.extname(file.originalname));
    },
  });
}

let applicationFileStorage;
if (hasR2) {
  applicationFileStorage = createR2StorageEngine("resumes", (req, file, cb) => {
    const sub = req.user?.sub || "usr";
    const ext = path.extname(file.originalname) || ".pdf";
    cb(null, `resumes/resume-${sub}-${Date.now()}${ext}`);
  });
} else if (hasCloudinary) {
  applicationFileStorage = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => {
      if (file.fieldname === "resume") {
        return {
          folder: "resumes",
          resource_type: "raw",
          public_id: `resume-${req.user?.sub || "usr"}-${Date.now()}${path.extname(file.originalname)}`,
        };
      }
    },
  });
} else {
  applicationFileStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "uploads/resumes/"),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname));
    },
  });
}

const uploadApplicationFiles = multer({
  storage: applicationFileStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "resume") {
      const allowed = [
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "image/png", "image/jpeg", "image/jpg",
      ];
      if (!allowed.includes(file.mimetype)) return cb(new Error("Invalid resume format"));
    }
    cb(null, true);
  },
}).single("resume");

// ─────────────────────────────────────────────────────────────────────────────
// 8. Task Submissions
// ─────────────────────────────────────────────────────────────────────────────
let taskSubmissionStorage;
if (hasR2) {
  taskSubmissionStorage = createR2StorageEngine("task_submissions", (req, file, cb) => {
    const sub = req.user?.sub || "usr";
    const ext = path.extname(file.originalname) || ".webm";
    cb(null, `task_submissions/task-${sub}-${Date.now()}${ext}`);
  });
} else if (hasCloudinary) {
  taskSubmissionStorage = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => ({
      folder: "task_submissions",
      resource_type: "video",
      public_id: `task-${req.user?.sub || "usr"}-${Date.now()}`,
    }),
  });
} else {
  taskSubmissionStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "uploads/tasks/"),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, "task-" + uniqueSuffix + (path.extname(file.originalname) || ".webm"));
    },
  });
}

const uploadTaskSubmission = multer({
  storage: taskSubmissionStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "audio/webm", "audio/mp4", "audio/mpeg", "audio/wav", "audio/ogg",
      "video/webm", "video/mp4", "video/quicktime",
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Invalid file format. Please upload video or audio."));
    }
    cb(null, true);
  },
}).single("file");

// ─────────────────────────────────────────────────────────────────────────────
// 9. Chat Media (Images, Videos, Documents)
// ─────────────────────────────────────────────────────────────────────────────
let chatMediaStorage;
if (hasR2) {
  chatMediaStorage = createR2StorageEngine("chat", (req, file, cb) => {
    let folder = "chat_images";
    if (file.mimetype.startsWith("video/")) {
      folder = "chat_videos";
    } else if (
      file.mimetype === "application/pdf" ||
      file.mimetype === "application/msword" ||
      file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      folder = "chat_documents";
    }
    const sub = req.user?.sub || "usr";
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9.]/g, "_");
    cb(null, `${folder}/chat-${sub}-${Date.now()}-${cleanName}`);
  });
} else if (hasCloudinary) {
  chatMediaStorage = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => {
      let resource_type = "image";
      let folder = "chat_images";

      if (file.mimetype.startsWith("video/")) {
        resource_type = "video";
        folder = "chat_videos";
      } else if (
        file.mimetype === "application/pdf" ||
        file.mimetype === "application/msword" ||
        file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ) {
        resource_type = "raw";
        folder = "chat_documents";
      }

      return {
        folder: folder,
        resource_type: resource_type,
        public_id: `chat-${req.user?.sub || "usr"}-${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.]/g, "_")}`,
      };
    },
  });
} else {
  chatMediaStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "uploads/posts/"),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, "chat-" + uniqueSuffix + path.extname(file.originalname));
    },
  });
}

const uploadChatMedia = multer({
  storage: chatMediaStorage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg", "image/png", "image/webp", "image/jpg",
      "video/mp4", "video/webm", "video/quicktime",
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Invalid file format. Allowed: JPEG, PNG, WEBP, MP4, WebM, PDF, DOC, DOCX."));
    }
    cb(null, true);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Project Media
// ─────────────────────────────────────────────────────────────────────────────
let projectMediaStorage;
if (hasR2) {
  projectMediaStorage = createR2StorageEngine("project_media", (req, file, cb) => {
    const sub = req.user?.sub || "usr";
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9.]/g, "_");
    cb(null, `project_media/proj-${sub}-${Date.now()}-${cleanName}`);
  });
} else if (hasCloudinary) {
  projectMediaStorage = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => {
      const isDoc = file.mimetype.startsWith("application/") || file.mimetype === "text/plain";
      const cleanName = file.originalname.replace(/[^a-zA-Z0-9.]/g, "_");
      return {
        folder: "project_media",
        resource_type: isDoc ? "raw" : "image",
        public_id: `proj-${req.user?.sub || "usr"}-${Date.now()}-${cleanName}`,
      };
    },
  });
} else {
  projectMediaStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "uploads/project_media/"),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, "proj-" + uniqueSuffix + path.extname(file.originalname));
    },
  });
}

const uploadProjectMedia = multer({
  storage: projectMediaStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg", "image/png", "image/webp", "image/jpg",
      "application/pdf", "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "text/plain",
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Invalid format. Allowed: Images, PDF, DOC, DOCX, PPT, PPTX, TXT."));
    }
    cb(null, true);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Support Ticket Attachments
// ─────────────────────────────────────────────────────────────────────────────
let supportStorage;
if (hasR2) {
  supportStorage = createR2StorageEngine("support", (req, file, cb) => {
    const sub = req.user?.sub || "user";
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9.]/g, "_");
    cb(null, `support/ticket-${sub}-${Date.now()}-${cleanName}`);
  });
} else if (hasCloudinary) {
  supportStorage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: "support",
      resource_type: "image",
      public_id: (req, file) => `ticket-${req.user?.sub || "user"}-${Date.now()}`,
    },
  });
} else {
  supportStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "uploads/support/"),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, "ticket-" + uniqueSuffix + path.extname(file.originalname));
    },
  });
}

const uploadSupportAttachment = multer({
  storage: supportStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp", "application/pdf"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed.includes(file.mimetype) && ext !== ".pdf") {
      const err = new Error("Invalid format. Allowed formats: JPG, PNG, WEBP, PDF.");
      err.statusCode = 400;
      return cb(err);
    }
    cb(null, true);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Organization Verification Documents
// ─────────────────────────────────────────────────────────────────────────────
let verificationDocumentStorage;
if (hasR2) {
  verificationDocumentStorage = createR2StorageEngine("verifications", (req, file, cb) => {
    const sub = req.user?.sub || "org";
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9.]/g, "_");
    cb(null, `verifications/verify-${sub}-${Date.now()}-${cleanName}`);
  });
} else if (hasCloudinary) {
  verificationDocumentStorage = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => {
      const isDoc =
        file.mimetype === "application/pdf" ||
        file.mimetype.startsWith("application/") ||
        file.mimetype === "text/plain";
      const cleanName = file.originalname.replace(/[^a-zA-Z0-9.]/g, "_");
      return {
        folder: "verifications",
        resource_type: isDoc ? "raw" : "image",
        public_id: `verify-${req.user?.sub || "org"}-${Date.now()}-${cleanName}`,
      };
    },
  });
} else {
  verificationDocumentStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "uploads/verifications/"),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, "verify-" + uniqueSuffix + path.extname(file.originalname));
    },
  });
}

const uploadVerificationDocument = multer({
  storage: verificationDocumentStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      "image/jpeg", "image/png", "image/webp", "image/jpg",
      "application/pdf", "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    const allowedExts = [".pdf", ".png", ".jpg", ".jpeg", ".webp", ".doc", ".docx"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowedMimes.includes(file.mimetype) && !allowedExts.includes(ext)) {
      const err = new Error("Invalid document format. Allowed: PDF, PNG, JPG, JPEG, WEBP, DOC, DOCX.");
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
