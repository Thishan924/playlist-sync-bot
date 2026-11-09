// Playlist sync control bot — Node.js long-polling entry point.
// v0.2.0: the same bot as the Workers webhook (src/index.js), but for
// hosts that run a long-lived Node process instead of a Worker, e.g.
// HidenCloud free tier (Node.js egg, weekly renewal, zip upload).
//   - Polls Telegram getUpdates (long polling, 30 s) — no webhook, no
//     public URL, no Cloudflare account needed.
//   - Last picked sync bot is remembered in a JSON file on disk
//     (STATE_FILE env, default ./data/state.json) instead of KV.
//   - Env vars (set in the host panel, never in code/chat):
//       TELEGRAM_BOT_TOKEN — new bot from @BotFather (not the NextDNS one)
//       GITHUB_PAT         — PAT scoped to the playlist repos, Actions: write
//       STATE_FILE         — optional, where the last-pick JSON lives
//   - Run: `node src/polling.js` (or `npm start`).
//   - On start it drains pending updates, so a restart never replays an
//     old /sync or a stale confirm button (no double dispatch).

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { handleUpdate, VERSION } from "./index.js";

// --- File-backed KV (same get/put shape as Cloudflare KV) -----------------
// Best-effort only, like the KV code in src/index.js: a missing or corrupt
// file just means "nothing remembered yet", never a crash. Writes are
// serialized and go through a temp file + rename, so a crash mid-write
// cannot leave a half-written state file behind.

export function createFileKV(filePath) {
  let cache = null;
  let writeQueue = Promise.resolve();

  async function load() {
    if (cache) return cache;
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      cache = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      cache = {};
    }
    return cache;
  }

  return {
    filePath,
    get: async (key) => {
      const store = await load();
      const value = store[key];
      return value === undefined ? null : value;
    },
    put: async (key, value) => {
      writeQueue = writeQueue.then(async () => {
        const store = await load();
        store[key] = value;
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const tmp = `${filePath}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(store, null, 2));
        await fs.rename(tmp, filePath);
      });
      return writeQueue;
    },
  };
}

export function createPollingEnv(overrides = {}) {
  return {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
    GITHUB_PAT: process.env.GITHUB_PAT || "",
    BOT_KV: createFileKV(
      process.env.STATE_FILE || path.join(process.cwd(), "data", "state.json"),
    ),
    ...overrides,
  };
}

// --- Polling --------------------------------------------------------------
// One getUpdates round. Returns the next offset (last update_id + 1).
// fetchImpl is injectable so tests can stub Telegram.

export async function pollOnce(env, offset, fetchImpl = fetch) {
  const url =
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates` +
    `?offset=${offset}&timeout=30`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(35000) });
  if (!res.ok) throw new Error(`getUpdates HTTP ${res.status}`);
  const data = await res.json();
  // Route every call handleUpdate makes (send/edit/answer, GitHub) through
  // the same fetch, so tests stub all of Telegram, not just getUpdates.
  const callEnv = { ...env, FETCH: fetchImpl };
  let next = offset;
  for (const update of data.result || []) {
    if (typeof update.update_id === "number") {
      next = Math.max(next, update.update_id + 1);
    }
    await handleUpdate(callEnv, update);
  }
  return next;
}

// Throw away updates that arrived while the bot was down, so a restart
// never replays them. Returns the offset to start polling from.

export async function drainPending(env, fetchImpl = fetch) {
  try {
    const url =
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates` +
      `?timeout=0`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return 0;
    const data = await res.json();
    const list = data.result || [];
    return list.length ? list[list.length - 1].update_id + 1 : 0;
  } catch (e) {
    console.log("[poll] drain failed, starting from 0:", e.message);
    return 0;
  }
}

export async function runPolling(
  env,
  {
    fetchImpl = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    onError = (e) => console.log("[poll]", e.message),
    shouldContinue = () => true,
  } = {},
) {
  let offset = await drainPending(env, fetchImpl);
  while (shouldContinue()) {
    try {
      offset = await pollOnce(env, offset, fetchImpl);
    } catch (e) {
      onError(e);
      await sleep(5000);
    }
  }
  return offset;
}

// --- Main -----------------------------------------------------------------

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is not set. Set it in the host panel.");
    process.exit(1);
  }
  const env = createPollingEnv();
  console.log(
    `playlist-sync-bot polling v${VERSION} starting (state: ${env.BOT_KV.filePath})…`,
  );
  let stopping = false;
  const stop = () => {
    if (!stopping) {
      stopping = true;
      console.log("Stopping…");
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await runPolling(env, { shouldContinue: () => !stopping });
  console.log("Stopped.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
