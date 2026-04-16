const { z } = require("zod");

// Defining schema fields based on requirements
// - role (enum: student2, working, freelancer, open_to_work)
// - education (array, optional)
// - company (string, optional)
// - workRole (string, optional)
// - interests (array)
// - skills (array)
// - onboardingStep (enum: ROLE, DETAILS, INTERESTS, SKILLS)
// - isOnboardingComplete (boolean, default false)

const roleEnum = z.enum(["student2", "working", "freelancer", "open_to_work", "Employer", "User"], {
  required_error: "Role is required",
  invalid_type_error: "Invalid role value",
});

const saveRoleSchema = z.object({
  body: z.object({
    role: roleEnum,
  }),
});

const saveDetailsSchema = z.object({
  body: z.object({
    role: roleEnum,
    education: z.array(
      z.object({
        school_name: z.string().optional(),
        degree: z.string().optional(),
        field_of_study: z.string().optional()
      }).passthrough()
    ).optional(),
    company: z.string().optional(),
    workRole: z.string().optional(),
  }).superRefine((data, ctx) => {
    if (data.role === "student2") {
      if (!data.education || data.education.length < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "At least one education entry is required for students",
          path: ["education"],
        });
      }
    }

    if (data.role === "working") {
      if (!data.company || data.company.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Company is required for working professionals",
          path: ["company"],
        });
      }
    }

    if (["working", "freelancer", "open_to_work"].includes(data.role)) {
      if (!data.workRole || data.workRole.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Work role is required",
          path: ["workRole"],
        });
      }
    }
  }),
});

const saveInterestsSchema = z.object({
  body: z.object({
    interests: z.array(z.string(), {
      required_error: "Interests are required",
    }).min(3, "Please select at least 3 interests"),
  }),
});

const saveSkillsSchema = z.object({
  body: z.object({
    skills: z.array(z.string(), {
      required_error: "Skills are required",
    }).min(3, "Please select at least 3 skills"),
  }),
});

const completeOnboardingSchema = z.object({
  body: z.object({
    // Add additional validation here if needed for completion payload
    onboardingStep: z.enum(["ROLE", "DETAILS", "INTERESTS", "SKILLS"]).optional(),
    isOnboardingComplete: z.boolean().default(false).optional(),
  }),
});

module.exports = {
  saveRoleSchema,
  saveDetailsSchema,
  saveInterestsSchema,
  saveSkillsSchema,
  completeOnboardingSchema,
};
