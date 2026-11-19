const { z } = require("zod");

const sendGroupMessageSchema = z.object({
  body: z.object({
    content: z.string().max(8000, "Message cannot exceed 8,000 characters").optional().nullable(),
  }).passthrough(),
});

const sendDirectMessageSchema = z.object({
  body: z.object({
    text_content: z.string().max(8000, "Message cannot exceed 8,000 characters").optional().nullable(),
    content: z.string().max(8000, "Message cannot exceed 8,000 characters").optional().nullable(),
  }).passthrough(),
});

const editMessageSchema = z.object({
  body: z.object({
    text_content: z.string({ required_error: "Content is required" })
      .min(1, "Content cannot be empty")
      .max(8000, "Message cannot exceed 8,000 characters"),
  }).passthrough(),
});

module.exports = {
  sendGroupMessageSchema,
  sendDirectMessageSchema,
  editMessageSchema,
};
