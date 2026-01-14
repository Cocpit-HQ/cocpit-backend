const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("../config/cloudinary");

const storage = new CloudinaryStorage({
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

const upload = multer({ storage });


// --- Resume Upload ---
const resumeStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "resumes",
    resource_type: "raw", // IMPORTANT for PDF/DOC
    public_id: (req, file) => `resume-${req.user.id}-${Date.now()}`,
  },
});

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

// --- Profile Avatar Upload ---
let avatarStorage;
if (process.env.CLOUDINARY_CLOUD_NAME) {
  avatarStorage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: "avatars",
      resource_type: "image", // only images
      public_id: (req, file) => `avatar-${req.user.id}-${Date.now()}`,
    },
  });
} else {
  // Fallback for dev/test without Cloudinary
  avatarStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, '/tmp'),
    filename: (req, file, cb) => cb(null, `avatar-${Date.now()}.png`), // Simple mock
  });
}

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