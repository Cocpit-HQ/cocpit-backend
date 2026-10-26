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

// R2 uploads return media records, not bare URLs. Keep accepting legacy URL
// strings while validating the fields the post controller persists.
const postMediaSchema = z.union([
  z.string().min(1),
  z.object({
    url: z.string().min(1),
    master_url: z.string().min(1).optional(),
    masterUrl: z.string().min(1).optional(),
    media_type: z.enum(["image", "video"]).optional(),
    processing_status: z.enum(["processing", "ready", "failed"]).optional(),
    fallback_url: z.string().min(1).nullable().optional(),
    avif_url: z.string().min(1).nullable().optional(),
    width: z.number().nonnegative().nullable().optional(),
    height: z.number().nonnegative().nullable().optional(),
    format: z.string().min(1).optional(),
    bit_depth: z.number().positive().optional(),
    is_processed: z.boolean().optional(),
    jobId: z.string().optional(),
  }).passthrough(),
]);

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
    }, z.array(postMediaSchema).optional()),
  }).passthrough(),
});

module.exports = {
  commentOperationSchema,
  updateCommentSchema,
  hideCommentSchema,
  createPostSchema,
};
