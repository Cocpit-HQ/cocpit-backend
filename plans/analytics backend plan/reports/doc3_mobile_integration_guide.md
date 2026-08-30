# 📱 Document 3: Mobile Developer Integration Guide

> **Audience:** Mobile developers (React Native / Flutter / native iOS/Android) integrating with COCPIT's backend after the analytics feature branches are merged.
> This guide covers **every API change** you need to know to prevent broken experiences on mobile.

---

## ⚠️ Breaking Changes You Must Handle Before Merging

These are changes in the analytics branches that will **break existing mobile flows** if not accounted for:

---

## 1. Profile View API — New Required Behavior

### Endpoint: `POST /dashboard/view`

The dashboard view endpoint now **expects additional context** for attribution tracking. Your existing call still works (it's backward-compatible), but you should upgrade to pass the new fields.

**Before (still works):**
```json
POST /dashboard/view
{
  "profileOwnerId": "uuid",
  "profileType": "user"
}
```

**After (recommended):**
```json
POST /dashboard/view
{
  "profileOwnerId": "uuid",
  "profileType": "user",
  "sourcePostId": "uuid-of-post-they-navigated-from"   // optional
}
```

**What to do on mobile:**
- If the user taps a profile avatar inside a post card → include `sourcePostId` (the post's ID)
- If the user navigates to a profile from search or direct link → omit `sourcePostId` (or send `null`)
- This attribution data feeds the Opportunities analytics tab for the profile owner

---

## 2. Follow User API — New Optional Parameter

### Endpoint: `POST /users/:userId/follow`

```json
POST /users/abc-123/follow
{
  "sourcePostId": "uuid-of-post"    // optional attribution
}
```

### Company Follow User Endpoint: `POST /organizations/:orgId/following/users/:userId`

Same change:
```json
POST /organizations/org-abc/following/users/user-xyz
{
  "sourcePostId": "uuid-of-post"    // optional
}
```

**What to do on mobile:** When displaying a follow button on a post card, pass the `postId` as `sourcePostId`. This allows analytics to tell profile owners which of their posts drove the most follows.

---

## 3. GET User Profile — New Query Parameter

### Endpoint: `GET /users/:userId`

New optional query parameter:
```
GET /users/abc-123?sourcePostId=post-uuid
```

**What to do on mobile:** If navigating to a profile from a post, append `?sourcePostId=<postId>` to this request. Behavior is identical — it just enriches analytics tracking server-side.

> ⚠️ **Important:** Do NOT change the cache key for a profile fetch based on `sourcePostId`. Cache by `userId` only. Attribution is a side-effect, not a data-altering parameter.

---

## 4. NEW: Analytics Endpoints

All analytics endpoints require **authentication** (`Authorization: Bearer <token>`).

### 4.1 Overview Tab
```
GET /users/me/analytics/overview
```

**Query params:**

| Param | Values | Notes |
|---|---|---|
| `filter` | `7days`, `30days`, `all_time`, `custom` | Required |
| `startDate` | `YYYY-MM-DD` | Only when `filter=custom` |
| `endDate` | `YYYY-MM-DD` | Only when `filter=custom` |

**Response shape:**
```json
{
  "status": "success",
  "data": {
    "keyMetrics": {
      "profileViews": { "value": 142, "trend": "+12%", "isPositive": true },
      "searchAppearances": { "value": 38, "trend": "-5%", "isPositive": false },
      "connectionRequests": { "value": 5, "trend": "+2%", "isPositive": true },
      "followerGrowth": { "value": 11, "trend": "+8%", "isPositive": true },
      "opportunityViews": { "value": 20, "trend": "Stable", "isPositive": null },
      "resumeViews": { "value": 7, "trend": "+3%", "isPositive": true },
      "resumeDownloads": { "value": 2, "trend": "+1%", "isPositive": true }
    },
    "chart": {
      "labels": ["Aug 7", "Aug 8", "..."],
      "datasets": [{ "label": "Profile Views", "data": [10, 15, 8] }],
      "startDate": "2026-08-07",
      "endDate": "2026-08-14",
      "tip": "Post more consistently to grow your reach."
    },
    "profileStrength": {
      "score": 72,
      "missingFields": ["bio", "skills"],
      "message": "Add a bio to attract more profile views."
    },
    "insights": ["Your profile views grew 12% this week."]
  }
}
```

---

### 4.2 Audience Tab
```
GET /users/me/analytics/audience?filter=30days
```

**Response shape:**
```json
{
  "data": {
    "topMetrics": {
      "overallReach": { "value": 200, "trend": "+15%", "isPositive": true },
      "profileViews": { "value": 142, "trend": "+12%", "isPositive": true },
      "engagementRate": { "value": "4.2%", "trend": "+0.5%", "isPositive": true }
    },
    "audienceLocation": {
      "countries": [{ "name": "India", "value": 65 }, { "name": "USA", "value": 20 }],
      "cities": [{ "name": "Pune", "value": 40 }, { "name": "Mumbai", "value": 25 }]
    },
    "audienceIndustries": [
      { "name": "Software", "value": 55.3 },
      { "name": "Finance", "value": 22.1 }
    ],
    "insights": ["60% of your audience is from India."]
  }
}
```

---

### 4.3 Content Tab
```
GET /users/me/analytics/content?filter=30days&sort=top_performing
```

**Sort values:** `top_performing`, `most_viewed`, `most_liked`, `most_shared`

**Response shape:**
```json
{
  "data": {
    "formatPerformance": {
      "articlesViews": { "value": "1.2K", "icon": "newspaper" },
      "mediaViews": { "value": "3.4K", "icon": "video" },
      "pollsViews": { "value": "200", "icon": "bar-chart" },
      "textViews": { "value": "890", "icon": "type" }
    },
    "topPosts": [
      {
        "id": "post-uuid",
        "title": "Post content preview...",
        "type": "text",
        "date": "2026-08-10",
        "views": "1.2K",
        "likes": "45",
        "shares": "12",
        "imgSrc": null,
        "icon": null
      }
    ]
  }
}
```

---

### 4.4 Opportunities Tab
```
GET /users/me/analytics/opportunities?filter=30days
```

**Response shape:**
```json
{
  "data": {
    "topMetrics": {
      "opportunityActivity": {
        "value": "27",
        "trend": "+30%",
        "isPositive": true,
        "label": "recruiter views & offers"
      },
      "repeatVisitors": {
        "percentage": "18.5%",
        "count": 5,
        "label": "recruiters returned to your profile multiple times."
      }
    },
    "topOrganizations": [
      {
        "name": "Google",
        "industry": "Internet Software",
        "visits": "3 visits",
        "role": "Recruiter",
        "icon": "https://cdn.example.com/google-logo.png"
      }
    ],
    "organizationIndustries": [
      { "name": "Internet Software", "value": 60.0 },
      { "name": "Finance", "value": 25.0 }
    ],
    "insights": ["Recruiters from Internet Software companies showed the highest interest."]
  }
}
```

---

### 4.5 Post Analytics
```
GET /posts/:postId/analytics?filter=30days
```

**Response shape:**
```json
{
  "data": {
    "post": {
      "postId": "uuid",
      "content": "My first post...",
      "postType": "text",
      "createdAt": "2026-08-01T10:00:00Z",
      "mediaUrl": null,
      "mediaType": null
    },
    "performance": {
      "impressions": 450,
      "likes": 22,
      "comments": 8,
      "shares": 5,
      "saves": 3,
      "engagementRate": "8.44%"
    },
    "reachChart": {
      "labels": ["Aug 1", "Aug 2"],
      "datasets": [{ "label": "Impressions", "data": [200, 250] }]
    },
    "directImpact": {
      "profileVisits": { "value": 12, "vsAvg": "+3", "isPositive": true },
      "newFollowers": { "value": 4, "vsAvg": "+1", "isPositive": true },
      "organizationViews": { "value": 2, "vsAvg": "0", "isPositive": null }
    },
    "audienceDemographics": {
      "countries": [{ "name": "India", "value": 70 }],
      "cities": [{ "name": "Pune", "value": 40 }],
      "industries": [{ "name": "Software", "value": 55 }]
    }
  }
}
```

---

### 4.6 Resume Event Tracking

> ⚠️ **Known issue (G3 from Gap Analysis):** This endpoint may return 404 until the route is wired in `analytics.routes.js`. Check with backend team before implementing.

```
POST /analytics/resume-events
Authorization: Bearer <token>
{
  "targetUserId": "uuid-of-profile-owner",
  "eventType": "view"    // or "download"
}
```

**When to call on mobile:**
- User taps "View Resume" on someone's profile → `eventType: "view"`
- User taps "Download Resume" → `eventType: "download"`
- Own profile resume download → `eventType: "download"` with own userId

---

## 5. Impression Threshold Change

The `view_date` column is now required for impression inserts. The backend handles this server-side — no mobile change needed. However, be aware:

> The impression trigger threshold was lowered from **60% visibility to 20% visibility** on web. If you're implementing impression tracking on mobile, use the **60% threshold** (original value) for consistency in analytics data until a unified decision is made.

---

## 6. Share Count Changes

`share_count` on post objects returned by feed APIs now counts **both** re-posts (shares within feed) and external message shares. Numbers may appear slightly higher than before. This is intentional and reflects true share volume.

---

## 7. Migration Checklist for Mobile Team

- [ ] Update profile view call to optionally pass `sourcePostId` when navigating from a post
- [ ] Update follow user/org calls to optionally pass `sourcePostId`
- [ ] Update `GET /users/:id` calls to optionally pass `sourcePostId` as query param
- [ ] Keep profile cache key as `userId` only (do NOT include `sourcePostId` in cache key)
- [ ] Implement 5 new analytics screens: Overview, Audience, Content, Opportunities, Post Analytics
- [ ] Implement resume event tracking on "View Resume" and "Download Resume" taps
- [ ] Handle empty/zero-data states gracefully for all analytics screens
- [ ] Test with a new account (0 analytics data) — all screens should show "No data yet" states
