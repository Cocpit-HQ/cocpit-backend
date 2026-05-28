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
const allowedRoles = ["student", "fresher", "intern", "self_employed", "employed", "unemployed"];

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
      ),
  }).strict(), // 🔒 ensures only one field (role) is allowed
});

const saveDetailsSchema = z.object({
  body: z.object({
    role: z.enum(["student", "fresher", "intern", "self_employed", "employed", "unemployed"], {
      required_error: "Role is required",
      invalid_type_error: "Role must be one of the allowed roles",
    }),
    school_name: z.string().min(3, "School name must be at least 3 characters").trim().optional(),
    school_org_id: z.string().uuid("Invalid organization ID").nullable().optional(),
    degree: z.string().optional(),
    field_of_study: z.string().nullable().optional(),
    title: z.string().optional(),
    company_name: z.string().optional(),
  }).superRefine((data, ctx) => {
    if (["student", "fresher", "intern"].includes(data.role)) {
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

    if (["self_employed", "employed"].includes(data.role)) {
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
  }),
});

const saveInterestsSchema = z.object({
  body: z.object({
    interests: z
      .array(
        z.string()
          .trim()                          // removes extra spaces
          .min(1, "Interest cannot be empty") // ❌ prevents "" or "   "
          .max(50, "Interest cannot exceed 50 characters")

      )
      .min(3, "Please select at least 3 interests")
      .max(7, "Please select up to 7 interests"),
  }),
});

const saveSkillsSchema = z.object({
  body: z.object({
    skills: z
      .array(
        z.string().min(1, "Skill cannot be empty") // ❌ prevents ""
      )
      .min(3, "Please select at least 3 skills")
      .max(7, "Please select up to 7 skills"),
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
  }),
});

const updateLocationSchema = z.object({
  body: z.object({
    country: z.string().min(1).refine(
      v => ["India", "United Arab Emirates", "Singapore"].includes(v),
      { message: "Location must be in India, UAE, or Singapore" }
    ).optional(),
    state: z.string().nullable().optional(),
    city: z.string().min(1).optional(),
    formattedAddress: z.string().min(1).optional(),
    latitude: z.number().nullable().optional(),
    longitude: z.number().nullable().optional(),
    placeId: z.string().min(1, "Place ID is required"),
    location: z.string().optional()
  })
});

module.exports = {
  saveRoleSchema,
  saveDetailsSchema,
  saveInterestsSchema,
  saveSkillsSchema,
  updateProfileSchema,
  updateLocationSchema
};
