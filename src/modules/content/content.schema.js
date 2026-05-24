const { z } = require("zod");

const commentOperationSchema = z.object({
  params: z.object({
    commentId: z.string().uuid({ message: "Valid Comment ID is required" }),
  }),
});

const updateCommentSchema = z.object({
  params: z.object({
    commentId: z.string().uuid({ message: "Valid Comment ID is required" }),
  }),
  body: z.object({
    content: z.string({ required_error: "Content is required" }),
    companyId: z.string().uuid().optional().nullable(),
  }).passthrough(),
});


const hideCommentSchema = z.object({
  params: z.object({
    commentId: z.string().uuid({ message: "Valid Comment ID is required" }),
  }),
  body: z.object({
    companyId: z.string().uuid().optional(),
  }).optional(),
});

const uuidOrEmpty = z.preprocess((val) => (val === "" ? null : val), z.string().uuid().optional().nullable());

const createPostSchema = z.object({
  body: z.object({
    content: z.string().optional().nullable(),
    category: z.string({
      required_error: "Category is required",
    }),
    visibility: z.string().optional().nullable(),
    post_type: z.string().optional().nullable(),
    title: z.string().optional().nullable(),
    poll_options: z.preprocess((val) => {
      if (typeof val === 'string') {
        try {
          return JSON.parse(val);
        } catch {
          return val;
        }
      }
      return val;
    }, z.array(z.string()).optional()),
    poll_duration: z.string().optional().nullable(),
    is_broadcast: z.preprocess((val) => {
      if (typeof val === 'string') {
        if (val.toLowerCase() === 'true') return true;
        if (val.toLowerCase() === 'false') return false;
      }
      return val;
    }, z.boolean().optional().nullable()),
    location: z.string().optional().nullable(),
    companyId: uuidOrEmpty,
    shared_post_id: uuidOrEmpty,
    shared_job_id: uuidOrEmpty,
    media_urls: z.preprocess((val) => {
      if (typeof val === 'string') {
        try {
          return JSON.parse(val);
        } catch {
          return val;
        }
      }
      return val;
    }, z.array(z.string()).optional()),
  }).passthrough(),
});

module.exports = {
  commentOperationSchema,
  updateCommentSchema,
  hideCommentSchema,
  createPostSchema,
};
