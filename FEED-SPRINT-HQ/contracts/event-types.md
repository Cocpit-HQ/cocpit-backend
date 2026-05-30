# Feed Event Type Catalog

> **Status: FROZEN ✅** | Adding a new event type requires the Contract Change Process.

---

## Event Envelope Schema

Every event POSTed to `/api/feed/event` must conform to:

```typescript
interface FeedEvent {
  event_type: FeedEventType;    // See catalog below
  item_id: string;              // UUID of the feed item
  item_type: FeedItemType;      // Type of content
  session_id: string;           // Active feed session UUID
  position: number;             // 0-indexed position in feed page
  dwell_ms?: number;            // Only for 'dwell' events
  context: FeedContext;         // Feed surface context
  metadata?: Record<string, unknown>;
  timestamp?: string;           // ISO8601 — server assigns if omitted
}
```

---

## FeedEventType Enum

| Event Type | Trigger | Signals Used For |
|------------|---------|-----------------|
| `impression` | Item rendered in viewport | Exposure tracking, reach |
| `click` | User taps/clicks the item | Strong positive signal |
| `dwell` | User views item >1.5s | Quality engagement signal |
| `share` | User shares the item | Virality signal |
| `like` | User likes the item | Positive ranking signal |
| `comment` | User comments | Deep engagement |
| `dismiss` | User dismisses/swipes away | Negative ranking signal |
| `hide` | User hides this content type | Strong negative signal |
| `report` | User reports content | Anti-spam signal |
| `follow_from_feed` | User follows author from feed | High-value conversion |
| `apply_from_feed` | User applies to job from feed | Opportunity conversion |
| `rsvp_from_feed` | User RSVPs event from feed | Event conversion |

---

## FeedItemType Enum

| Type | Description |
|------|-------------|
| `post` | User text/media post |
| `job` | Job listing |
| `event` | Event announcement |
| `startup` | Startup profile card |
| `person` | People you may know card |

---

## FeedContext Enum

| Context | Description |
|---------|-------------|
| `home` | Main home feed |
| `explore` | Explore/discovery feed |
| `startup` | Startup-focused feed |

---

## Signal Weights (Input to Ranking Engine)

These are the **official** signal weights. Do NOT hardcode overrides in implementation.

| Signal | Weight | Notes |
|--------|--------|-------|
| `click` | 1.0 | Baseline |
| `dwell` (>5s) | 0.8 | Strong quality indicator |
| `share` | 1.5 | Virality multiplier |
| `like` | 0.6 | Light positive |
| `comment` | 1.2 | Deep engagement |
| `dismiss` | -1.5 | Penalty |
| `hide` | -3.0 | Hard penalty |
| `impression` | 0.05 | Reach signal only |
| `follow_from_feed` | 2.0 | Highest positive |
| `apply_from_feed` | 2.5 | Highest conversion |
