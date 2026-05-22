const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("../infrastructure/cloudinary.client");

// --- Profile Avatar Upload ---
const fs = require('fs');
const path = require('path');

// Ensure uploads directories exist
const createDir = (dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const uploadsDir = 'uploads';
createDir(path.join(uploadsDir, 'avatars'));
createDir(path.join(uploadsDir, 'posts'));
createDir(path.join(uploadsDir, 'resumes'));
createDir(path.join(uploadsDir, 'events'));

let storage;
let avatarStorage;
let resumeStorage;

const hasCloudinary = process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET;

if (hasCloudinary) {
  storage = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => {
      console.log("[UploadMiddleware] Processing file:", file.originalname, file.mimetype);
      const isVideo = file.mimetype.startsWith("video");
      return {
        folder: "posts",
        resource_type: isVideo ? "video" : "image",
        public_id: `${Date.now()}-${file.originalname}`,
      };
    },
  });

  avatarStorage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: "avatars",
      resource_type: "image", // only images
      public_id: (req, file) => `avatar-${req.user.sub}-${Date.now()}`,
    },
  });

  resumeStorage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: "resumes",
      resource_type: "raw", // IMPORTANT for PDF/DOC
      // Append extension for raw files so they have correct type when downloaded/viewed
      public_id: (req, file) => `resume-${req.user.sub}-${Date.now()}${path.extname(file.originalname)}`,
    },
  });
} else {
  // Local Storage Fallback
  storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, 'uploads/posts/');
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      const ext = path.extname(file.originalname);
      cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
  });

  avatarStorage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, 'uploads/avatars/');
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      const ext = path.extname(file.originalname);
      cb(null, 'avatar-' + uniqueSuffix + ext);
    }
  });

  resumeStorage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, 'uploads/resumes/');
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      const ext = path.extname(file.originalname);
      cb(null, 'resume-' + uniqueSuffix + ext);
    }
  });
}

const upload = multer({ storage });

const uploadResume = multer({
  storage: resumeStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",

    ];

    const allowed_img = [
      "image/png",
      "image/jpeg",
      "image/jpg",
    ];
    if (!allowed.includes(file.mimetype) && !allowed_img.includes(file.mimetype)) {
      return cb(new Error("Only PDF/DOC/DOCX or images allowed"));
    }

    cb(null, true);
  },
});

const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB limit
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic",
      "image/heif",];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error(" not supported file format"));
    }
    cb(null, true);
  },
});

// Event Banner Upload
const eventBannerStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "events",       // store event banners separately
    resource_type: "image", // only images for banner
    public_id: (req, file) => `banner-${Date.now()}-${file.originalname}`
  }
});

const uploadEventBanner = multer({ storage: eventBannerStorage, limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB limit

// --- Story Upload Optimization ---
let storyStorage;
if (hasCloudinary) {
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
            { streaming_profile: "hd", format: "m3u8" }, // HLS Playlist
            { width: 720, aspectRatio: "9:16", crop: "fill", format: "jpg" } // Thumbnail
          ],
          eager_async: true,
        };
      } else {
        return {
          folder: "stories",
          resource_type: "image",
          // allowed_formats: ["jpg", "png", "jpeg", "webp"], // Optional restriction
          transformation: [{ width: 1080, height: 1920, crop: "fit" }] // Standardize story size?
        };
      }
    },
  });
} else {
  // Fallback for local dev without Cloudinary
  storyStorage = multer.diskStorage({
    destination: (req, file, cb) => {
      createDir(path.join(uploadsDir, 'stories'));
      cb(null, 'uploads/stories/');
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      const ext = path.extname(file.originalname);
      cb(null, 'story-' + uniqueSuffix + ext);
    }
  });
}

const uploadStory = multer({ storage: storyStorage });

// --- Cover Photo Upload ---
let coverStorage;

if (hasCloudinary) {
  coverStorage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: "covers",
      resource_type: "image",
      public_id: (req, file) => `cover-${req.user.sub}-${Date.now()}`,
    },
  });
} else {
  coverStorage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, 'uploads/covers/');
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      const ext = path.extname(file.originalname);
      cb(null, 'cover-' + uniqueSuffix + ext);
    }
  });
}
// Ensure directory exists for local
if (!hasCloudinary) {
  createDir(path.join(uploadsDir, 'covers'));
}


const uploadCover = multer({
  storage: coverStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit (larger than avatar)
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif"];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Format not supported"));
    }
    cb(null, true);
  },
});

