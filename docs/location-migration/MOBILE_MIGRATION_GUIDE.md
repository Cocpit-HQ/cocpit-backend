# 📍 Location Feature — Mobile Migration Guide

**For:** iOS & Android Teams  
**Backend Version:** `feature/location-migration-v2`  
**Date:** 2026-05-28  
**Status:** ✅ Backend + DB live — mobile integration required

---

## Overview

We've replaced the old location system (GeoNames lookup via `location_id`) with **Google Places Autocomplete** via a backend proxy.

**You no longer call Google directly** — all Places API calls go through the COCPIT backend, so there's no API key management on the client side.

### What Changed at a Glance

| | Old (Legacy) | New |
|---|---|---|
| **Location source** | Internal `locations` table (India-only, bug) | Google Places — IN, AE, SG |
| **Client calls Google?** | No | No (backend proxy) |
| **Search endpoint** | `GET /api/locations?search=` | `GET /api/places/autocomplete?q=` |
| **Details endpoint** | None | `GET /api/places/details?placeId=` |
| **Save endpoint** | `PATCH /api/onboarding/location` with `location_id` | `PATCH /api/onboarding/location` with structured object |
| **Data stored** | `users.location` (text), `users.location_id` (int) | 7 new structured columns + old `location` kept for compat |

---

## The New 3-Step Flow

```
User types "Mum"
      │
      ▼
Step 1: GET /api/places/autocomplete?q=Mum&sessionToken=<uuid>
      │   → Returns list of city suggestions
      │
      ▼ (user taps "Mumbai")
Step 2: GET /api/places/details?placeId=ChIJ...&sessionToken=<same-uuid>
      │   → Returns structured { country, state, city, lat, lng }
      │
      ▼ (user taps Continue)
Step 3: PATCH /api/onboarding/location
            Body: { country, state, city, formattedAddress, latitude, longitude, placeId }
```

> **Important:** Use the **same `sessionToken`** for autocomplete + details calls in one search session. Generate a **new UUID** when the user starts a new search. This is required for correct Google billing.

---

## Step 1 — Search / Autocomplete

### `GET /api/places/autocomplete`

```
GET /api/places/autocomplete?q=Mumbai&sessionToken=f47ac10b-58cc-4372-a567-0e02b2c3d479
Authorization: Bearer <access_token>
```

| Query Param | Type | Required | Notes |
|---|---|---|---|
| `q` | string | Yes | Min 2 characters |
| `sessionToken` | string (UUID v4) | Yes | Generate once per search session. Reuse for the details call. |

**Response 200 OK:**

```json
{
  "success": true,
  "data": [
    {
      "placeId": "ChIJwe1EZjDG5zsRaYxkjY_tpF0",
      "displayName": "Mumbai",
      "description": "Mumbai, Maharashtra, India",
      "types": ["locality", "political"]
    },
    {
      "placeId": "ChIJ4eVo2HwWBDkRc4p5hG7rFlI",
      "displayName": "Munnar",
      "description": "Munnar, Kerala, India",
      "types": ["locality", "political"]
    }
  ]
}
```

Use `displayName` for the list label (e.g. "Mumbai").  
Use `description` for the subtitle (e.g. "Mumbai, Maharashtra, India").  
Store `placeId` — you'll need it for Step 2.

**Response 503 — Google API temporarily down:**

```json
{
  "success": false,
  "message": "Location service temporarily unavailable",
  "fallback": true
}
```

> When `fallback: true`, show a skip option so the user is not blocked. They can still complete onboarding without a location.

**Rate limit:** 30 requests/minute per user. Debounce your text input by ~300ms.

---

## Step 2 — Fetch Place Details

After the user **taps a suggestion**, call details to get the structured data (country, state, city, coordinates).

### `GET /api/places/details`

```
GET /api/places/details?placeId=ChIJwe1EZjDG5zsRaYxkjY_tpF0&sessionToken=f47ac10b-58cc-4372-a567-0e02b2c3d479
Authorization: Bearer <access_token>
```

> Use the **same `sessionToken`** from Step 1. This closes the billing session on Google's side.

