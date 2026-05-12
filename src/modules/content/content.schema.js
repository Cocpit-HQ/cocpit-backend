const { z } = require("zod");

const commentOperationSchema = z.object({
  params: z.object({
    commentId: z.string().uuid({ message: "Valid Comment ID is required" }),
  }),
});

const hideCommentSchema = z.object({
  params: z.object({
    commentId: z.string().uuid({ message: "Valid Comment ID is required" }),
  }),
  body: z.object({
    companyId: z.string().uuid().optional(),
  }).optional(),
});

module.exports = {
  commentOperationSchema,
  hideCommentSchema,
};
