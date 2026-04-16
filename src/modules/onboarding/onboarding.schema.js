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

const saveRoleSchema = z.object({
  body: z.object({
    role: z.enum(["student2", "working", "freelancer", "open_to_work"], {
      required_error: "Role is required",
      invalid_type_error: "Invalid role value",
    }),
  }),
});

const saveDetailsSchema = z.object({
  body: z.object({
    education: z.array(z.any()).optional(),
    company: z.string().optional(),
    workRole: z.string().optional(),
  }),
});

const saveInterestsSchema = z.object({
  body: z.object({
    interests: z.array(z.string(), {
      required_error: "Interests are required",
    }),
  }),
});

const saveSkillsSchema = z.object({
  body: z.object({
    skills: z.array(z.string(), {
      required_error: "Skills are required",
    }),
  }),
});

const completeOnboardingSchema = z.object({
  body: z.object({
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
