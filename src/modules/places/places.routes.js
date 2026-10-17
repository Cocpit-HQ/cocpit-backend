const express = require("express");
const router = express.Router();
const { requireAuth } = require("../../core/middlewares/auth.middleware");
const { validate } = require("../../core/middlewares/validation.middleware");
const { createRateLimit } = require("../../core/middlewares/rateLimit.middleware");
const placesController = require("./places.controller");
const { autocompleteSchema, detailsSchema, reverseGeocodeSchema } = require("./places.schema");

const placesLimiter = createRateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 30,
  message: "Too many location requests. Please slow down.",
});

router.get(
  "/autocomplete",
  requireAuth,
  placesLimiter,
  validate(autocompleteSchema),
  placesController.getAutocomplete
);

router.get(
  "/details",
  requireAuth,
  placesLimiter,
  validate(detailsSchema),
  placesController.getPlaceDetails
);

router.get(
  "/reverse-geocode",
  requireAuth,
  placesLimiter,
  validate(reverseGeocodeSchema),
  placesController.getReverseGeocode
);

module.exports = router;
