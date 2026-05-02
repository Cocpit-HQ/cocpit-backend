const { z } = require("zod");

const syncTagsSchema = z.object({
  body: z.object({
    postId: z.string().uuid({ message: "Valid Post ID is required" }),
    tags: z
      .array(z.string().uuid({ message: "Valid Tagged User ID required" }))
      .optional()
      .default([]),
  }),
});

module.exports = { syncTagsSchema };
