const { validateUploadBatch } = require("./mediaValidation");
const { ownedPostRawKey } = require("../../core/infrastructure/postMediaKey");
const { getObjectMetadataFromR2, getPublicUrl } = require("../../core/infrastructure/r2.client");

/** Verify direct R2 upload tickets before the post transaction starts. */
async function verifyDirectPostUploads(items, userId, headObject = getObjectMetadataFromR2) {
  if (!Array.isArray(items) || !items.length) throw new Error("No uploads were provided.");
  if (items.some((item) => !item || typeof item !== "object" || !item.rawKey)) {
    throw new Error("Every media item in a new upload must include its upload ticket.");
  }
  validateUploadBatch(items);
  const videoCount = items.filter((item) => item.media_type === "video").length;
  if (videoCount > 1 || (videoCount && items.length > 1)) {
    throw new Error("A post may contain one video or up to 12 images.");
  }

  await Promise.all(items.map(async (item) => {
    const key = ownedPostRawKey(item.master_url, userId);
    if (!key || key !== item.rawKey || item.master_url !== getPublicUrl(key)) {
      throw new Error("Upload does not belong to this user.");
    }
    const actualSize = Number((await headObject(key))?.ContentLength);
    const maxBytes = item.media_type === "video" ? 100 : 10;
    if (!actualSize || actualSize > maxBytes * 1024 * 1024 || actualSize !== Number(item.size)) {
      throw new Error("Uploaded object is missing or its size does not match the upload ticket.");
    }
    const expectedMediaType = String(item.contentType || "").startsWith("video/") ? "video" : "image";
    if (item.media_type !== expectedMediaType) throw new Error("Upload media type does not match its ticket.");
  }));
}

module.exports = { verifyDirectPostUploads };
