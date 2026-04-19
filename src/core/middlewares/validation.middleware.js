const validate = (schema) => (req, res, next) => {
  try {
    const parsed = schema.parse({
      body: req.body,
      query: req.query,
      params: req.params,
    });

    // ✅ apply transformed values (important for .transform())
    req.body = parsed.body;
    req.query = parsed.query;
    req.params = parsed.params;

    next();
  } catch (err) {
    if (err.name === "ZodError") {
      return res.status(400).json({
        success: false,
        errors: err.issues.map((e) => ({
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