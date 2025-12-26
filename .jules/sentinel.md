## 2024-02-14 - Custom Rate Limiter Pattern
**Vulnerability:** Missing rate limiting on sensitive endpoints (`/login`, `/register`), exposing the application to brute-force attacks.
**Learning:** Adding dependencies like `express-rate-limit` requires approval. A custom, lightweight in-memory rate limiter can be implemented using a `Map` and `setInterval` for cleanup.
**Prevention:** Always apply rate limiting to authentication endpoints. Use `Map` for O(1) lookups and ensure periodic cleanup to prevent memory leaks.
