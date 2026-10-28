const API_BASE = "https://api.cloudflare.com/client/v4";

function getStreamConfig() {
  return {
    accountId: process.env.CLOUDFLARE_STREAM_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_STREAM_API_TOKEN,
    customerCode: process.env.CLOUDFLARE_STREAM_CUSTOMER_CODE,
  };
}

function isStreamConfigured() {
  const { accountId, apiToken, customerCode } = getStreamConfig();
  return Boolean(accountId && apiToken && customerCode);
}

function getStreamPlaybackUrls(uid) {
  const { customerCode } = getStreamConfig();
  if (!customerCode || !uid) return { hlsUrl: null, dashUrl: null, thumbnailUrl: null };
  const base = `https://customer-${customerCode}.cloudflarestream.com/${encodeURIComponent(uid)}`;
  return {
    hlsUrl: `${base}/manifest/video.m3u8`,
    dashUrl: `${base}/manifest/video.mpd`,
    thumbnailUrl: `${base}/thumbnails/thumbnail.jpg`,
  };
}

async function streamRequest(path, { method = "GET", body } = {}) {
  const { accountId, apiToken } = getStreamConfig();
  if (!accountId || !apiToken) throw new Error("Cloudflare Stream is not configured.");
  const response = await fetch(`${API_BASE}/accounts/${encodeURIComponent(accountId)}/stream${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404 && method === "DELETE") return null;
  if (response.status === 204) return null;
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Cloudflare Stream returned HTTP ${response.status} without valid JSON.`);
  }
  if (!response.ok || payload.success === false) {
    const message = payload.errors?.map((error) => error.message).filter(Boolean).join("; ") || `HTTP ${response.status}`;
    throw new Error(`Cloudflare Stream request failed: ${message}`);
  }
  return payload.result;
}

async function createStreamVideoFromUrl({ url, creator, name }) {
  const result = await streamRequest("/copy", {
    method: "POST",
    body: {
      input: url,
      creator: creator ? String(creator).slice(0, 64) : undefined,
      meta: { name: String(name || "Cocpit upload").slice(0, 100) },
    },
  });
  if (!result?.uid) throw new Error("Cloudflare Stream did not return a video UID.");
  return { uid: result.uid, ...getStreamPlaybackUrls(result.uid) };
}

async function getStreamVideo(uid) {
  if (!uid) throw new Error("Cloudflare Stream video UID is required.");
  return streamRequest(`/${encodeURIComponent(uid)}`);
}

async function deleteStreamVideo(uid) {
  if (!uid) return;
  await streamRequest(`/${encodeURIComponent(uid)}`, { method: "DELETE" });
}

module.exports = {
  getStreamConfig,
  isStreamConfigured,
  getStreamPlaybackUrls,
  createStreamVideoFromUrl,
  getStreamVideo,
  deleteStreamVideo,
};
