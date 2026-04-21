# Feature: Interest & Recommendation System (Phase 1)

This folder contains the context and implementation details for the Interest System, designed to power future recommendations and personalized content discovery.

## 🚀 Status
- **Schema**: Implemented in `schema.sql`.
- **Seeding**: Curated interests (8) seeded in DB.
- **Onboarding Integration**: Integrated into `onboarding.controller.js` (`saveInterests` endpoint).

## 📊 Interest Architecture
We use a **Weighted Cumulative Scoring** system to learn user preferences over time.

### Tables
| Table | Description |
| --- | --- |
| `interests` | Curated set of high-level topics (Design, AI, Tech, etc.). |
| `user_interests` | Junction table tracking the "strength" of a user's interest. |
| `interest_hashtags` | Bridge table connecting granular hashtags (e.g., `#react`) to high-level interests (e.g., `Tech`). |

### Scoring Strategy (Current)
| Source | Score | Purpose |
| --- | --- | --- |
| **Onboarding** | `+5.0` | Strong initial signal. |
| **Like** | `+3.0` | Explicit positive feedback. |
| **Search** | `+2.0` | Intent signal. |
| **View** | `+0.5` | Passive interest. |

> [!IMPORTANT]
> **Safety Cap**: All interest scores are capped at **100.0** to prevent inflation and ensure recommendations remain balanced.

## 🛠 Next Steps
When we return to this feature, we should:
1. **Connect Interactions**: Update the `postLikes` and `postViews` controllers to increment interest scores based on the post's hashtags.
2. **Build Feed Query**: Create a specialized feed endpoint that joins with `user_interests` and sorts by `score DESC`.
3. **Expand Seed Data**: Add more specific interest categories and hashtag mappings in `src/scripts/seed_interests.js`.

## 📂 Relevant Files
- `schema.sql`: Database definitions (bottom of file).
- `src/scripts/seed_interests.js`: Interest seeding logic.
- `src/modules/onboarding/onboarding.controller.js`: Entry point for onboarding signals.
