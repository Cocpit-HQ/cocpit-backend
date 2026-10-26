const net = require("net");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

function parseRedisTarget() {
  let host = process.env.REDIS_HOST || "127.0.0.1";
  let port = parseInt(process.env.REDIS_PORT || "6380", 10);

  if (process.env.REDIS_URL) {
    try {
      const u = new URL(process.env.REDIS_URL);
      if (u.hostname) host = u.hostname;
      if (u.port) port = parseInt(u.port, 10);
    } catch {
      // Ignore malformed Redis URLs and use the host/port fallback.
    }
  }

  return { host, port };
}

function checkRedis(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let response = "";
    let resolved = false;

    socket.setTimeout(1200);

    socket.connect(port, host, () => {
      socket.write("INFO server\r\n");
    });

    socket.on("data", (data) => {
      response += data.toString();
      const match = response.match(/redis_version:([0-9.]+)/);
      if (match) {
        resolved = true;
        socket.destroy();
        resolve({ alive: true, version: match[1] });
      }
    });

    socket.on("timeout", () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve({ alive: false });
      }
    });

    socket.on("error", () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve({ alive: false });
      }
    });
  });
}

function findModernRedisExecutable() {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const wingetDir = path.join(localAppData, "Microsoft", "WinGet", "Packages");
    if (fs.existsSync(wingetDir)) {
      const entries = fs.readdirSync(wingetDir);
      for (const entry of entries) {
        if (entry.toLowerCase().includes("redis")) {
          const pkgPath = path.join(wingetDir, entry);
          const findExe = (dir) => {
            const files = fs.readdirSync(dir);
            for (const file of files) {
              const full = path.join(dir, file);
              const stat = fs.statSync(full);
              if (stat.isDirectory()) {
                const nested = findExe(full);
                if (nested) return nested;
              } else if (file.toLowerCase() === "redis-server.exe") {
                return full;
              }
            }
            return null;
          };
          try {
            const found = findExe(pkgPath);
            if (found) return found;
          } catch {
            // Ignore unreadable package directories and continue searching.
          }
        }
      }
    }
  }
  return null;
}

async function ensureRedis() {
  const { host, port } = parseRedisTarget();

  const status = await checkRedis(host, port);
  if (status.alive) {
    const major = parseInt(status.version.split(".")[0], 10);
    if (major >= 5) {
      console.log(`[RedisCheck] ✅ Redis v${status.version} is active on ${host}:${port}`);
      return;
    } else {
      console.warn(`[RedisCheck] ⚠️ Found Redis on ${host}:${port} but version is v${status.version} (< 5.0.0).`);
    }
  }

  // Not running or obsolete version, attempt to start modern local instance
  const exePath = findModernRedisExecutable();
  if (!exePath) {
    console.warn("[RedisCheck] Modern redis-server.exe not found in WinGet directory. Please ensure Redis >= 5 is running.");
    return;
  }

  console.log(`[RedisCheck] Starting modern Redis (port ${port}) via: ${exePath}`);
  const child = spawn(exePath, ["--port", String(port)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  // Poll until ready
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const probe = await checkRedis(host, port);
    if (probe.alive) {
      console.log(`[RedisCheck] ✅ Modern Redis v${probe.version} started successfully on ${host}:${port}`);
      return;
    }
  }

  console.warn(`[RedisCheck] ⚠️ Timed out waiting for Redis on ${host}:${port}. Proceeding anyway.`);
}

if (require.main === module) {
  ensureRedis().catch((err) => {
    console.error("[RedisCheck] Error:", err.message);
  });
}

module.exports = { ensureRedis, parseRedisTarget };
