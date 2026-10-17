# Chat: Word Document (.doc/.docx) Sharing — Mobile Integration Guide

**For:** iOS & Flutter Teams
**Bug Ref:** ID-274
**Date:** 2026-07-24
**Status:** ✅ Backend + DB live — mobile integration required

---

## Overview

Chat attachments (1:1 DMs and group chats) previously only accepted images,
video, and PDF. Word documents (`.doc` / `.docx`) were rejected outright by
the upload middleware. This has been fixed, and a second gap found during
testing was fixed alongside it: the backend never stored the original
filename of an attachment, so any "document" attachment (PDF included)
could only ever be displayed with a generic label — never the real file
name or a type-specific icon.

### What Changed at a Glance

| | Old (Legacy) | New |
|---|---|---|
| **Word docs in chat** | Rejected — `Invalid file format` error | Accepted, same as PDF |
| **Allowed mimetypes** | jpeg/png/webp/jpg, mp4/webm/quicktime, pdf | + `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| **`message_media` row shape** | `{ url, media_type }` | `{ url, media_type, filename }` |
| **Filename available?** | No — never stored | Yes, on all newly-sent attachments |
| **`media_type` values** | `image` \| `video` \| `document` (unchanged) | Same — **doc/docx still reports as `document`, same as PDF.** Use the filename's extension to tell them apart. |

**No endpoint URLs changed.** This is a payload/response-shape change on
the existing upload and message-read endpoints, not a new API surface.

---

## Endpoints Affected

### 1:1 DM — `POST /api/messages`

Multipart form fields (unchanged): `targetUserId`, `text_content`,
`shared_post_id`, `replyMessageId`, etc.

> **Important gotcha:** all attachment files — image, video, PDF, **and now
> doc/docx** — must be sent under the **same multipart field name:
> `images`**. This endpoint is wired as `multer.array("images", 10)` on the
> backend; it does not have separate `documents`/`videos` fields. Sending a
> file under any other field name will be rejected by multer. This was true
> before this change too — it's not new, but it's an easy mistake to make
> once you're adding doc/docx support, since it's tempting to assume a
> "documents" field exists here. It doesn't.

### Group Chat — `POST /api/groups/:groupId/messages`

This endpoint **does** have separate fields: `images`, `videos`, `documents`
(each `maxCount` capped). Either field works for any file type server-side
(the controller flattens all fields together before processing), but for
clarity/future-proofing, send doc/docx under `documents` here.

### Both endpoints — shared file-type/size validation

| | Value |
|---|---|
| **Allowed mimetypes** | `image/jpeg`, `image/png`, `image/webp`, `image/jpg`, `video/mp4`, `video/webm`, `video/quicktime`, `application/pdf`, `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| **Max file size** | 100MB per file |
| **Rejection response** | Non-2xx with message `"Invalid file format. Allowed: JPEG, PNG, WEBP, MP4, WebM, PDF, DOC, DOCX."` |

> Make sure your file picker's allowed-type filter (and any client-side
> pre-validation) includes `.doc`/`.docx` — otherwise users still won't be
> able to *select* the file even though the backend would now accept it.

---

## Response Shape — Reading Messages

### `GET /api/conversations/:conversationId/messages` (serves both DM and group history)

Each message's `media` array item now includes `filename`:

**Response 200 OK:**

```json
{
  "media": [
    {
      "url": "https://res.cloudinary.com/.../chat_documents/chat-...-Detailed_Feature_Report.docx",
      "media_type": "document",
      "filename": "Detailed_Feature_Report.docx"
    }
  ]
}
```

**Legacy rows (sent before this change):**

```json
{
  "media": [
    {
      "url": "https://res.cloudinary.com/.../chat_documents/chat-...-somefile",
      "media_type": "document",
      "filename": null
    }
  ]
}
```

> `filename` is `null`, not omitted, for historical rows — always
> null-check it, don't assume presence.

### Realtime socket event (new message)

Same shape — the socket payload for a newly sent message reuses the exact
same `media` array structure (`url`, `media_type`, `filename`), so no
separate handling is needed for the realtime path vs. the history-fetch
path.

---

## Distinguishing PDF vs. DOC vs. DOCX

`media_type` **only** tells you `"document"` — it does not distinguish
PDF from Word. Derive the specific type from `filename`'s extension:

```
filename.split('.').last.toLowerCase()  // "pdf" | "doc" | "docx"
```

If `filename` is `null` (legacy row), fall back to a generic
document icon/label — don't guess.

---

## Flutter Implementation

**File picker** — include Word mimetypes/extensions in your picker config:

```dart
final result = await FilePicker.platform.pickFiles(
  type: FileType.custom,
  allowedExtensions: [
    'jpg', 'jpeg', 'png', 'webp',
    'mp4', 'webm', 'mov',
    'pdf', 'doc', 'docx',
  ],
);
```

**Upload (DM endpoint — note the `images` field name for every file type):**

