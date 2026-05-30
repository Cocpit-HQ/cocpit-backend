# Redis Key Registry

> **Status: FROZEN ✅** | All Redis keys must be registered here before use.
> No key may be created in code that is not in this registry.

---

## Naming Convention

```
{prefix}:{entity}:{identifier}[:{sub-key}]
```

All keys use **colons as separators**. No dots, dashes, or underscores in key segments.

---

## Registry

### Feed Cache Keys

| Key Pattern | Type | TTL | Description | Owner |
|-------------|------|-----|-------------|-------|
| `feed:slice:{user_id}:{cursor}` | String (JSON) | 300s | Precomputed feed page slice | Dev B |
| `feed:candidates:{user_id}` | String (JSON) | 120s | Raw candidate pool before ranking | Dev A |
| `feed:ranked:{user_id}` | String (JSON) | 120s | Scored candidate list | Dev A |

### Session Keys

| Key Pattern | Type | TTL | Description | Owner |
|-------------|------|-----|-------------|-------|
| `feed:session:{user_id}` | Hash | 1800s | Session state: cursor, started_at, context | Dev B |
| `feed:seen:{user_id}` | Set | 86400s | Item IDs the user has seen (24h) | Dev B |
| `feed:cursor:{user_id}` | String | 1800s | Current pagination cursor | Dev B |

### Analytics / Event Keys

| Key Pattern | Type | TTL | Description | Owner |
|-------------|------|-----|-------------|-------|
| `feed:events:queue` | List | No TTL | Event outbox queue (LPUSH/RPOP) | Dev A |
| `feed:impression:{user_id}:{item_id}` | String | 3600s | Impression dedup key | Dev A |

### Exploration Keys

| Key Pattern | Type | TTL | Description | Owner |
|-------------|------|-----|-------------|-------|
| `feed:explore:pool` | Sorted Set (score=engagement) | 300s | Global exploration candidate pool | Dev A |
| `feed:trending:global` | Sorted Set (score=trending_score) | 600s | Globally trending content | Dev A |

### Rate Limit Keys

| Key Pattern | Type | TTL | Description | Owner |
|-------------|------|-----|-------------|-------|
| `feed:ratelimit:{user_id}:fetch` | String (counter) | 60s | Feed fetch rate limit counter | Dev B |
| `feed:ratelimit:{user_id}:event` | String (counter) | 60s | Event track rate limit counter | Dev B |

---

## Key Size Limits

| Key Type | Max Value Size |
|----------|----------------|
| Feed slice (JSON) | 50 KB |
| Candidate pool (JSON) | 200 KB |
| Seen set | 5000 members max |
| Event queue | 10,000 entries max |

---

## Usage Rules

1. **Always use `EX` or `PX` option** when setting keys with TTL — never rely on default persistence.
2. **Never store PII** (email, phone, password) in Redis feed keys.
3. **Prefix isolation:** All feed-engine keys must start with `feed:`. No exceptions.
4. **Atomic operations:** Use MULTI/EXEC for writes that update multiple keys together.
5. **Keyspace notifications:** Do NOT enable for feed keys — too noisy.

---

## Deprecated Keys (Do NOT use)

| Key Pattern | Reason | Deprecated On |
|-------------|--------|---------------|
| *(none yet)* | — | — |
