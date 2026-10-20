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
      })
      .refine((val) => {
        if (val === null) return true;
        return val <= new Date().getFullYear();
      }, { message: "Founded year cannot be in the future" }),
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
    // phone: z.string({ required_error: "Phone number is required" }).trim().min(5, "Invalid phone number"),
    phone: z.string().trim().optional().nullable(),
    website: z.string().trim().optional().nullable(),
    size: z.string({ required_error: "Size is required" }).trim(),
    country: z.string({ required_error: "Country is required" }).trim(),
    city: z.string({ required_error: "City is required" }).trim(),
    headline: z.string({ required_error: "Headline is required" }).trim().max(255, "Headline must not exceed 255 characters"),
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

// ---------------------------------------------------------------------------
// Social Media Link URL Validator & Route Middleware
// ---------------------------------------------------------------------------
function validateSocialLinkUrl(platform, url) {
  const trimmed = (url || '').trim();
  if (!trimmed) {
    return { isValid: true };
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch {
    return {
      isValid: false,
      error: 'Please enter a valid URL.',
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  const p = (platform || 'website').toLowerCase().trim();
  const normalizedPlatform = p === 'twitter' ? 'x' : p;

  switch (normalizedPlatform) {
    case 'instagram': {
      const isInstagram =
        hostname === 'instagram.com' ||
        hostname.endsWith('.instagram.com') ||
        hostname === 'instagr.am' ||
        hostname.endsWith('.instagr.am');
      if (!isInstagram) {
        return {
          isValid: false,
          error: 'Please enter a valid Instagram URL',
        };
      }
      return { isValid: true };
    }

    case 'x': {
      const isX =
        hostname === 'x.com' ||
        hostname.endsWith('.x.com') ||
        hostname === 'twitter.com' ||
        hostname.endsWith('.twitter.com');
      if (!isX) {
        return {
          isValid: false,
          error: 'Please enter a valid X (Twitter) URL',
        };
      }
      return { isValid: true };
    }

    case 'facebook': {
      const isFb =
        hostname === 'facebook.com' ||
        hostname.endsWith('.facebook.com') ||
        hostname === 'fb.com' ||
        hostname.endsWith('.fb.com') ||
        hostname === 'fb.me' ||
        hostname.endsWith('.fb.me');
      if (!isFb) {
        return {
          isValid: false,
          error: 'Please enter a valid Facebook URL',
        };
      }
      return { isValid: true };
    }

    case 'youtube': {
      const isYt =
        hostname === 'youtube.com' ||
        hostname.endsWith('.youtube.com') ||
        hostname === 'youtu.be' ||
        hostname.endsWith('.youtu.be');
      if (!isYt) {
        return {
          isValid: false,
          error: 'Please enter a valid YouTube URL',
        };
      }
      return { isValid: true };
    }

    case 'discord': {
      const isDiscord =
        hostname === 'discord.com' ||
        hostname.endsWith('.discord.com') ||
        hostname === 'discord.gg' ||
        hostname.endsWith('.discord.gg') ||
        hostname === 'discordapp.com' ||
        hostname.endsWith('.discordapp.com');
      if (!isDiscord) {
        return {
          isValid: false,
          error: 'Please enter a valid Discord invite URL',
        };
      }
      return { isValid: true };
    }

    case 'cocpit': {
      const isCocpit =
        hostname === 'cocpit.in' ||
        hostname.endsWith('.cocpit.in') ||
        hostname === 'localhost';
      if (!isCocpit) {
        return {
          isValid: false,
          error: 'Please enter a valid Cocpit URL',
        };
      }
      return { isValid: true };
    }

    case 'linkedin': {
      const isLinkedin =
        hostname === 'linkedin.com' ||
        hostname.endsWith('.linkedin.com');
      if (!isLinkedin) {
        return {
          isValid: false,
          error: 'Please enter a valid LinkedIn URL',
        };
      }
      return { isValid: true };
    }

    case 'github': {
      const isGithub =
        hostname === 'github.com' ||
        hostname.endsWith('.github.com');
      if (!isGithub) {
        return {
          isValid: false,
          error: 'Please enter a valid GitHub URL',
        };
      }
      return { isValid: true };
    }

    case 'website':
    default: {
      if (!hostname.includes('.')) {
        return {
          isValid: false,
          error: 'Please enter a valid website URL',
        };
      }
      return { isValid: true };
    }
  }
}

const validateSocialLinks = (req, res, next) => {
  const { links } = req.body;
  if (links !== undefined && links !== null) {
    if (!Array.isArray(links)) {
      return res.status(400).json({ message: 'links must be an array' });
    }
    for (const link of links) {
      if (!link || !link.url || !link.url.trim()) continue;
      const validation = validateSocialLinkUrl(link.platform, link.url);
      if (!validation.isValid) {
        return res.status(400).json({
          message: validation.error || `Invalid URL for platform '${link.platform}'`,
        });
      }
    }
  }
  next();
};

module.exports = {
  createTypeSchema,
  saveIdentitySchema,
  savePresenceSchema,
  verifyEmailSendSchema,
  verifyEmailConfirmSchema,
  verifyPhoneSendSchema,
  verifyPhoneConfirmSchema,
  saveVerificationSchema,
  validateSocialLinkUrl,
  validateSocialLinks,
};
