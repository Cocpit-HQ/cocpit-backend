const { z } = require("zod");

const createTypeSchema = z.object({
  body: z.object({
    type: z.enum(["COMPANY", "INSTITUTION"], {
      required_error: "Type is required",
      invalid_type_error: "Type must be either COMPANY or INSTITUTION",
    }),
  }).strict(),
});

const saveIdentitySchema = z.object({
  body: z.object({
    name: z.string({ required_error: "Name is required" }).trim().min(2, "Name must be at least 2 characters").max(255),
    established_year: z
      .union([z.number(), z.string()])
      .optional()
      .transform((val) => {
        if (!val) return null;
        const parsed = parseInt(val, 10);
        return isNaN(parsed) ? null : parsed;
      }),
    industry: z.string().trim().optional(),
    institution_type: z.string().trim().optional(),
    campus_location: z.string().trim().optional(),
  }).superRefine((data, ctx) => {
    // Note: Since identity schema might not know the entity_type dynamically unless passed in body,
    // we can either require both sets of conditional fields optionally or validate them conditionally
    // if entity_type is present in body, OR we let the controller handle entity-type-specific checks.
    // However, to keep it robust:
    if (data.institution_type || data.campus_location) {
      if (!data.campus_location || data.campus_location.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Campus location is required for educational institutions",
          path: ["campus_location"],
        });
      }
    }
  }),
});

const savePresenceSchema = z.object({
  body: z.object({
    email: z.string({ required_error: "Email is required" }).trim().email("Invalid email format"),
    phone: z.string({ required_error: "Phone number is required" }).trim().min(5, "Invalid phone number"),
    website: z.string().trim().optional().nullable(),
    size: z.string({ required_error: "Size is required" }).trim(),
    country: z.string({ required_error: "Country is required" }).trim(),
    city: z.string({ required_error: "City is required" }).trim(),
    headline: z.string({ required_error: "Headline is required" }).trim().max(200, "Headline must not exceed 200 characters"),
    description: z.string().trim().optional().nullable(),
  }),
});

const verifyEmailSendSchema = z.object({
  body: z.object({
    email: z.string({ required_error: "Email is required" }).trim().email("Invalid email format"),
  }),
});

const verifyEmailConfirmSchema = z.object({
  body: z.object({
    email: z.string({ required_error: "Email is required" }).trim().email("Invalid email format"),
    otp: z.string({ required_error: "OTP code is required" }).trim().min(6).max(10),
  }),
});

const verifyPhoneSendSchema = z.object({
  body: z.object({
    phone: z.string({ required_error: "Phone is required" }).trim().min(5),
  }),
});

const verifyPhoneConfirmSchema = z.object({
  body: z.object({
    phone: z.string({ required_error: "Phone is required" }).trim().min(5),
    otp: z.string({ required_error: "OTP code is required" }).trim().min(6).max(10),
  }),
});

const saveVerificationSchema = z.object({
  body: z.object({
    country_of_operation: z.string().trim().optional(),
  }),
});

module.exports = {
  createTypeSchema,
  saveIdentitySchema,
  savePresenceSchema,
  verifyEmailSendSchema,
  verifyEmailConfirmSchema,
  verifyPhoneSendSchema,
  verifyPhoneConfirmSchema,
  saveVerificationSchema,
};
