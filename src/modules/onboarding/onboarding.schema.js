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
const allowedRoles = ["student", "working", "freelancer", "not_working"];

const saveRoleSchema = z.object({
  body: z.object({
    role: z
      .string({
        required_error: "Role is required",
        invalid_type_error: "Role must be a string",
      })
      .trim()
      .min(1, "Role cannot be empty")
      .transform((val) =>
        val.toLowerCase().replace(/\s+/g, "_") // "Not Working" → "not_working"
      )
      .refine((val) => allowedRoles.includes(val), {
        message:
          "Invalid role. Allowed values: student, working, freelancer, not_working",
      }),
  }).strict(), // 🔒 ensures only one field (role) is allowed
});

const saveDetailsSchema = z.object({
  body: z.object({
    role: z.enum(["student", "working", "freelancer", "not_working"], {
      required_error: "Role is required",
      invalid_type_error: "Role must be one of the allowed roles",
    }),
    school_name: z.string().optional(),
    degree: z.string().optional(),
    title: z.string().optional(),
    company_name: z.string().optional(),
    headline: z.string().optional(),
  }).superRefine((data, ctx) => {
    if (data.role === "student" || data.role === "not_working") {
      if (!data.school_name || data.school_name.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "School name is required",
          path: ["school_name"],
        });
      }
      if (!data.degree || data.degree.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Degree is required",
          path: ["degree"],
        });
      }
    }

    if (data.role === "working") {
      if (!data.title || data.title.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Title is required",
          path: ["title"],
        });
      }
      if (!data.company_name || data.company_name.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Company name is required",
          path: ["company_name"],
        });
      }
    }

    if (data.role === "freelancer") {
      if (!data.headline || data.headline.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Headline is required",
          path: ["headline"],
        });
      }
    }
  }),
});

const saveInterestsSchema = z.object({
  body: z.object({
    interests: z
      .array(
        z.string()
          .trim()                          // removes extra spaces
          .min(1, "Interest cannot be empty") // ❌ prevents "" or "   "
      )
      .min(3, "Please select at least 3 interests"),
  }),
});

const saveSkillsSchema = z.object({
  body: z.object({
    skills: z
      .array(
        z.string().min(1, "Skill cannot be empty") // ❌ prevents ""
      )
      .min(3, "Please select at least 3 skills"), // ✅ minimum 3 skills
  }),
});

const updateProfileSchema = z.object({
  body: z.object({
    account_name: z
      .string({
        required_error: "Account name is required",
        invalid_type_error: "Account name must be a string",
      })
      .trim()
      .min(1, "Account name cannot be empty"),

    full_name: z
      .string({
        required_error: "Full name is required",
        invalid_type_error: "Full name must be a string",
      })
      .trim()
      .min(1, "Full name cannot be empty"),

    avatar_url: z
      .string({
        invalid_type_error: "Avatar URL must be a string",
      })
      .trim()
      .url("Avatar URL must be a valid URL")
      .optional(), // ✅ optional now
  }),
});

const updateLocationSchema = z.object({
  body: z.object({
    location_id: z.string({
      required_error: "Location ID is required",
    }),

    location: z.string({
      required_error: "Location is required",
    }),
  }),
});

module.exports = {
  saveRoleSchema,
  saveDetailsSchema,
  saveInterestsSchema,
  saveSkillsSchema,
  updateProfileSchema,
  updateLocationSchema
};
