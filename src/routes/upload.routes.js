const express = require("express");
const { upload, uploadStory } = require("../middlewares/upload");
const cloudinary = require("../config/cloudinary"); // Needed for thumbnail URL generation
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

    // Cloudinary returns the eager transformations in the response, but often we just need the basics first
    // If local storage, req.file.path is the file path
    const isCloudinary = !!req.file.filename; // Cloudinary exposes filename as public_id usually in storage engine

    res.json({
      url: req.file.path,
      public_id: req.file.filename || req.file.originalname,
      media_type: 'video',
      // Generate secure thumbnail URL if Cloudinary, else standard path
      thumbnail_url: isCloudinary && cloudinary.url ?
        cloudinary.url(req.file.filename, { resource_type: 'video', format: 'jpg', transformation: [{ width: 720, aspectRatio: "9:16", crop: "fill" }] }) :
        req.file.path
    });
  }
);

module.exports = router;
