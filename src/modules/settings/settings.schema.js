const { z } = require("zod");

// Password change schema (matching onboarding rules in auth.schema.js)
const changePasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string({
      required_error: "Current password is required",
    }),
    newPassword: z.string({
      required_error: "New password is required",
    })
      .min(8, { message: "Password must be at least 8 characters long" })
      .max(15, { message: "Password must be at most 15 characters long" })
      .regex(/[a-z]/, { message: "Password must contain at least 1 lowercase letter (a-z)" })
      .regex(/[A-Z]/, { message: "Password must contain at least 1 uppercase letter (A-Z)" })
      .regex(/[@#$%\^&*!?:;_=\-+(){}[\]|\\/.,~`"'<>]/, { message: "Password must contain at least 1 special character" }),
    confirmPassword: z.string({
      required_error: "Confirm password is required",
    }),
  }).refine((data) => data.newPassword === data.confirmPassword, {
    message: "New password and confirm password do not match",
    path: ["confirmPassword"],
  }),
});

// Verify current email OTP
const verifyCurrentEmailSchema = z.object({
  body: z.object({
    otp: z.string({
      required_error: "OTP is required",
    }).length(6, { message: "OTP must be exactly 6 digits" }),
  }),
});

// Submit new email
const submitNewEmailSchema = z.object({
  body: z.object({
    newEmail: z.string({
      required_error: "New email is required",
    }).email({ message: "Invalid email address" }),
  }),
});

// Confirm new email OTP
const confirmNewEmailSchema = z.object({
  body: z.object({
    otp: z.string({
      required_error: "OTP is required",
    }).length(6, { message: "OTP must be exactly 6 digits" }),
  }),
});

// Recovery email schemas
const setRecoveryEmailSchema = z.object({
  body: z.object({
    recoveryEmail: z.string({
      required_error: "Recovery email is required",
    }).email({ message: "Invalid email address" }),
  }),
});

const confirmRecoveryEmailSchema = z.object({
  body: z.object({
    otp: z.string({
      required_error: "OTP is required",
    }).length(6, { message: "OTP must be exactly 6 digits" }),
  }),
});

// Phone schemas
const phoneSchema = z.object({
  body: z.object({
    phone: z.string({
      required_error: "Phone number is required",
    }).min(10, { message: "Phone number must be at least 10 digits" }),
  }),
});

const confirmPhoneSchema = z.object({
  body: z.object({
    otp: z.string({
      required_error: "OTP is required",
    }).length(6, { message: "OTP must be exactly 6 digits" }),
  }),
});

// Preferences schemas
const appearanceSchema = z.object({
  body: z.object({
    theme: z.enum(["system", "light", "dark"], {
      required_error: "Theme must be system, light, or dark",
    }),
  }),
});

const notificationPreferencesSchema = z.object({
  body: z.object({
    all_notifications: z.boolean().optional(),
    post_notifications: z.boolean().optional(),
    job_alerts: z.boolean().optional(),
    message_notifications: z.boolean().optional(),
    messages_chat_enabled: z.boolean().optional(),
    messages_jobs_enabled: z.boolean().optional(),
    email_notifications: z.boolean().optional(),
  }),
});

const privacySchema = z.object({
  body: z.object({
    show_email: z.boolean().optional(),
    showEmail: z.boolean().optional(),
    show_phone: z.boolean().optional(),
    showPhone: z.boolean().optional(),
    tag_permission: z.enum(["everyone", "connections_only", "followers_only", "no_one"]).optional(),
    tagPermission: z.enum(["everyone", "connections_only", "followers_only", "no_one"]).optional(),
    following_visibility: z.enum(["everyone", "followers_only", "no_one"]).optional(),
    followingVisibility: z.enum(["everyone", "followers_only", "no_one"]).optional(),
    followers_visibility: z.enum(["everyone", "followers_only", "no_one"]).optional(),
    followersVisibility: z.enum(["everyone", "followers_only", "no_one"]).optional(),
    message_permission: z.enum(["everyone", "followers_only", "no_one"]).optional(),
    messagePermission: z.enum(["everyone", "followers_only", "no_one"]).optional(),
  }).passthrough(),
});

// Account deletion initiation schema
const initiateDeletionSchema = z.object({
  body: z.object({
    companyResolutions: z.array(
      z.object({
        orgId: z.string().uuid({ message: "Invalid orgId format" }),
        action: z.enum(["delete", "transfer"], { message: "Action must be delete or transfer" }),
        newOwnerId: z.string().uuid().optional(),
      })
    ).optional().default([]),
  }),
});

// Support ticket & feedback schemas
const supportTicketSchema = z.object({
  body: z.object({
    email: z.string({ required_error: "Email is required" }).email({ message: "Invalid email" }),
    description: z.string({ required_error: "Description is required" }).min(10, { message: "Description must be at least 10 characters" }),
  }),
});

const userFeedbackSchema = z.object({
  body: z.object({
    rating: z.number().int().min(1).max(5, { message: "Rating must be between 1 and 5" }),
    comment: z.string().optional(),
    app_version: z.string({ required_error: "App version is required" }),
  }),
});

module.exports = {
  changePasswordSchema,
  verifyCurrentEmailSchema,
  submitNewEmailSchema,
  confirmNewEmailSchema,
  setRecoveryEmailSchema,
  confirmRecoveryEmailSchema,
  phoneSchema,
  confirmPhoneSchema,
  appearanceSchema,
  notificationPreferencesSchema,
  privacySchema,
  initiateDeletionSchema,
  supportTicketSchema,
  userFeedbackSchema,
};
