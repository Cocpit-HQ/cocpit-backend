const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("../config/cloudinary");

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

    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Only PDF/DOC/DOCX allowed"));
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

module.exports = {
  upload,
  uploadResume,
  uploadAvatar,
};

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

module.exports = {
  upload,
  uploadResume,
  uploadAvatar,
  uploadEventBanner,
  uploadStory,
  uploadCover
};