| Query Param | Type | Required | Notes |
|---|---|---|---|
| `placeId` | string | Yes | From autocomplete suggestion |
| `sessionToken` | string (UUID v4) | Yes | Same token used in Step 1 |

**Response 200 OK — India (with state):**

```json
{
  "success": true,
  "data": {
    "placeId": "ChIJwe1EZjDG5zsRaYxkjY_tpF0",
    "country": "India",
    "state": "Maharashtra",
    "city": "Mumbai",
    "formattedAddress": "Mumbai, Maharashtra, India",
    "latitude": 19.076,
    "longitude": 72.8777
  }
}
```

**Response 200 OK — Singapore (no state, `state` is `null`):**

```json
{
  "success": true,
  "data": {
    "placeId": "ChIJdZOTPBpB2jERmBLV_ER-5PM",
    "country": "Singapore",
    "state": null,
    "city": "Singapore",
    "formattedAddress": "Singapore",
    "latitude": 1.3521,
    "longitude": 103.8198
  }
}
```

**Response 200 OK — UAE (emirate as state):**

```json
{
  "success": true,
  "data": {
    "placeId": "ChIJRcbZaklDXz4RYlEphFBu5r0",
    "country": "United Arab Emirates",
    "state": "Dubai",
    "city": "Dubai",
    "formattedAddress": "Dubai, United Arab Emirates",
    "latitude": 25.2048,
    "longitude": 55.2708
  }
}
```

**Response 400 — Location not in allowed countries:**

```json
{
  "success": false,
  "message": "Location must be in India, UAE, or Singapore",
  "code": "INVALID_LOCATION_COUNTRY"
}
```

> Store the full `data` object locally after this call — you'll send all these fields in Step 3.

---

## Step 3 — Save Location

After the user confirms and taps **Continue**, send the structured location data.

### `PATCH /api/onboarding/location`

```
PATCH /api/onboarding/location
Authorization: Bearer <access_token>
Content-Type: application/json
```

**Request body:**

