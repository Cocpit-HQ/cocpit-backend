const { z } = require("zod");

const workModes = ["Remote", "Hybrid", "Onsite"];

const createDraftSchema = z.object({
  body: z.object({
    title: z.string({
      required_error: "Title is required to create a draft",
    }).min(1, "Title cannot be empty"),
    org_id: z.string().uuid("Invalid Organization ID").optional(),
  }),
});

const updateDraftSchema = z.object({
  body: z.object({
    title: z.string().min(1, "Title cannot be empty").optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    salary_min: z.number().int("Salary minimum must be an integer").nonnegative("Salary minimum cannot be negative").optional(),
    salary_max: z.number().int("Salary maximum must be an integer").nonnegative("Salary maximum cannot be negative").optional(),
    experience_min: z.number().int("Experience minimum must be an integer").nonnegative("Experience minimum cannot be negative").optional(),
    experience_max: z.number().int("Experience maximum must be an integer").nonnegative("Experience maximum cannot be negative").optional(),
    experience_label: z.string().optional(),
    work_mode: z.enum(workModes).optional(),
    job_type: z.string().optional(),
    industry: z.string().optional(),
    about_company: z.string().optional(),
  }),
});

// Used during POST /jobs/:id/submit
const submitJobSchema = z.object({
  body: z.object({
    title: z.string({ required_error: "Title is required" }).min(5, "Title must be at least 5 characters"),
    description: z.string({ required_error: "Description is required" }).min(100, "Description must be at least 100 characters"),
    location: z.string({ required_error: "Location is required" }).min(1, "Location cannot be empty"),
    industry: z.string({ required_error: "Industry is required" }).min(1, "Industry cannot be empty"),
    salary_min: z.number({ required_error: "Minimum salary is required" }).int().nonnegative(),
    salary_max: z.number({ required_error: "Maximum salary is required" }).int().nonnegative(),
    experience_min: z.number({ required_error: "Minimum experience is required" }).int().nonnegative(),
    experience_max: z.number({ required_error: "Maximum experience is required" }).int().nonnegative(),
    work_mode: z.enum(workModes, { required_error: "Work mode is required" }),
    job_type: z.string({ required_error: "Job type is required" }).min(1, "Job type cannot be empty"),
  })
  // Refine for cross-field business validation
  .refine((data) => data.salary_max >= data.salary_min, {
    message: "Maximum salary must be greater than or equal to minimum salary",
    path: ["salary_max"],
  })
  .refine((data) => data.experience_max >= data.experience_min, {
    message: "Maximum experience must be greater than or equal to minimum experience",
    path: ["experience_max"],
  }),
});

module.exports = {
  createDraftSchema,
  updateDraftSchema,
  submitJobSchema,
};