// --- Audio Upload (Voice Pitch) ---
let audioStorage;
if (hasCloudinary) {
  audioStorage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: "audio_pitches",
      resource_type: "video", // Cloudinary treats audio as video resource type usually for streaming
      public_id: (req, file) => `pitch-${req.user.sub}-${Date.now()}`,
    },
  });
} else {
  audioStorage = multer.diskStorage({
    destination: (req, file, cb) => {
      createDir(path.join(uploadsDir, 'audio'));
      cb(null, 'uploads/audio/');
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      const ext = path.extname(file.originalname);
      cb(null, 'pitch-' + uniqueSuffix + ext);
    }
  });
  if (!hasCloudinary) createDir(path.join(uploadsDir, 'audio'));
}

const uploadApplicationFiles = multer({
  storage: hasCloudinary ? new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => {
      if (file.fieldname === 'resume') {
        return {
          folder: "resumes",
          resource_type: "raw",
          public_id: `resume-${req.user.sub}-${Date.now()}${path.extname(file.originalname)}`
        };

      }
    }
  }) : multer.diskStorage({
    destination: (req, file, cb) => {
      if (file.fieldname === 'resume') {
        cb(null, 'uploads/resumes/');

      }
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      const ext = path.extname(file.originalname);
      cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB total buffer safety
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'resume') {
      const allowed = [
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "image/png", "image/jpeg", "image/jpg"
      ];
      if (!allowed.includes(file.mimetype)) return cb(new Error("Invalid resume format"));

    }
    cb(null, true);
  }
}).single('resume');

const uploadTaskSubmission = multer({
  storage: hasCloudinary ? new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => {
      // Use video resource type for audio/video submissions for better streaming/transcoding support
      return {
        folder: "task_submissions",
        resource_type: "video",
        public_id: `task-${req.user.sub}-${Date.now()}`
      };
    }
  }) : multer.diskStorage({
    destination: (req, file, cb) => {
      createDir(path.join(uploadsDir, 'tasks'));
      cb(null, 'uploads/tasks/');
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      const ext = path.extname(file.originalname) || '.webm';
      cb(null, 'task-' + uniqueSuffix + ext);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit as per frontend check
  fileFilter: (req, file, cb) => {
    const allowed = [
      "audio/webm", "audio/mp4", "audio/mpeg", "audio/wav", "audio/ogg",
      "video/webm", "video/mp4", "video/quicktime"
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Invalid file format. Please upload video or audio."));
    }
    cb(null, true);
  }
}).single('file'); // Matches frontend field name

// --- Chat Media Upload (Images, Video, PDF) ---
const chatMediaStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    let resource_type = "image"; // Default
    let folder = "chat_images";

    if (file.mimetype.startsWith("video/")) {
      resource_type = "video";
      folder = "chat_videos";
    } else if (file.mimetype === "application/pdf") {
      resource_type = "raw"; // Cloudinary handles PDFs as 'raw' or 'image' (for thumbnail). 'raw' is safer for delivery.
      // ACTUALLY: Cloudinary can treat PDF as image for preview. 
      // But for reliable file storage/download, 'raw' or 'auto' is best.
      // Let's use 'auto' to let Cloudinary decide, OR specific.
      // For PDF viewing, often 'image' resource type is used to generate thumbnails.
      // Let's stick to 'auto' for flexibility if possible, but multer-storage-cloudinary needs specific.
      resource_type = "raw";
      folder = "chat_documents";
    }

    return {
      folder: folder,
      resource_type: resource_type,
      public_id: `chat-${req.user.sub}-${Date.now()}-${file.originalname}`,
      // format: file.mimetype === "application/pdf" ? "pdf" : undefined 
    };
  }
});

const uploadChatMedia = multer({
  storage: chatMediaStorage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg", "image/png", "image/webp", "image/jpg",
      "video/mp4", "video/webm", "video/quicktime",
      "application/pdf"
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Invalid file format. Allowed: JPEG, PNG, WEBP, MP4, WebM, PDF."));
    }
    cb(null, true);
  }
});

const uploadPostMedia = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit for video/large files
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif",
      "video/mp4", "video/mov", "video/avi", "video/mkv", "video/webm", "video/quicktime"
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Invalid file format. Allowed: JPEG, JPG, PNG, WEBP, GIF, MP4, MOV, AVI, MKV, WEBM, Quicktime."));
    }
    cb(null, true);
  }
}).array("media", 10);

module.exports = {
  upload,
  uploadResume,
  uploadAvatar,
  uploadEventBanner,
  uploadStory,
  uploadCover,
  uploadApplicationFiles,
  uploadTaskSubmission,
  uploadChatMedia,
  uploadPostMedia
};