# COCPIT Chat Security — 16 Manual Verification Tests (Backup & Run Guide)

This document provides complete, copy-pasteable manual tests for all chat security remediations implemented across `cocpit-backend`.

---

## Environment Setup & Variables

Replace the placeholder tokens and IDs before executing:

```bash
export BASE_URL="http://localhost:5000"

# User A (Legitimate Participant / Recipient)
export TOKEN_USER_A="Bearer eyJhbGciOi..."
export USER_A_ID="00000000-0000-0000-0000-000000000001"

# User B (Outsider / Attacker - Not a member of the group/chat/org)
export TOKEN_OUTSIDER="Bearer eyJhbGciOi..."
export OUTSIDER_ID="00000000-0000-0000-0000-000000000002"

# Test Entity IDs
export CONVERSATION_REQUEST_ID="11111111-1111-1111-1111-111111111111" # Pending 1-on-1 request where User A is recipient
export GROUP_CONVERSATION_ID="22222222-2222-2222-2222-222222222222"   # Private group where User A is member, Outsider is not
export VICTIM_ORG_ID="33333333-3333-3333-3333-333333333333"           # Organization where Outsider has NO active membership
export SAMPLE_MESSAGE_ID="44444444-4444-4444-4444-444444444444"       # Message in a chat where Outsider is not participant
```

---

## Test Scenarios Index

| Test # | Finding ID | Vulnerability / Attack Scenario                                            | Method & Endpoint                                          | Expected HTTP Status                        |
| ------ | ---------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| **01** | `VULN-10`  | Outsider attempts to decline another user's chat request                   | `PUT /api/conversations/:id/decline`                       | `403 Forbidden`                             |
| **02** | `VULN-10`  | Outsider attempts to force-accept another user's chat request              | `PUT /api/conversations/:id/accept`                        | `403 Forbidden`                             |
| **03** | `VULN-10`  | Request initiator attempts to accept their own pending chat request        | `PUT /api/conversations/:id/accept`                        | `400 Bad Request`                           |
| **04** | `VULN-11`  | Non-member requests private group shared content (media/docs exfiltration) | `GET /api/groups/:groupId/shared-content`                  | `403 Forbidden`                             |
| **05** | `VULN-11`  | Active group member fetches shared content                                 | `GET /api/groups/:groupId/shared-content`                  | `200 OK` (with presigned S3/R2 URLs)        |
| **06** | `VULN-06`  | Non-member requests private group details and member roster                | `GET /api/groups/:groupId`                                 | `403 Forbidden`                             |
| **07** | `VULN-06`  | Active group member fetches group details and roster                       | `GET /api/groups/:groupId`                                 | `200 OK`                                    |
| **08** | `CHAT-001` | User sends message with unowned `authorCompanyId` (Org Impersonation)      | `POST /api/social/messages`                                | `403 Forbidden`                             |
| **09** | `CHAT-002` | User attempts to list conversations for unowned `companyId`                | `GET /api/social/conversations?companyId=...`              | `403 Forbidden`                             |
| **10** | `CHAT-002` | User attempts to read message history for unowned `companyId`              | `GET /api/social/conversations/:id/messages?companyId=...` | `403 Forbidden`                             |
| **11** | `VULN-12`  | User attempts to delete conversation under unowned `companyId`             | `DELETE /api/social/conversations/:id`                     | `403 Forbidden`                             |
| **12** | `VULN-15`  | User attempts to pin/unpin message under unowned `companyId`               | `POST /api/social/messages/:id/pin`                        | `403 Forbidden`                             |
| **13** | `VULN-04`  | Non-participant attempts to delete a message for themselves                | `DELETE /api/messaging/messages/:id`                       | `403 Forbidden`                             |
| **14** | `VULN-05`  | Non-participant attempts to add a message reaction                         | `POST /api/social/messages/reaction`                       | `403 Forbidden`                             |
| **15** | `VULN-05`  | Participant submits invalid non-emoji or oversized string as reaction      | `POST /api/social/messages/reaction`                       | `400 Bad Request`                           |
| **16** | `VULN-07`  | Uploading disguised executable or malicious file (`.png` with script)      | `POST /api/messaging/upload-media`                         | `400 Bad Request` (File rejected & deleted) |

---

## Detailed Test Definitions & cURL Commands

---

### Test 01: VULN-10 — Outsider Declines Another User's Chat Request

**Description:** Verify that a malicious third-party caller cannot decline, drop, or shut down a conversation request intended for another user.

```bash
curl -i -X PUT "${BASE_URL}/api/conversations/${CONVERSATION_REQUEST_ID}/decline" \
  -H "Authorization: ${TOKEN_OUTSIDER}" \
  -H "Content-Type: application/json"
```

- **Expected Status:** `403 Forbidden`
- **Expected Body:**
  ```json
  {
    "message": "Forbidden: You are not authorized to respond to this chat request"
  }
  ```

