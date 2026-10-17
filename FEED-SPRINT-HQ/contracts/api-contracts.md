# Feed Engine — API Contracts

> **Status: FROZEN ✅** | Changes require: `governance/CONTRACT_CHANGE_PROCESS.md`

---

## Base URL

```
/api/feed
```

---

## Endpoints

### GET /api/feed

**Purpose:** Fetch the next paginated feed slice for the authenticated user.

**Auth:** Required (`Authorization: Bearer <token>`)

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `cursor` | string | No | Pagination cursor from previous response |
| `limit` | number | No | Items per page. Default: 20. Max: 50 |
| `context` | string | No | Feed context hint: `home`, `explore`, `startup`. Default: `home` |

**Success Response — 200**

```json
{
  "ok": true,
  "data": {
    "items": [FeedItem],
    "cursor": "string",
    "has_more": true,
    "session_id": "uuid",
    "served_at": "ISO8601"
  },
  "meta": {
    "total_candidates": 150,
    "cache_hit": false,
    "exploration_slots": 3,
    "ranking_version": "1.0.0"
  }
}
```

**Error Responses:**

| Code | Reason |
|------|--------|
| 401 | Unauthenticated |
| 429 | Rate limited |
| 500 | Feed engine internal error |

---

### POST /api/feed/event

**Purpose:** Track a user interaction with a feed item (impression, click, dwell, share, dismiss).

**Auth:** Required

**Request Body:**

```json
{
  "event_type": "impression | click | dwell | share | dismiss | like | comment",
  "item_id": "uuid",
  "item_type": "post | job | event | startup | person",
  "session_id": "uuid",
  "position": 0,
  "dwell_ms": 1500,
  "context": "home | explore | startup",
  "metadata": {}
}
```

**Success Response — 202**

```json
{
  "ok": true,
  "message": "Event accepted"
}
```

---

### GET /api/feed/session

**Purpose:** Get the current feed session state for the authenticated user.

**Auth:** Required

**Success Response — 200**

```json
{
  "ok": true,
  "data": {
    "session_id": "uuid",
    "cursor": "string",
    "seen_count": 42,
    "started_at": "ISO8601",
    "expires_at": "ISO8601"
  }
}
```

---

### DELETE /api/feed/session

**Purpose:** Reset the user's feed session (clear seen set + cursor).

**Auth:** Required

**Success Response — 200**

```json
{
  "ok": true,
  "message": "Feed session reset"
}
```

---

## FeedItem Schema

```json
{
  "id": "uuid",
  "type": "post | job | event | startup | person",
  "content": {},
  "author": {
    "id": "uuid",
    "name": "string",
    "avatar_url": "string | null",
    "verified": false
  },
  "score": 0.87,
  "slot_type": "organic | exploration | opportunity",
  "ranked_at": "ISO8601",
  "position": 0
}
```

---

## Rate Limits

| Endpoint | Limit |
|----------|-------|
| GET /api/feed | 60 req/min per user |
| POST /api/feed/event | 300 req/min per user |
| GET /api/feed/session | 30 req/min per user |