```json
{
  "country": "India",
  "state": "Maharashtra",
  "city": "Mumbai",
  "formattedAddress": "Mumbai, Maharashtra, India",
  "latitude": 19.076,
  "longitude": 72.8777,
  "placeId": "ChIJwe1EZjDG5zsRaYxkjY_tpF0"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `country` | string | Yes | Must be `"India"`, `"United Arab Emirates"`, or `"Singapore"` |
| `state` | string or null | Optional | `null` for Singapore |
| `city` | string | Yes | City name |
| `formattedAddress` | string | Yes | Full display string |
| `latitude` | number or null | Optional | Nullable if details call failed |
| `longitude` | number or null | Optional | Nullable if details call failed |
| `placeId` | string | Yes | Google Place ID |

**Response 200 OK:**

```json
{
  "success": true,
  "message": "Location updated",
  "data": {
    "location_formatted": "Mumbai, Maharashtra, India",
    "location_country": "India",
    "location_city": "Mumbai",
    "next_step": "COMPLETE"
  }
}
```

**Response 400 — Invalid country:**

```json
{
  "success": false,
  "message": "Location must be in India, UAE, or Singapore",
  "code": "INVALID_LOCATION_COUNTRY"
}
```

---

## Updated: `POST /api/auth/onboarding` (Complete Onboarding)

If you send location as part of the final complete-onboarding call, the body format has changed.

**Old format (no longer supported):**

```json
{
  "account_name": "john_doe",
  "location_id": 123,
  "full_name": "John Doe",
  "finish": true
}
```

**New format:**

```json
{
  "account_name": "john_doe",
  "full_name": "John Doe",
  "finish": true,
  "location": {
    "country": "India",
    "state": "Maharashtra",
    "city": "Mumbai",
    "formattedAddress": "Mumbai, Maharashtra, India",
    "latitude": 19.076,
    "longitude": 72.8777,
    "placeId": "ChIJwe1EZjDG5zsRaYxkjY_tpF0"
  }
}
```

> `location_id` is ignored in the new flow — stop sending it. The `location` object is optional in this endpoint (location can be set separately via `PATCH /api/onboarding/location`).

---

## How Data Is Stored in the Database

After a successful save, these columns are populated on the `users` table:

| Column | Type | Example Value | Notes |
|---|---|---|---|
| `location` | TEXT | `"Mumbai, Maharashtra, India"` | Legacy column — still written for backward compat |
| `location_formatted` | TEXT | `"Mumbai, Maharashtra, India"` | New structured column, same value |
| `location_country` | TEXT | `"India"` | Full country name |
| `location_state` | TEXT or NULL | `"Maharashtra"` | NULL for Singapore |
| `location_city` | TEXT | `"Mumbai"` | City name |
| `location_lat` | DOUBLE PRECISION or NULL | `19.076` | Nullable |
| `location_lng` | DOUBLE PRECISION or NULL | `72.8777` | Nullable |
| `location_place_id` | TEXT | `"ChIJwe1EZjDG5zsRaYxkjY_tpF0"` | Google Place ID |

> The old `location_id` (int FK to `locations` table) is set to `NULL` for all new users. Old users retain their existing value — no data loss.

**Profile read APIs are unchanged.** The `location` field on any profile response still returns the plain text display string (e.g. `"Mumbai, Maharashtra, India"`). No changes required on any read path.

---

## Session Token — Implementation

Generate a UUID v4 at the start of each search session.

**Swift (iOS):**
```swift
let sessionToken = UUID().uuidString.lowercased()
```

**Kotlin (Android):**
```kotlin
val sessionToken = java.util.UUID.randomUUID().toString()
```

**Rules:**
- Use the **same token** across all autocomplete calls while the user is typing.
- Use the **same token** for the details call when the user selects a result.
- Generate a **new token** when the user clears the field and starts a new search, or after selection.

---

## Error Handling Reference

| Scenario | What to do |
|---|---|
| Autocomplete returns `fallback: true` (503) | Show a "Skip" option. Do not block the user. |
| Details call fails or returns 503 | Still call `PATCH /api/onboarding/location` — send `latitude: null`, `longitude: null` |
| Country not IN/AE/SG (400 from details) | Show error: "Only India, UAE, and Singapore are supported" |
| Rate limit hit (429) | Back off. Debounce search input to 300ms minimum. |
| Network error | Show retry. Do not crash the onboarding flow. |

---

## What NOT to Change

- `GET /api/locations?search=` — still alive, do not touch. Still used by Experience and Education forms.
- Profile read APIs — no changes to how location is returned.
- Auth token handling — no changes.

---

## Integration Checklist

### iOS
- [ ] Remove `GET /api/locations` call from onboarding location step
- [ ] Add `GET /api/places/autocomplete` with session token on text input
- [ ] Add `GET /api/places/details` on row tap (same session token)
- [ ] Update `PATCH /api/onboarding/location` body to structured format
- [ ] Update `POST /api/auth/onboarding` — send `location` object, drop `location_id`
- [ ] Handle `fallback: true` — show skip option
- [ ] Handle `state: null` for Singapore
- [ ] Generate new session token on clear / after selection
- [ ] Debounce autocomplete input (300ms+)

### Android
- [ ] Remove `GET /api/locations` call from onboarding location step
- [ ] Add `GET /api/places/autocomplete` with session token on text input
- [ ] Add `GET /api/places/details` on item tap (same session token)
- [ ] Update `PATCH /api/onboarding/location` body to structured format
- [ ] Update `POST /api/auth/onboarding` — send `location` object, drop `location_id`
- [ ] Handle `fallback: true` — show skip option
- [ ] Handle `state: null` for Singapore
- [ ] Generate new session token on clear / after selection
- [ ] Debounce autocomplete input (300ms+)

---

## Questions?

Full internal documentation is in:
```
cocpit-backend/docs/location-migration/
├── API_CONTRACTS.md        ← Full before/after API specs
├── DATABASE_CHANGES.md     ← Exact SQL migration run
├── ARCHITECTURE_NOTES.md   ← Why we chose this approach
└── RISKS_AND_BLOCKERS.md   ← Known edge cases
```
