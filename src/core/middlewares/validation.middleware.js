const validate = (schema) => (req, res, next) => {
  try {
    const parsed = schema.parse({
      body: req.body,
      query: req.query,
      params: req.params,
    });

    // ✅ apply transformed values (important for .transform())
    if (parsed.body !== undefined) req.body = parsed.body;
    if (parsed.query !== undefined) req.query = parsed.query;
    if (parsed.params !== undefined) req.params = parsed.params;

    next();
  } catch (err) {
    // Clean up uploaded files if validation fails
    if (req.files && Array.isArray(req.files)) {
      const fs = require('fs');
      req.files.forEach((file) => {
        try {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        } catch (unlinkErr) {
          console.error("[ValidationMiddleware] Temp file cleanup error:", unlinkErr);
        }
      });
    }
    if (req.file) {
      const fs = require('fs');
      try {
        if (fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
      } catch (unlinkErr) {
        console.error("[ValidationMiddleware] Temp file cleanup error:", unlinkErr);
      }
    }

    if (err.name === "ZodError") {
      const firstMessage = err.issues[0]?.message || "Validation failed";
      return res.status(400).json({
        success: false,
        message: firstMessage,
        errors: err.issues.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        })),
      });
    }

    return res.status(500).json({
      success: false,
      message: "Validation failed",
    });
  }
};

module.exports = { validate };