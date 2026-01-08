const express = require("express");
const upload = require("../middlewares/upload");
const router = express.Router();

router.post(
  "/upload",
  upload.array("files", 5),
  (req, res) => {
    const urls = req.files.map(file => ({
      url: file.path,
      media_type: file.resource_type,
    }));

    res.json({ urls });
  }
);

module.exports = router;
