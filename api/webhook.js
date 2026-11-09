// Playlist sync control bot — Vercel serverless webhook entry point.
// v0.3.0: the same bot as the Workers webhook (src/index.js) and the Node
// long-polling entry (src/polling.js), but as a Vercel serverless function
// for hosts that run neither Workers nor a long-lived process.
//   - POST /api/webhook receives Telegram updates and routes them through
//     the shared handleUpdate, exactly like the Workers entry.
//   - GET returns a short health text (bot name + version).
//   - Env vars come from process.env (set in the Vercel dashboard, never
//     in code/chat): TELEGRAM_BOT_TOKEN, GITHUB_PAT, optional
//     TELEGRAM_WEBHOOK_SECRET, optional UPSTASH_REDIS_REST_URL +
//     UPSTASH_REDIS_REST_TOKEN for remembering the last picked bot.
//     Without Upstash there is no persistence across cold starts: the bot
//     just asks which bot every time (correct, just less convenient).
//   - Vercel Hobby kills functions at 10 s, so FETCH_TIMEOUT_MS is 8000:
//     a slow GitHub call returns a clean error reply instead of a hard
//     kill. The reply to Telegram is always 200, so Telegram never
//     retries an update.
//   - Deploy: link the repo in the Vercel dashboard (or `vercel`), set the
//     env vars above, and set the Telegram webhook to
//     https://<project>.vercel.app/api/webhook

import { handleUpdate, VERSION, createMemoryStore } from "../src/index.js";

// Module-level env: the in-memory fallback store (used only when neither
// Workers KV nor Upstash is configured) then survives warm invocations
// of this container, so a remembered pick lasts until the container is
// recycled. Tokens still come from process.env at cold start.
const memoryStore = createMemoryStore();

export function createVercelEnv(overrides = {}) {
  const env = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
    GITHUB_PAT: process.env.GITHUB_PAT || "",
    TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET || "",
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL || "",
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN || "",
    // Inside the Vercel Hobby 10 s limit (see timeoutMs in src/index.js).
    FETCH_TIMEOUT_MS: Number(process.env.FETCH_TIMEOUT_MS) || 8000,
    ...overrides,
  };
  // No Upstash configured -> remember picks in memory for this container.
  // (When Upstash IS configured, don't set BOT_KV: getStore prefers
  // BOT_KV when present, so setting it here would shadow Upstash.)
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    if (!env.BOT_KV) env.BOT_KV = memoryStore;
  }
  return env;
}

const vercelEnv = createVercelEnv();

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(text);
}

// Factory so tests can pass a stub env; the default export uses the
// module-level env above.
export function createHandler(env) {
  return async function handler(req, res) {
    if (req.method === "GET") {
      send(res, 200, `Playlist sync control bot is running (v${VERSION}).`);
      return;
    }
    if (req.method !== "POST") {
      send(res, 200, "OK");
      return;
    }
    let update;
    try {
      update = JSON.parse(await readBody(req));
    } catch {
      send(res, 200, "OK");
      return;
    }
    if (env.TELEGRAM_WEBHOOK_SECRET) {
      const secret = req.headers?.["x-telegram-bot-api-secret-token"];
      if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
        send(res, 200, "OK");
        return;
      }
    }
    try {
      await handleUpdate(env, update);
    } catch (e) {
      console.log("[vercel] handleUpdate failed:", e.message);
    }
    send(res, 200, "OK");
  };
}

export default createHandler(vercelEnv);
