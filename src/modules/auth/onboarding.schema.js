const { z } = require("zod");

const accountNameRegex = /^[a-z0-9_]{3,30}$/;

const checkAccountNameSchema = z.object({
  query: z.object({
    account_name: z.string({
      required_error: "Account name is required"
    })
      .min(3, "Account name must be at least 3 characters")
      .max(30, "Account name must be at most 30 characters")
      .regex(accountNameRegex, "Account name can only contain lowercase letters, numbers, and underscores"),
  }),
});

const completeOnboardingSchema = z.object({
  body: z.object({
    account_name: z.string({
      required_error: "Account name is required"
    })
      .min(3, "Account name must be at least 3 characters")
      .max(30, "Account name must be at most 30 characters")
      .regex(accountNameRegex, "Account name can only contain lowercase letters, numbers, and underscores"),
    location_id: z.coerce.number({
      required_error: "Location is required"
    }).int().positive("Please select a valid location"),
  }),
});

module.exports = {
  checkAccountNameSchema,
  completeOnboardingSchema,
};
