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
      public_id: (req, file) => `avatar-${req.user.id}-${Date.now()}`,
    },
  });

  resumeStorage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: "resumes",
      resource_type: "raw", // IMPORTANT for PDF/DOC
      public_id: (req, file) => `resume-${req.user.id}-${Date.now()}`,
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
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Only JPEG/PNG/WebP allowed"));
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

module.exports.uploadEventBanner = uploadEventBanner;