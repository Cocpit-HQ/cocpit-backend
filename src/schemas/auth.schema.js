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

module.exports = {
  registerSchema,
  loginSchema,
  refreshTokenSchema,
};
