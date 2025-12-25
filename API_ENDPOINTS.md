# API Documentation

This document outlines the API endpoints, their usage, and the authentication workflow for the platform.

## Base URL
All API routes are prefixed with `/api`.
- Local: `http://localhost:5000/api`

## Authentication Workflow
The system uses a **Dual-Token** authentication mechanism (JWT Access Token + Refresh Token).

1.  **Register**: User creates an account via `POST /auth/register`.
2.  **Login**: User logs in via `POST /auth/login`.
    -   **Response Body**: Returns an `accessToken` (valid 15m) and `user` info.
    -   **Response Cookie**: Sets a secure, httpOnly `refreshToken` cookie (valid 7 days).
3.  **Authenticated Requests**: Client sends `Authorization: Bearer <accessToken>` header for protected routes.
4.  **Refresh Token**: When the `accessToken` expires (401 Unauthorized), the client calls `POST /auth/refresh`.
    -   The server reads the `refreshToken` from the httpOnly cookie.
    -   Returns a new `accessToken` and rotates the `refreshToken` cookie.
5.  **Logout**: Call `POST /auth/logout` to clear the cookie and invalidate the session.

---

## Endpoints

### 1. Authentication (`/auth`)

| Method | Endpoint | Description | Auth Required | Body |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/register` | Register a new user | No | `{ email, password, fullName }` |
| `POST` | `/login` | Login user | No | `{ email, password }` |
| `POST` | `/refresh` | Refresh access token | No (Cookie) | None (uses `refreshToken` cookie) |
| `GET` | `/me` | Get current user info | Yes | - |
| `POST` | `/logout` | Logout user | No | - |

### 2. User Profiles (`/api`)

| Method | Endpoint | Description | Auth Required | Body |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/profile/:id` | Get user profile. Use `:id` = `me` for own profile. | Yes | - |
| `PUT` | `/profile` | Update profile info | Yes | `{ full_name, headline, location, about_text, open_to, availability, work_preference }` |
| `POST` | `/profile/experiences` | Add experience | Yes | `{ title, company_name, location, start_date, end_date, is_current, description }` |
| `POST` | `/profile/educations` | Add education | Yes | `{ school_name, degree, field_of_study, start_date, end_date, description }` |
| `POST` | `/profile/skills` | Add/link a skill | Yes | `{ name }` |

### 3. Jobs (`/api/jobs`)

| Method | Endpoint | Description | Auth Required | Body |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/` | List jobs (filters: title, location) | No | Query Params: `?title=...&location=...` |
| `GET` | `/:id` | Get job details | No | - |
| `POST` | `/` | Create job (Recruiter/Admin only) | Yes | `{ title, company_name, location, description, salary_range, work_mode, company_type }` |
| `POST` | `/:id/apply` | Apply for a job | Yes | - |
| `GET` | `/applications/me` | Get my applications | Yes | - |

### 4. Content (Feed & Stories) (`/api`)

| Method | Endpoint | Description | Auth Required | Body |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/feed` | Get posts feed | Yes | Query Params: `?category=...` |
| `POST` | `/posts` | Create a post | Yes | `{ content, category, visibility, media_urls: [] }` |
| `GET` | `/stories` | Get active stories | Yes | - |
| `POST` | `/stories` | Create a story | Yes | `{ media_url, media_type }` |
| `POST` | `/stories/:id/react` | React to a story | Yes | `{ reaction }` |

### 5. Events (`/api/events`)

| Method | Endpoint | Description | Auth Required | Body |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/` | List upcoming events | Yes | - |
| `POST` | `/` | Create event | Yes | `{ title, description, start_time, end_time, location, event_type, max_attendees }` |
| `POST` | `/:id/register` | Register for event | Yes | - |

### 6. Social (`/api`)

| Method | Endpoint | Description | Auth Required | Body |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/users/:id/follow` | Follow a user | Yes | - |
| `GET` | `/conversations` | Get my conversations | Yes | - |
| `POST` | `/conversations` | Start 1-on-1 conversation | Yes | `{ targetUserId }` |
| `POST` | `/conversations/:id/messages` | Send message | Yes | `{ text_content }` |
| `GET` | `/notifications` | Get notifications | Yes | - |

## Error Handling
Standard HTTP status codes are used:
- `200`: Success
- `201`: Created
- `400`: Bad Request (Validation error)
- `401`: Unauthorized (Missing/invalid token)
- `403`: Forbidden (Insufficient role or invalid refresh token)
- `404`: Not Found
- `409`: Conflict (e.g., Duplicate email or already applied)
- `500`: Internal Server Error
