const axios = require("axios");
const crypto = require("crypto");
const redis = require("../../core/db/redis"); // existing Redis client

const GOOGLE_PLACES_BASE = "https://places.googleapis.com/v1";
const ALLOWED_COUNTRIES = ["India", "United Arab Emirates", "Singapore", "Japan"];
const INCLUDED_REGION_CODES = ["IN", "AE", "SG", "JP"];
const CACHE_TTL_AUTOCOMPLETE = 60;    // seconds
const CACHE_TTL_DETAILS = 86400;      // 24 hours

// ─── Address Component Parser ─────────────────────────────────────────────────

function parseAddressComponents(components = []) {
  let country = null, state = null, city = null;
  
  for (const comp of components) {
    const types = comp.types || [];
    const name = comp.longText || comp.shortText || "";
    
    if (types.includes("country")) {
      country = name;
    } else if (types.includes("administrative_area_level_1")) {
      // Normalize UAE emirate names: "Emirate of Dubai" → "Dubai"
      state = name.replace(/^Emirate of /i, "").trim();
    } else if (
      types.includes("locality") ||
      types.includes("postal_town") ||
      types.includes("administrative_area_level_2")
    ) {
      if (!city) city = name; // prefer locality, fallback to others
    }
  }

  return { country, state: state || null, city };
}

// ─── Autocomplete ─────────────────────────────────────────────────────────────

exports.getAutocomplete = async (req, res) => {
  const { q, sessionToken, country, allowedCountryCodes } = req.query;
  const filterKey = allowedCountryCodes || country || 'ALL';
  const cacheKey = `places:ac:${crypto.createHash("sha256").update(`${q.toLowerCase().trim()}:${filterKey}`).digest("hex")}`;
  const startTime = Date.now();

  try {
    // Check Redis cache
    const cached = await redis.get(cacheKey);
    if (cached) {
      const suggestions = JSON.parse(cached);
      
      console.log(JSON.stringify({
        event: "places_autocomplete",
        query_length: q.length,
        cache: "HIT",
        latency_ms: Date.now() - startTime,
        result_count: suggestions.length,
        user_id_hash: crypto.createHash("sha256").update(req.user.sub).digest("hex").slice(0, 8),
      }));

      return res
        .set("X-Cache", "HIT")
        .set("X-Cache-TTL", CACHE_TTL_AUTOCOMPLETE)
        .json({ success: true, data: suggestions });
    }

    let regionCodes = INCLUDED_REGION_CODES;
    if (allowedCountryCodes) {
      regionCodes = allowedCountryCodes.split(',').map(c => c.trim().toLowerCase());
    } else if (country) {
      const countryMap = { "india": "in", "uae": "ae", "united arab emirates": "ae", "japan": "jp", "singapore": "sg" };
      const code = countryMap[country.toLowerCase()];
      if (code) regionCodes = [code];
    }

    // Call Google Places Autocomplete (New)
    const response = await axios.post(
      `${GOOGLE_PLACES_BASE}/places:autocomplete`,
      {
        input: q,
        sessionToken,
        includedRegionCodes: regionCodes,
        includedPrimaryTypes: ["locality", "administrative_area_level_1"],
        languageCode: "en",
      },
      {
        headers: {
          "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
          "X-Goog-FieldMask":
            "suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.types",
          "Content-Type": "application/json",
        },
        timeout: 5000,
      }
    );

    const suggestions = (response.data.suggestions || []).map((s) => ({
      placeId: s.placePrediction.placeId,
      displayName: s.placePrediction.text?.text?.split(",")[0] || "",
      description: s.placePrediction.text?.text || "",
      types: s.placePrediction.types || [],
    }));

    // Cache results
    await redis.setex(cacheKey, CACHE_TTL_AUTOCOMPLETE, JSON.stringify(suggestions));
    
    // Top searches Redis tracking
    await redis.zincrby("places:topsearches", 1, q.toLowerCase().trim());
    await redis.zremrangebyrank("places:topsearches", 0, -1001);

    console.log(JSON.stringify({
      event: "places_autocomplete",
      query_length: q.length,
      cache: "MISS",
      latency_ms: Date.now() - startTime,
      result_count: suggestions.length,
      user_id_hash: crypto.createHash("sha256").update(req.user.sub).digest("hex").slice(0, 8),
    }));

    return res
      .set("X-Cache", "MISS")
      .json({ success: true, data: suggestions });

  } catch (err) {
    console.error("[Places Autocomplete Error]", err?.response?.data || err.message);
    
    console.log(JSON.stringify({
      event: "google_api_error",
      status_code: err?.response?.status || 500,
      message: err.message,
      endpoint: "autocomplete"
    }));
    
    if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
      return res.status(503).json({
        success: false,
        message: "Location service temporarily unavailable",
        fallback: true,
      });
    }
    return res.status(502).json({
      success: false,
      message: "Location service error",
      fallback: true,
    });
  }
};

// ─── Place Details ─────────────────────────────────────────────────────────────

