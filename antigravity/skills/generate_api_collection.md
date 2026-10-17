# Skill: generate_api_collection

## Purpose

Generate a production-grade Postman collection for backend APIs with:

* correct request bodies
* validation scenarios
* edge cases
* test scripts
* consistent structure for team usage

---

## Input Required

* API routes (e.g., POST /profile/experiences)
* Payload schema (fields + types)
* Validation rules
* Business logic constraints

---

## Output Requirements

### 1. Collection Structure
Collection Name: COCPIT API's
Collection UID: 48480759-1058b5f1-0ec7-41bc-abbd-e6a654111f53

Organize into folders:

* Core APIs
* Success Cases
* Validation Errors (422)
* Authorization Errors (404/401)
* Edge Cases

---

### 2. Request Generation Rules

For each API:

#### Include:

* Method (POST / PATCH / GET)
* URL
* Headers:

  * Content-Type: application/json
  * Authorization: Bearer {{token}}

#### Body:

* Valid JSON payload
* All required + optional fields
* Correct field naming (NO aliases)

---

### 3. Validation Rules (STRICT)

Always include test cases for:

* Missing required fields

* Invalid date ranges

* Conditional requirements:

  * If `end_current_role = true`
    → `end_current_role_id` REQUIRED
    → `end_current_role_date` REQUIRED
    → `end_current_role_date < start_date`

* Invalid UUID

* Unauthorized access

* Resource not found

---

### 4. Business Logic Rules

For Experience APIs:

* Only one current role per company
* Overlapping roles → WARNING (not blocking)
* end_date must be >= start_date
* start_date cannot be in future (optional warning)

---

### 5. Atomic Operation Handling

If API supports atomic operations:

Example:
POST /profile/experiences

Include payload variation:

{
"end_current_role": true,
"end_current_role_id": "uuid",
"end_current_role_date": "YYYY-MM-DD"
}

Test cases:

* missing id → 422
* invalid date → 422
* valid → 201 with:

  * experience
  * ended_experience

---

### 6. Response Validation (Postman Tests)

For each request include:

```javascript
pm.test("Status code is correct", function () {
  pm.response.to.have.status(200 || 201 || 422 || 404);
});

pm.test("Response structure valid", function () {
  const json = pm.response.json();
  pm.expect(json).to.be.an("object");
});
```

Additional checks:

* success → has `experience`
* atomic → has `ended_experience`
* error → has `message`

---

### 7. Edge Case Generation

Always include:

* end_date < start_date
* null values in required fields
* extremely long strings
* duplicate requests
* concurrent role scenarios

---

### 8. Output Format

Return:

1. Human-readable breakdown
2. Postman Collection JSON (v2.1 format)
3. Short documentation for team usage

---

## Constraints

* DO NOT assume fields — use only provided schema
* DO NOT skip validation scenarios
* DO NOT generate vague test cases
* ALWAYS include at least 5 failure cases per API
* ALWAYS include atomic flow tests if applicable

---

## Example Invocation

"Generate Postman collection for:
POST /profile/experiences
Supports atomic end_current_role
Include all validation and edge cases"
