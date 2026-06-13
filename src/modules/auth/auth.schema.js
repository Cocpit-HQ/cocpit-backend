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
    })
      .min(8, { message: "Password must be at least 8 characters long" })
      .max(15, { message: "Password must be at most 15 characters long" })
      .regex(/[a-z]/, { message: "Password must contain at least 1 lowercase letter (a-z)" })
      .regex(/[A-Z]/, { message: "Password must contain at least 1 uppercase letter (A-Z)" })
      .regex(/[@#$%\^&*!?:;_=\-+(){}[\]|\\/.,~`"'<>]/, { message: "Password must contain at least 1 special character (e.g., @, #, $, %, &, *)" }),
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
    })
      .min(8, { message: "Password must be at least 8 characters long" })
      .max(15, { message: "Password must be at most 15 characters long" })
      .regex(/[a-z]/, { message: "Password must contain at least 1 lowercase letter (a-z)" })
      .regex(/[A-Z]/, { message: "Password must contain at least 1 uppercase letter (A-Z)" })
      .regex(/[@#$%\^&*!?:;_=\-+(){}[\]|\\/.,~`"'<>]/, { message: "Password must contain at least 1 special character (e.g., @, #, $, %, &, *)" }),
    otp: z.string({
      required_error: "OTP is required",
    }).length(6, {
      message: "OTP must be exactly 6 digits",
    }),
  }),
});

module.exports = {
  registerSchema,
  loginSchema,
  refreshTokenSchema,
  resetPasswordSchema,
};