---

### Test 02: VULN-10 — Outsider Force-Accepts Another User's Chat Request

**Description:** Verify that a malicious user cannot force-accept a chat request sent to someone else.

```bash
curl -i -X PUT "${BASE_URL}/api/conversations/${CONVERSATION_REQUEST_ID}/accept" \
  -H "Authorization: ${TOKEN_OUTSIDER}" \
  -H "Content-Type: application/json"
```

- **Expected Status:** `403 Forbidden`
- **Expected Body:**
  ```json
  {
    "message": "Forbidden: You are not authorized to respond to this chat request"
  }
  ```

---

### Test 03: VULN-10 — Initiator Attempts to Accept Their Own Pending Request

**Description:** Verify that the user who initiated the chat request cannot accept their own request.

```bash
curl -i -X PUT "${BASE_URL}/api/conversations/${CONVERSATION_REQUEST_ID}/accept" \
  -H "Authorization: ${TOKEN_USER_A}" \
  -H "Content-Type: application/json"
```

- **Expected Status:** `400 Bad Request`
- **Expected Body:**
  ```json
  {
    "message": "Cannot accept a request that you created"
  }
  ```

---

### Test 04: VULN-11 — Non-Member Group Shared Content Exfiltration

**Description:** Verify that an outsider who is not an active participant in a private group cannot access shared photos, documents, and media.

```bash
curl -i -X GET "${BASE_URL}/api/groups/${GROUP_CONVERSATION_ID}/shared-content" \
  -H "Authorization: ${TOKEN_OUTSIDER}"
```

- **Expected Status:** `403 Forbidden`
- **Expected Body:**
  ```json
  {
    "message": "Forbidden: You are not an active member of this group"
  }
  ```

---

### Test 05: VULN-11 & CHAT-003 — Group Member Shared Content Success (with Pre-signed URLs)

**Description:** Verify that a legitimate group member can retrieve shared content and that media URLs are generated via pre-signed S3/R2 links.

```bash
curl -i -X GET "${BASE_URL}/api/groups/${GROUP_CONVERSATION_ID}/shared-content" \
  -H "Authorization: ${TOKEN_USER_A}"
```

- **Expected Status:** `200 OK`
- **Expected Body:** JSON object containing `media`, `documents`, `links`. Any media URLs contain expiring signature query parameters (`X-Amz-Signature` or valid CDN link).

---

### Test 06: VULN-06 — Non-Member Group Details & Member Roster IDOR

**Description:** Verify that a non-member cannot scrape group metadata, descriptions, member names, or user roles.

```bash
curl -i -X GET "${BASE_URL}/api/groups/${GROUP_CONVERSATION_ID}" \
  -H "Authorization: ${TOKEN_OUTSIDER}"
```

- **Expected Status:** `403 Forbidden`
- **Expected Body:**
  ```json
  {
    "message": "You are not a member of this group"
  }
  ```

---

### Test 07: VULN-06 — Group Member Details Success

**Description:** Verify that an active group participant can view group information normally.

```bash
curl -i -X GET "${BASE_URL}/api/groups/${GROUP_CONVERSATION_ID}" \
  -H "Authorization: ${TOKEN_USER_A}"
```

- **Expected Status:** `200 OK`
- **Expected Body:** JSON containing `group_id`, `name`, `participants`, `description`.

---

### Test 08: CHAT-001 — Org Impersonation via `authorCompanyId` in `sendMessage`

**Description:** Verify that a user cannot send a chat message disguised as an organization without active membership in that company.

```bash
curl -i -X POST "${BASE_URL}/api/social/messages" \
  -H "Authorization: ${TOKEN_OUTSIDER}" \
  -H "Content-Type: application/json" \
  -d '{
    "targetUserId": "'"${USER_A_ID}"'",
    "authorCompanyId": "'"${VICTIM_ORG_ID}"'",
    "text_content": "Phishing message impersonating company"
  }'
```

- **Expected Status:** `403 Forbidden`
- **Expected Body:**
  ```json
  {
    "message": "Forbidden: You are not an active member of this organization"
  }
  ```

---

### Test 09: CHAT-002 — Org Conversations List IDOR

**Description:** Verify that a user cannot retrieve conversation lists belonging to an organization they do not belong to.

```bash
curl -i -X GET "${BASE_URL}/api/social/conversations?companyId=${VICTIM_ORG_ID}" \
  -H "Authorization: ${TOKEN_OUTSIDER}"
```

- **Expected Status:** `403 Forbidden`
- **Expected Body:**
  ```json
  {
    "message": "Forbidden: You are not an active member of this organization"
  }
  ```

---

### Test 10: CHAT-002 — Org Message History Snooping IDOR

**Description:** Verify that a user cannot read conversation messages scoped to an unauthorized company.

