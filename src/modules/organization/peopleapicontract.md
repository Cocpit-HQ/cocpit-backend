# People API contract

Documents `GET /organizations/:orgId/people` and `GET /organizations/:orgId/alumni` (`organization.profile.controller.js` — `getOrgPeople` / `getOrgAlumni`).

Both endpoints are structural twins: same enrichment (`is_following`, `is_followed_by`, `connection_request_status`, `connection_request_id`, `connection_request_sender`, `is_connection`, `is_connected`), same sort/cursor shape. `people` sorts by `joined_at`, `alumni` sorts by `graduation_year`.

---

## 1. Get org people

`GET /organizations/:orgId/people`

**Auth**: `optionalAuth` — works signed-out, but connection fields are only meaningful when a viewer is present.

**Query parameters**
| param | type | notes |
|---|---|---|
| `limit` | number | Page size. |
| `search` | string | Matches `full_name` or `title` (ILIKE). |
| `cursor` | string | Opaque, base64. Omit for page 1. |
| `page` | number | Accepted but **ignored** — pagination is cursor-based, not offset-based. |

**Viewer resolution**: `viewerId` = `req.user.sub` from the auth token (or `null` if signed out). Connection status is always computed against this personal user id; the endpoint has no notion of "viewing as a company."

**200 response**
```json
{
  "people": [
    {
      "user_id": "uuid-1",
      "full_name": "Jordan Alexis",
      "avatar_url": "https://...",
      "headline": "Frontend Engineer",
      "account_name": "jordan.alexis",
      "location": "Remote",
      "title": "Frontend Engineer",
      "role_display": "Frontend Engineer",
      "role_color": null,
      "is_core_team": false,
      "joined_at": "2025-03-01",

      "is_following": true,
      "is_followed_by": true,
      "is_connection": true,
      "is_connected": true,

      "connection_request_status": "connected",
      "connection_request_id": "uuid | null",
      "connection_request_sender": "me | them | null"
    },
    {
      "user_id": "uuid-2",
      "full_name": "Sara Systems",
      "avatar_url": "https://...",
      "headline": "HR Business Partner",
      "account_name": "sara.systems",
      "location": "New York",
      "title": "HR Business Partner",
      "role_display": "HR Business Partner",
      "role_color": null,
      "is_core_team": false,
      "joined_at": "2024-11-15",

      "is_following": false,
      "is_followed_by": false,
      "is_connection": false,
      "is_connected": false,

      "connection_request_status": null,
      "connection_request_id": null,
      "connection_request_sender": null
    }
  ],
  "meta": {
    "total": 42,
    "connections_total": 6,
    "limit": 20,
    "next_cursor": "base64string | null",
    "has_more": true
  },
  "insights": {
    "locationDistribution": [{ "name": "Remote", "percentage": 40 }],
    "topSkills": [{ "name": "React", "percentage": 55 }],
    "roleDistribution": [{ "name": "Engineering", "percentage": 60 }],
    "educationBreakdown": [{ "name": "B.Tech", "percentage": 70 }]
  }
}
```

No separate `suggested_people` array exists — "suggested" is just any row with `is_connected: false` (`uuid-2` above). Every returned row is one flat list; connected rows (`is_connected: true`) always appear first, non-connected ("suggested") rows follow, per the sort order in §1 below. Splitting the array into two UI groups is purely a matter of partitioning on `is_connected` — the backend does not, and doesn't need to, separate them into distinct fields.

### Field notes
- **`is_connected`** — `connection_request_status === 'connected'`. Canonical "is this person connected to the viewer" flag.
- **`is_connection`** — legacy field, `is_following && is_followed_by` (mutual *follow*, not the real connection graph). Kept for backward compatibility; answers a different question than `is_connected`.
- **`connection_request_status`** — `'connected' | 'pending' | null` (no request exists).
- **`meta.total`** — total employees matching the filters (all rows, connected + not).
- **`meta.connections_total`** — subset of `total` where `is_connected = true` for this viewer. Requires a viewer; `0` when signed out.

### Ordering & pagination
Rows are sorted `is_connected DESC, joined_at DESC, user_id ASC` — all connected rows precede all non-connected rows, on every page, permanently.

**Cursor** is a 3-part tuple, base64-encoded: `${isConnected ? '1' : '0'}|${joinedAt}|${userId}`. Opaque — pass whatever `meta.next_cursor` returns back as the `cursor` query param unchanged. A cursor from a different `search`/`limit` combination is undefined behavior (as with the pre-existing 2-part cursor).

---

## 2. Get org alumni

`GET /organizations/:orgId/alumni`

Same auth, same response shape as §1, with differences:
- Response key is `alumni`, not `people`.
- Sort/cursor key is `graduation_year` instead of `joined_at`; cursor is `${isConnected ? '1' : '0'}|${graduationYear}|${userId}`.
- Extra query param: `graduation_year` (number, exact-match filter).
- 404s with `{ message: 'Alumni tab is only available for institutions' }` if the org's `entity_type !== 'INSTITUTION'`.

Everything in §1's "Field notes" and "Ordering & pagination" applies identically here.

---

## 3. Known gaps
- The `page` query param is accepted but ignored by the backend on both endpoints.
- No backend concept of "viewing as a company" — connection status is always computed against the signed-in user's personal id, regardless of which profile is active.