exports.getPlaceDetails = async (req, res) => {
  const { placeId, sessionToken } = req.query;
  const cacheKey = `places:detail:${placeId}`;
  const startTime = Date.now();

  try {
    // Check Redis cache (details are stable — 24h TTL)
    const cached = await redis.get(cacheKey);
    if (cached) {
      const result = JSON.parse(cached);
      
      console.log(JSON.stringify({
        event: "place_details_request",
        place_id: placeId,
        country: result.country,
        cache: "HIT",
        latency_ms: Date.now() - startTime
      }));

      return res
        .set("X-Cache", "HIT")
        .json({ success: true, data: result });
    }

    // Call Google Places Details (New)
    const response = await axios.get(
      `${GOOGLE_PLACES_BASE}/places/${placeId}`,
      {
        headers: {
          "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
          "X-Goog-FieldMask": "id,displayName,addressComponents,location",
          "X-Goog-SessionToken": sessionToken,
        },
        timeout: 5000,
      }
    );

    const place = response.data;
    const { country, state, city } = parseAddressComponents(
      place.addressComponents || []
    );

    // Server-side country validation
    if (!ALLOWED_COUNTRIES.includes(country)) {
      return res.status(400).json({
        success: false,
        message: "Location must be in India, UAE, or Singapore",
        code: "INVALID_LOCATION_COUNTRY",
      });
    }

    const result = {
      placeId,
      country,
      state: state || null,
      city: city || place.displayName?.text || null,
      formattedAddress: [city, state, country].filter(Boolean).join(", "),
      latitude: place.location?.latitude || null,
      longitude: place.location?.longitude || null,
    };

    // Cache structured result
    await redis.setex(cacheKey, CACHE_TTL_DETAILS, JSON.stringify(result));

    console.log(JSON.stringify({
      event: "place_details_request",
      place_id: placeId,
      country: result.country,
      cache: "MISS",
      latency_ms: Date.now() - startTime
    }));

    return res
      .set("X-Cache", "MISS")
      .json({ success: true, data: result });

  } catch (err) {
    console.error("[Places Details Error]", err?.response?.data || err.message);
    
    console.log(JSON.stringify({
      event: "google_api_error",
      status_code: err?.response?.status || 500,
      message: err.message,
      endpoint: "details"
    }));
    
    if (err?.response?.status === 404) {
      return res.status(404).json({ success: false, message: "Place not found" });
    }
    return res.status(503).json({
      success: false,
      message: "Location service temporarily unavailable",
      fallback: true,
    });
  }
};

// ─── Reverse Geocoding ────────────────────────────────────────────────────────

exports.getReverseGeocode = async (req, res) => {
  const { lat, lng } = req.query;
  const latNum = parseFloat(lat);
  const lngNum = parseFloat(lng);
  
  // Cache key with rounding for ~110m precision
  const cacheKey = `places:revgeo:${latNum.toFixed(3)},${lngNum.toFixed(3)}`;
  const startTime = Date.now();

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      const result = JSON.parse(cached);
      console.log(JSON.stringify({
        event: "reverse_geocode_request",
        cache: "HIT",
        latency_ms: Date.now() - startTime
      }));
      return res.set("X-Cache", "HIT").json({ success: true, data: result });
    }

    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/geocode/json`,
      {
        params: {
          latlng: `${lat},${lng}`,
          key: process.env.GOOGLE_MAPS_API_KEY
        },
        timeout: 5000,
      }
    );

    const results = response.data.results;
    if (!results || results.length === 0) {
      return res.status(404).json({ success: false, message: "Location not found" });
    }

    // Use the most specific result
    const place = results[0];
    
    // Geocoding API uses long_name and short_name in address_components
    let country = null, state = null, city = null;
    
    for (const comp of place.address_components || []) {
      const types = comp.types || [];
      const name = comp.long_name || comp.short_name || "";
      
      if (types.includes("country")) {
        country = name;
      } else if (types.includes("administrative_area_level_1")) {
        state = name.replace(/^Emirate of /i, "").trim();
      } else if (
        types.includes("locality") ||
        types.includes("postal_town") ||
        types.includes("administrative_area_level_2")
      ) {
        if (!city) city = name;
      }
    }

    if (!ALLOWED_COUNTRIES.includes(country)) {
      return res.status(400).json({
        success: false,
        message: "Location must be in India, UAE, or Japan",
        code: "UNSUPPORTED_COUNTRY",
      });
    }

    const result = {
      placeId: place.place_id,
      country,
      state: state || null,
      city: city || null,
      formattedAddress: [city, state, country].filter(Boolean).join(", "),
      latitude: latNum,
      longitude: lngNum,
    };

    // Cache for 7 days
    await redis.setex(cacheKey, 7 * 24 * 60 * 60, JSON.stringify(result));

    console.log(JSON.stringify({
      event: "reverse_geocode_request",
      cache: "MISS",
      latency_ms: Date.now() - startTime
    }));

    return res.set("X-Cache", "MISS").json({ success: true, data: result });

  } catch (err) {
    console.error("[Reverse Geocode Error]", err?.response?.data || err.message);
    return res.status(502).json({
      success: false,
      message: "Location service error",
    });
  }
};