```bash
curl -i -X GET "${BASE_URL}/api/social/conversations/${GROUP_CONVERSATION_ID}/messages?companyId=${VICTIM_ORG_ID}" \
  -H "Authorization: ${TOKEN_OUTSIDER}"
```

- **Expected Status:** `403 Forbidden`
- **Expected Body:**
  ```json
  {
    "message": "Forbidden: You are not an active member of this organization"
  }
  ```

---

### Test 11: VULN-12 — Org Conversation Deletion IDOR

**Description:** Verify that a user cannot delete an entire company conversation without company membership.

```bash
curl -i -X DELETE "${BASE_URL}/api/social/conversations/${GROUP_CONVERSATION_ID}" \
  -H "Authorization: ${TOKEN_OUTSIDER}" \
  -H "Content-Type: application/json" \
  -d '{
    "companyId": "'"${VICTIM_ORG_ID}"'"
  }'
```

- **Expected Status:** `403 Forbidden`
- **Expected Body:**
  ```json
  {
    "message": "Forbidden: You are not an active member of this organization"
  }
  ```

---

### Test 12: VULN-15 — Org Pinned Message Hijacking IDOR

**Description:** Verify that a non-member cannot pin or unpin messages on behalf of an organization.

```bash
curl -i -X POST "${BASE_URL}/api/social/messages/${SAMPLE_MESSAGE_ID}/pin" \
  -H "Authorization: ${TOKEN_OUTSIDER}" \
  -H "Content-Type: application/json" \
  -d '{
    "companyId": "'"${VICTIM_ORG_ID}"'"
  }'
```

- **Expected Status:** `403 Forbidden`
- **Expected Body:**
  ```json
  {
    "message": "Forbidden: You are not an active member of this organization"
  }
  ```

---

### Test 13: VULN-04 — Broken Access Control in Delete Message ("Delete For Me")

**Description:** Verify that an outsider cannot call message deletion on messages in conversations they do not participate in.

```bash
curl -i -X DELETE "${BASE_URL}/api/messaging/messages/${SAMPLE_MESSAGE_ID}" \
  -H "Authorization: ${TOKEN_OUTSIDER}" \
  -H "Content-Type: application/json" \
  -d '{
    "deleteForEveryone": false
  }'
```

- **Expected Status:** `403 Forbidden`
- **Expected Body:**
  ```json
  {
    "message": "Forbidden: You are not an active participant in this conversation"
  }
  ```

---

### Test 14: VULN-05 — Non-Participant Reaction Injection

**Description:** Verify that an outsider cannot inject reactions into a conversation they are not part of.

```bash
curl -i -X POST "${BASE_URL}/api/social/messages/reaction" \
  -H "Authorization: ${TOKEN_OUTSIDER}" \
  -H "Content-Type: application/json" \
  -d '{
    "message_id": "'"${SAMPLE_MESSAGE_ID}"'",
    "emoji": "👍"
  }'
```

- **Expected Status:** `403 Forbidden`
- **Expected Body:**
  ```json
  {
    "message": "Forbidden: You are not an active participant in this conversation"
  }
  ```

---

### Test 15: VULN-05 — Malicious / Non-Emoji Reaction Sanitization

**Description:** Verify that a participant cannot submit HTML, malicious payloads, or strings longer than 8 characters as emoji reactions.

```bash
curl -i -X POST "${BASE_URL}/api/social/messages/reaction" \
  -H "Authorization: ${TOKEN_USER_A}" \
  -H "Content-Type: application/json" \
  -d '{
    "message_id": "'"${SAMPLE_MESSAGE_ID}"'",
    "emoji": "<script>alert(1)</script>"
  }'
```

- **Expected Status:** `400 Bad Request`
- **Expected Body:**
  ```json
  {
    "message": "Invalid emoji reaction"
  }
  ```

---

### Test 16: VULN-07 — File Type / Magic Byte Spoofing in Media Upload

**Description:** Verify that uploading a malicious script or binary disguised with a `.png` or `.jpg` extension is blocked and purged from storage.

```bash
# Create spoofed file with fake extension but malicious text
echo "<script>alert('XSS')</script>" > /tmp/fake_image.png

curl -i -X POST "${BASE_URL}/api/messaging/upload-media" \
  -H "Authorization: ${TOKEN_USER_A}" \
  -F "media=@/tmp/fake_image.png;type=image/png"
```

- **Expected Status:** `400 Bad Request`
- **Expected Body:**
  ```json
  {
    "message": "Invalid PNG: file signature does not match PNG format"
  }
  ```
- **Storage Check:** The temporary file is immediately unlinked and removed from `/uploads`.

---

## Quick-Check Command (Run All Jest Tests)

To verify all test suites programmatically:

```bash
cd cocpit-backend
npx jest src/security/chat/__tests__/ src/modules/messaging/__tests__/ src/modules/social/__tests__/
```

Expected output:

```
Test Suites: 6 passed, 6 total
Tests:       49 passed, 49 total
```
