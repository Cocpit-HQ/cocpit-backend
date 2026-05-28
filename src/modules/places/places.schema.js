const { z } = require("zod");

const autocompleteSchema = z.object({
  query: z.object({
    q: z.string().min(2, "Query must be at least 2 characters").max(200),
    sessionToken: z.string().uuid("sessionToken must be a valid UUID"),
  }),
});

const detailsSchema = z.object({
  query: z.object({
    placeId: z.string().min(1, "placeId is required"),
    sessionToken: z.string().uuid("sessionToken must be a valid UUID"),
  }),
});

module.exports = { autocompleteSchema, detailsSchema };
