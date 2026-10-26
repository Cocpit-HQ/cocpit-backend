const path = require("path");

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_POST_IMAGE_BYTES = 100 * 1024 * 1024;
const MAX_POST_MEDIA_COUNT = 12;

const IMAGE_MIME_BY_EXTENSION = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jpe": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

const VIDEO_MIME_BY_EXTENSION = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

const IMAGE_SIGNATURES = [
  { mime: "image/jpeg", matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", matches: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  { mime: "image/webp", matches: (b) => b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
  { mime: "image/avif", matches: (b) => b.length >= 12 && b.toString("ascii", 4, 8) === "ftyp" && /^(avif|avis)$/.test(b.toString("ascii", 8, 12)) },
  { mime: "image/heic", matches: (b) => b.length >= 12 && b.toString("ascii", 4, 8) === "ftyp" && /^(heic|heix|hevc|hevx|heif|mif1|msf1)$/.test(b.toString("ascii", 8, 12)) },
];

function expectedImageMime(filename, declaredMime = "") {
  const extensionMime = IMAGE_MIME_BY_EXTENSION[path.extname(filename || "").toLowerCase()];
  const normalized = String(declaredMime || "").toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  return normalized.startsWith("image/") ? normalized : extensionMime || "";
}

function detectImageMime(buffer) {
  const signature = IMAGE_SIGNATURES.find(({ matches }) => matches(buffer));
  return signature?.mime || null;
}

function validateImageBuffer(buffer, filename, declaredMime) {
  const detectedMime = detectImageMime(buffer);
  if (!detectedMime) throw new Error("Unsupported or invalid image content.");

  const expectedMime = expectedImageMime(filename, declaredMime);
  const isHeifFamily = (mime) => mime === "image/heic" || mime === "image/heif";
  const extensionMime = IMAGE_MIME_BY_EXTENSION[path.extname(filename || "").toLowerCase()];
  if (extensionMime && extensionMime !== detectedMime && !(isHeifFamily(extensionMime) && isHeifFamily(detectedMime))) {
    throw new Error("The file extension does not match its image content.");
  }
  if (expectedMime && expectedMime !== detectedMime && !(isHeifFamily(expectedMime) && isHeifFamily(detectedMime))) {
    throw new Error("The file content does not match its image type.");
  }

  return detectedMime;
}

function validateUploadBatch(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_POST_MEDIA_COUNT) {
    throw new Error(`Select between 1 and ${MAX_POST_MEDIA_COUNT} media files.`);
  }

  let totalImageBytes = 0;
  for (const file of files) {
    const name = String(file?.filename || file?.name || "");
    const size = Number(file?.size);
    const declaredType = String(file?.contentType || file?.type || "").toLowerCase();
    const type = expectedImageMime(name, declaredType);
    if (!name || !Number.isFinite(size) || size <= 0) throw new Error("Each upload must include a filename and positive size.");
    const videoMime = VIDEO_MIME_BY_EXTENSION[path.extname(name).toLowerCase()];
    if (videoMime) {
      if (declaredType && declaredType !== videoMime && declaredType !== "application/octet-stream") throw new Error(`The declared media type does not match ${name}.`);
      if (size > 100 * 1024 * 1024) throw new Error(`${name} exceeds the 100 MB video limit.`);
      continue;
    }
    if (IMAGE_MIME_BY_EXTENSION[path.extname(name).toLowerCase()] && declaredType.startsWith("video/")) throw new Error(`The declared media type does not match ${name}.`);
    if (type.startsWith("image/")) {
      const knownImageMime = Object.values(IMAGE_MIME_BY_EXTENSION).includes(type) || type === "image/jpg";
      if (!IMAGE_MIME_BY_EXTENSION[path.extname(name).toLowerCase()] && !knownImageMime) {
        throw new Error(`Unsupported image type: ${name}`);
      }
      if (size > MAX_IMAGE_BYTES) throw new Error(`${name} exceeds the 10 MB image limit.`);
      totalImageBytes += size;
    } else {
      throw new Error(`Unsupported media type: ${name}`);
    }
  }

  if (totalImageBytes > MAX_POST_IMAGE_BYTES) throw new Error("Images in a post may not exceed 100 MB total.");
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_POST_IMAGE_BYTES,
  MAX_POST_MEDIA_COUNT,
  expectedImageMime,
  detectImageMime,
  IMAGE_MIME_BY_EXTENSION,
  VIDEO_MIME_BY_EXTENSION,
  validateImageBuffer,
  validateUploadBatch,
};
