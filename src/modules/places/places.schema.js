const { z } = require("zod");

const autocompleteSchema = z.object({
  query: z.object({
    q: z.string().min(2, "Query must be at least 2 characters").max(200),
    sessionToken: z.string().uuid("sessionToken must be a valid UUID"),
    country: z.string().optional(),
    allowedCountryCodes: z.string().optional(),
    global: z.string().optional(),
    types: z.string().optional(),
  }),
});

const detailsSchema = z.object({
  query: z.object({
    placeId: z.string().min(1, "placeId is required"),
    sessionToken: z.string().uuid("sessionToken must be a valid UUID"),
    global: z.string().optional(),
  }),
});

const reverseGeocodeSchema = z.object({
  query: z.object({
    lat: z.string().refine(val => !isNaN(parseFloat(val)) && parseFloat(val) >= -90 && parseFloat(val) <= 90, "Invalid latitude"),
    lng: z.string().refine(val => !isNaN(parseFloat(val)) && parseFloat(val) >= -180 && parseFloat(val) <= 180, "Invalid longitude"),
  }),
});

module.exports = { autocompleteSchema, detailsSchema, reverseGeocodeSchema };