```dart
final formData = FormData.fromMap({
  'targetUserId': targetUserId,
  'text_content': textContent,
});
for (final file in pickedFiles) {
  formData.files.add(MapEntry(
    'images', // yes, even for a .docx — see gotcha above
    await MultipartFile.fromFile(file.path, filename: file.name),
  ));
}
await dio.post('/messages', data: formData);
```

**Model update:**

```dart
class MessageMedia {
  final String url;
  final String mediaType; // 'image' | 'video' | 'document'
  final String? filename;

  MessageMedia({required this.url, required this.mediaType, this.filename});

  factory MessageMedia.fromJson(Map<String, dynamic> json) => MessageMedia(
        url: json['url'] as String,
        mediaType: json['media_type'] as String,
        filename: json['filename'] as String?,
      );
}
```

**Icon/label selection (mirrors the web fix):**

```dart
String iconAssetFor(MessageMedia media) {
  final ext = media.filename?.split('.').last.toLowerCase();
  if (ext == 'doc' || ext == 'docx') {
    return 'assets/icons/google_docs.svg'; // blue Word/Docs icon
  }
  return 'assets/icons/pdf.svg'; // default/fallback, matches legacy behavior
}

String displayLabelFor(MessageMedia media) =>
    media.filename ?? 'Document';

String extensionLabelFor(MessageMedia media) {
  final ext = media.filename?.split('.').last.toUpperCase();
  return ext ?? 'PDF'; // fallback matches pre-fix default
}
```

---

## iOS (Swift) Implementation

**Document picker** — add Word UTTypes:

```swift
import UniformTypeIdentifiers

let types: [UTType] = [
    .jpeg, .png, .webP, .movie, .pdf,
    UTType(filenameExtension: "doc")!,
    UTType(filenameExtension: "docx")!,
]
let picker = UIDocumentPickerViewController(forOpeningContentTypes: types)
```

**Upload (DM endpoint — again, field name is always `images`):**

```swift
multipartFormData.append(
    fileData,
    withName: "images", // same field name for image/video/pdf/doc/docx
    fileName: originalFilename,
    mimeType: mimeType // e.g. "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)
```

**Model update:**

```swift
struct MessageMedia: Codable {
    let url: String
    let mediaType: String
    let filename: String?

    enum CodingKeys: String, CodingKey {
        case url
        case mediaType = "media_type"
        case filename
    }
}
```

**Icon/label selection:**

```swift
func iconAsset(for media: MessageMedia) -> String {
    let ext = media.filename?.split(separator: ".").last?.lowercased()
    if ext == "doc" || ext == "docx" {
        return "icon_google_docs"
    }
    return "icon_pdf" // default/fallback, matches legacy behavior
}

func displayLabel(for media: MessageMedia) -> String {
    media.filename ?? "Document"
}
```

---

## Error Handling Reference

| Scenario | What to do |
|---|---|
| Upload rejected with "Invalid file format..." | Check the file's actual mimetype matches the allowed list above — some OS file pickers report `.doc` as `application/octet-stream`; re-derive mimetype from the file extension client-side if needed before upload. |
| `filename` is `null` on a media item | Legacy row — show a generic "Document" label + default (PDF) icon, don't crash. |
| File > 100MB | Reject client-side before upload with a clear message; the backend will also reject it, but pre-validating saves the round trip. |

---

## What NOT to Change

- Endpoint URLs — unchanged.
- `media_type` enum values (`image`/`video`/`document`) — unchanged; do not
  expect a new `"word"` or `"docx"` value.
- Non-chat upload endpoints (resume, job application, organization
  verification) — already supported Word docs before this change, not
  touched by this fix.

---

## Integration Checklist

### iOS
- [ ] Add Word UTTypes to document picker
- [ ] Confirm multipart field name is `images` for the DM (`/api/messages`) endpoint regardless of file type
- [ ] Use `documents` field for group chat attachments (optional but recommended)
- [ ] Add `filename` to your `MessageMedia` model (nullable)
- [ ] Derive doc/docx vs. PDF from `filename` extension, not `media_type`
- [ ] Handle `filename: null` on legacy rows with a generic fallback
- [ ] Add a Word/Google-Docs-style icon asset for `.doc`/`.docx`

### Flutter
- [ ] Add `doc`/`docx` to file picker's `allowedExtensions`
- [ ] Confirm multipart field name is `images` for the DM (`/messages`) endpoint regardless of file type
- [ ] Use `documents` field for group chat attachments (optional but recommended)
- [ ] Add `filename` to your `MessageMedia` model (nullable)
- [ ] Derive doc/docx vs. PDF from `filename` extension, not `media_type`
- [ ] Handle `filename: null` on legacy rows with a generic fallback
- [ ] Add a Word/Google-Docs-style icon asset for `.doc`/`.docx`

---

## Reference — Web Implementation

For a working reference implementation of everything above, see the web
client's changes in `cocpit-frontend`:
- `src/features/messaging/components/ui/MessageBubble.tsx` — icon/label
  selection logic (`selfhst:google-docs` for Word, `material-icon-theme:pdf`
  as default/fallback)
- `src/lib/mappers/messaging.mapper.ts` — `filename` threaded through the
  message mapper
- `src/types/messaging.ts` — updated `media` type shape
