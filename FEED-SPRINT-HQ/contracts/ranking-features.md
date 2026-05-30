# Ranking Feature Specifications

> **Status: FROZEN ✅** | Signal weights may not be changed without Contract Change Process.

---

## Ranking Signal Definitions

The ranking engine computes a single `final_score` for each candidate using a weighted linear combination of these signals.

### Formula

```
final_score = (recency × Wr) + (engagement × We) + (relationship × Wrel) + (intent_match × Wi)
              - (diversity_penalty × Wd) - (spam_penalty × Ws)
```

### Signal Weights

| Signal | Variable | Weight | Range |
|--------|----------|--------|-------|
| Recency | `Wr` | 0.25 | 0–1 |
| Engagement | `We` | 0.30 | 0–∞ (normalized) |
| Relationship | `Wrel` | 0.25 | 0–1 |
| Intent Match | `Wi` | 0.20 | 0–1 |
| Diversity Penalty | `Wd` | 0.15 | 0–1 |
| Spam Penalty | `Ws` | 0.50 | 0 or 1 |

---

## Signal Computation Rules

### 1. Recency Score

```
recency = 1.0                        if age < 1 hour
recency = 1.0 - (age_hours / 72)    if age 1–72 hours
recency = 0.4 × e^(-age_days × 0.1) if age > 72 hours
```

- **Cap:** minimum recency score = 0.05 (content never drops to 0)

### 2. Engagement Score

```
raw_engagement = (likes × 0.6) + (comments × 1.2) + (shares × 1.5) + (clicks × 1.0)
engagement_normalized = raw_engagement / max(raw_engagement_in_pool, 1)
```

- **Computed at:** candidate generation time
- **Cached in:** `CandidateItem.engagement_score`

### 3. Relationship Score

```
0.0  = No connection
0.25 = 2nd-degree connection
0.5  = 1st-degree connection (follower)
0.75 = Mutual follow
1.0  = Close collaborator (collab projects together)
```

- Retrieved from social graph service, cached per candidate generation run

### 4. Intent Match Score

```
intent_match = cosine_similarity(user_intent_vector, content_intent_vector)
```

- `user_intent_vector`: computed by Intent Engine (existing `intentEngine.js`)
- `content_intent_vector`: derived from content tags, hashtags, category
- Range: 0–1

### 5. Diversity Penalty

Applied during the **reranking layer** (not in raw ranking):

```
diversity_penalty = 0.0   if author_count_in_page < 2
diversity_penalty = 0.5   if same author appears 2nd time
diversity_penalty = 1.0   if same content_type appears 4th time
```

### 6. Spam Penalty

Binary penalty applied if ANY of these are true:

- Engagement bait detected: `shares > 10 × likes AND comments < 5`
- Author has `spam_flag = true` in DB
- Content was reported > 3 times in the last 24h
- Content has `is_hidden = true`

```
spam_penalty = 1.0  (item is effectively removed from feed)
spam_penalty = 0.0  (clean)
```

---

## Opportunity Slot Rules (Frozen)

Jobs and Events are injected as **opportunity slots**, bypassing normal ranking:

- **Eligibility:** `item_type IN ('job', 'event') AND relevance_score > 0.6`
- **Max per page:** 3 opportunity slots per 20-item feed page
- **Injection positions:** [6, 13, 19] (0-indexed)
- **Relevance scoring:** location match × intent match × recency

---

## Exploration Slot Rules (Frozen)

- **Slots per page:** 3 out of 20 items (15%)
- **Injection positions:** [3, 10, 17] (0-indexed)
- **Pool source:** `feed:explore:pool` Redis sorted set
- **Eligibility:** Items NOT in user's social graph, engagement > 0

---

## Ranking Engine Version

```
RANKING_VERSION = "1.0.0"
```

This version string must be included in every `RankingResult` object.
Version increments require architecture review.
