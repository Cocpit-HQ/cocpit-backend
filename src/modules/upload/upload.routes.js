const express = require("express");
const { upload, uploadStory } = require("../../core/middlewares/upload.middleware");
const cloudinary = require("../../core/infrastructure/cloudinary.client"); // Needed for thumbnail URL generation
const router = express.Router();

router.post(
  "/upload",
  upload.array("files", 5),
  (req, res) => {
    const urls = req.files.map(file => {
      // ... existing map logic ...
      return {
        url: file.path,
        media_type: file.resource_type
      }
    });

    res.json({ urls });
  }
);

router.post(
  "/upload/story",
  uploadStory.single("file"),
  (req, res) => {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    try {
      // Cloudinary returns the eager transformations in the response, but often we just need the basics first
      // If local storage, req.file.path is the file path
      const isCloudinary = !!req.file.filename; // Cloudinary exposes filename as public_id usually in storage engine
      console.log("Upload Story File:", req.file);

      let thumbnailUrl = req.file.path;
      if (isCloudinary && cloudinary.url) {
        try {
          thumbnailUrl = cloudinary.url(req.file.filename, { resource_type: 'video', format: 'jpg', transformation: [{ width: 720, aspectRatio: "9:16", crop: "fill" }] });
        } catch (e) {
          console.error("Error generating thumbnail URL:", e);
          // Fallback to path (which is likely the video URL, potentially raw)
        }
      }

      const mediaType = req.file.mimetype.startsWith('video') ? 'video' : 'image';

      res.json({
        url: req.file.path,
        public_id: req.file.filename || req.file.originalname,
        media_type: mediaType,
        thumbnail_url: thumbnailUrl
      });
    } catch (err) {
      console.error("Story Upload Handler Error:", err);
      res.status(500).json({ message: "Internal server error during story processing", error: err.message });
    }
  }
);

module.exports = router;
