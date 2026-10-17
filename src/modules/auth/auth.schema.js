const { z } = require("zod");

const passwordValidation = z.string({
  required_error: "Password is required",
})
  .min(8, { message: "Password must be at least 8 characters" })
  .regex(/[A-Z]/, { message: "Password must contain at least 1 uppercase letter" })
  .regex(/[0-9]/, { message: "Password must contain at least 1 number" })
  .regex(/[@#$%\^&*!?:;_=\-+(){}[\]|\\/.,~`"'<>]/, { message: "Password must contain at least 1 special character" });

const registerSchema = z.object({
  body: z.object({
    email: z.string({
      required_error: "Email is required",
    }).email({
      message: "Enter a valid email address.",
    }),
    password: passwordValidation,
    otp: z.string({
      required_error: "OTP is required",
    }).length(6, {
      message: "OTP must be exactly 6 digits",
    }),
  }),
});

const loginSchema = z.object({
  body: z.object({
    email: z.string({
      required_error: "Email is required",
    }).email({
      message: "Enter a valid email address.",
    }),
    password: z.string({
      required_error: "Password is required",
    }).min(1, { message: "Password is required" }),
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
      message: "Enter a valid email address.",
    }),
    newPassword: passwordValidation,
    otp: z.string({
      required_error: "OTP is required",
    }).length(6, {
      message: "OTP must be exactly 6 digits",
    }),
    logoutOtherDevices: z.boolean().optional(),
    logoutOthers: z.boolean().optional(),
  }),
});

module.exports = {
  registerSchema,
  loginSchema,
  refreshTokenSchema,
  resetPasswordSchema,
  passwordValidation,
};

