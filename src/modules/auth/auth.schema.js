const { z } = require("zod");

const registerSchema = z.object({
  body: z.object({
    email: z.string({
      required_error: "Email is required",
    }).email({
      message: "Invalid email address",
    }),
    password: z.string({
      required_error: "Password is required",
    }).min(6, {
      message: "Password must be at least 6 characters long",
    }),
    fullName: z.string({
      required_error: "Full name is required",
    }),
    accountType: z.enum(
      ["Fresher", "Employee", "Student", "Freelancer", "Employer", "Admin"],
      {
        required_error: "Account type is required",
        invalid_type_error: "Invalid account type",
      }
    ),
  }),
});

const loginSchema = z.object({
  body: z.object({
    email: z.string({
      required_error: "Email is required",
    }).email({
      message: "Invalid email address",
    }),
    password: z.string({
      required_error: "Password is required",
    }),
  }),
});

const refreshTokenSchema = z.object({
  body: z.object({
    refreshToken: z.string({
      required_error: "Refresh token is required",
    }),
  }),
});

const resetPasswordSchema = z.object({
  body: z.object({
    email: z.string({
      required_error: "Email is required",
    }).email({
      message: "Invalid email address",
    }),
    newPassword: z.string({
      required_error: "New password is required",
    }).min(6, {
      message: "Password must be at least 6 characters long",
    }),
  }),
});

module.exports = {
  registerSchema,
  loginSchema,
  refreshTokenSchema,
  resetPasswordSchema,
};
