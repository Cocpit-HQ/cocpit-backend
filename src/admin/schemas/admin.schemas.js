const { z } = require('zod');

const loginSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email format'),
    password: z.string().min(1, 'Password is required')
  })
});

const updateFlagSchema = z.object({
  body: z.object({
    key: z.string().min(1, 'Key is required'),
    value: z.boolean({ required_error: 'Value must be a boolean' })
  })
});

module.exports = {
  loginSchema,
  updateFlagSchema
};
