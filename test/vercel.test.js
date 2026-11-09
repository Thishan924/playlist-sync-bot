import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import handler, { createHandler, createVercelEnv } from "../api/webhook.js";
import { createMemoryStore, dispatchTimeoutMs, VERSION } from "../src/index.js";

const chatId = 7933991754;
const token = "fake-token";

function mockReq({ method = "POST", body = null, headers = {} } = {}) {
  const stream = Readable.from(body === null ? [] : [Buffer.from(body, "utf8")]);
  stream.method = method;
  stream.headers = headers;
  return stream;
}

function mockRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers;
    },
    end(text) {
      res.body += text || "";
    },
  };
  return res;
}

async function call(h, req) {
  const res = mockRes();
  await h(req, res);
  return res;
}

function post(update, headers = {}) {
  return mockReq({
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(update),
  });
}

// Stub Telegram: every method records the call and answers OK.
function stubTelegram() {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

// Fresh env per test, with its own memory store so no test can see
// another test's remembered pick.
function envFor(overrides = {}) {
  return createVercelEnv({
    TELEGRAM_BOT_TOKEN: token,
    GITHUB_PAT: "",
    BOT_KV: createMemoryStore(),
    ...overrides,
  });
}

test("GET returns the health text with the version", async () => {
  const res = await call(createHandler(envFor()), mockReq({ method: "GET" }));
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Playlist sync control bot is running/);
  assert.match(res.body, new RegExp(`v${VERSION}`));
  assert.equal(VERSION, "0.3.3");
});

test("default export GET also returns the health text", async () => {
  const res = await call(handler, mockReq({ method: "GET" }));
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Playlist sync control bot is running/);
});

test("POST /help routes through handleUpdate and answers 200", async () => {
  const { calls, fetchImpl } = stubTelegram();
  const h = createHandler(envFor({ FETCH: fetchImpl }));
  const res = await call(
    h,
    post({ message: { chat: { id: chatId }, text: "/help" } }),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "OK");
  const sends = calls.filter((c) => c.url.includes("/sendMessage"));
  assert.equal(sends.length, 1);
  const body = JSON.parse(sends[0].opts.body);
  assert.equal(body.chat_id, chatId);
  assert.match(body.text, /\/sync/);
});

test("POST from another chat is ignored (allowed chat is 7933991754)", async () => {
  const { calls, fetchImpl } = stubTelegram();
  const h = createHandler(envFor({ FETCH: fetchImpl }));
  const res = await call(
    h,
    post({ message: { chat: { id: 123 }, text: "/help" } }),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "OK");
  assert.equal(calls.filter((c) => c.url.includes("/sendMessage")).length, 0);
});

test("POST with bad JSON returns 200 without crashing", async () => {
  const { calls, fetchImpl } = stubTelegram();
  const h = createHandler(envFor({ FETCH: fetchImpl }));
  const res = await call(
    h,
    mockReq({ method: "POST", body: "not json{" }),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "OK");
  assert.equal(calls.length, 0);
});

test("wrong webhook secret ignores the update; right secret lets it through", async () => {
  const { calls, fetchImpl } = stubTelegram();
  const env = envFor({
    TELEGRAM_WEBHOOK_SECRET: "s3cret",
    FETCH: fetchImpl,
  });
  const h = createHandler(env);
  const update = { message: { chat: { id: chatId }, text: "/help" } };
  const wrong = await call(
    h,
    post(update, { "x-telegram-bot-api-secret-token": "nope" }),
  );
  assert.equal(wrong.statusCode, 200);
  assert.equal(calls.filter((c) => c.url.includes("/sendMessage")).length, 0);
  const right = await call(
    h,
    post(update, { "x-telegram-bot-api-secret-token": "s3cret" }),
  );
  assert.equal(right.statusCode, 200);
  assert.equal(calls.filter((c) => c.url.includes("/sendMessage")).length, 1);
});

test("no storage at all: /sync asks to pick every time, no crash", async () => {
  const { calls, fetchImpl } = stubTelegram();
  // Literal env: no BOT_KV, no Upstash vars — the fresh in-memory
  // fallback of the storage shim. Nothing may be remembered.
  const env = {
    TELEGRAM_BOT_TOKEN: token,
    GITHUB_PAT: "",
    FETCH_TIMEOUT_MS: 8000,
    FETCH: fetchImpl,
  };
  const h = createHandler(env);
  const first = await call(h, post({ message: { chat: { id: chatId }, text: "/sync" } }));
  assert.equal(first.statusCode, 200);
  let sends = calls.filter((c) => c.url.includes("/sendMessage"));
  assert.match(JSON.parse(sends.at(-1).opts.body).text, /pick a bot/);
  // Picking a bot saves into a throwaway store; the next /sync still asks.
  await call(h, post({ message: { chat: { id: chatId }, text: "/sync cool" } }));
  sends = calls.filter((c) => c.url.includes("/sendMessage"));
  assert.match(JSON.parse(sends.at(-1).opts.body).text, /Dry run previews only/);
  await call(h, post({ message: { chat: { id: chatId }, text: "/sync" } }));
  sends = calls.filter((c) => c.url.includes("/sendMessage"));
  assert.match(JSON.parse(sends.at(-1).opts.body).text, /pick a bot/);
  assert.doesNotMatch(JSON.parse(sends.at(-1).opts.body).text, /remembered/);
});

test("Upstash backend remembers the pick across updates", async () => {
  const store = {};
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, opts });
    if (u.startsWith("https://upstash.example")) {
      const parts = new URL(u).pathname.split("/").filter(Boolean);
      if (parts[0] === "get") {
        const value = store[decodeURIComponent(parts[1])] ?? null;
        return new Response(JSON.stringify({ result: value }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (parts[0] === "set") {
        store[decodeURIComponent(parts[1])] = decodeURIComponent(parts[2]);
        return new Response(JSON.stringify({ result: "OK" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    if (u.includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(null, { status: 204 });
  };
  // Literal env: Upstash vars set, no BOT_KV — the shim must pick Upstash.
  const env = {
    TELEGRAM_BOT_TOKEN: token,
    GITHUB_PAT: "fake-pat",
    UPSTASH_REDIS_REST_URL: "https://upstash.example",
    UPSTASH_REDIS_REST_TOKEN: "fake-upstash-token",
    FETCH_TIMEOUT_MS: 8000,
    FETCH: fetchImpl,
  };
  const h = createHandler(env);
  // Pick Trending via the button: the shim must write it to Upstash.
  const pick = await call(
    h,
    post({
      callback_query: {
        id: "cb1",
        data: "pick:trending",
        from: { id: chatId },
        message: { chat: { id: chatId }, message_id: 99 },
      },
    }),
  );
  assert.equal(pick.statusCode, 200);
  assert.ok(
    calls.some((c) => c.url.includes("/set/last-sync-bot%3A7933991754/")),
    "expected an Upstash set call for the pick",
  );
  assert.ok(
    calls.some((c) => c.url.includes("/editMessageText")),
    "expected the button message to be edited",
  );
  // Next /sync must reuse the remembered pick from Upstash.
  await call(h, post({ message: { chat: { id: chatId }, text: "/sync" } }));
  const sends = calls.filter((c) => c.url.includes("/sendMessage"));
  assert.match(JSON.parse(sends.at(-1).opts.body).text, /remembered/);
  assert.match(JSON.parse(sends.at(-1).opts.body).text, /Trending Phonk/);
});

test("Upstash failures fall back to asking, never crash", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith("https://upstash.example")) {
      return new Response("error", { status: 500 });
    }
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const env = {
    TELEGRAM_BOT_TOKEN: token,
    GITHUB_PAT: "",
    UPSTASH_REDIS_REST_URL: "https://upstash.example",
    UPSTASH_REDIS_REST_TOKEN: "fake-upstash-token",
    FETCH_TIMEOUT_MS: 8000,
    FETCH: fetchImpl,
  };
  const h = createHandler(env);
  const res = await call(h, post({ message: { chat: { id: chatId }, text: "/sync" } }));
  assert.equal(res.statusCode, 200);
  const sends = calls.filter((u) => u.includes("/sendMessage"));
  assert.equal(sends.length, 1);
});

test("dispatch timeout is capped at 8s on the Vercel path", async () => {
  assert.equal(dispatchTimeoutMs({ FETCH_TIMEOUT_MS: 8000 }), 8000);
  assert.equal(dispatchTimeoutMs({}), 15000);
  assert.equal(dispatchTimeoutMs({ FETCH_TIMEOUT_MS: 200 }), 200);
  // Behavioural: a hanging GitHub call aborts at the cap and the bot
  // replies with a clean error instead of hanging past the 10 s limit.
  const hangingFetch = (url, opts = {}) =>
    new Promise((_, reject) => {
      opts.signal?.addEventListener("abort", () =>
        reject(new DOMException("The operation timed out.", "TimeoutError")),
      );
    });
  const { calls, fetchImpl } = stubTelegram();
  const env = {
    TELEGRAM_BOT_TOKEN: token,
    GITHUB_PAT: "fake-pat",
    BOT_KV: createMemoryStore(),
    FETCH_TIMEOUT_MS: 200,
    FETCH: async (url, opts = {}) => {
      // No extra push here: fetchImpl below already records the call, so
      // each Telegram call is counted exactly once.
      if (String(url).includes("api.github.com")) return hangingFetch(url, opts);
      return fetchImpl(url, opts);
    },
  };
  const h = createHandler(env);
  const start = Date.now();
  const res = await call(
    h,
    post({
      callback_query: {
        id: "cb2",
        data: "sync:dry:cool",
        from: { id: chatId },
        message: { chat: { id: chatId }, message_id: 7 },
      },
    }),
  );
  const elapsed = Date.now() - start;
  assert.equal(res.statusCode, 200);
  assert.ok(elapsed < 2000, `dispatch took ${elapsed} ms, expected < 2000 ms`);
  const edits = calls.filter((c) => c.url.includes("/editMessageText"));
  assert.equal(edits.length, 1);
});

test("createMemoryStore round-trips", async () => {
  const store = createMemoryStore();
  assert.equal(await store.get("k"), null);
  await store.put("k", "v");
  assert.equal(await store.get("k"), "v");
});

test("createVercelEnv reads process.env and defaults the timeout to 8000", () => {
  const env = createVercelEnv({ BOT_KV: createMemoryStore() });
  assert.equal(env.FETCH_TIMEOUT_MS, 8000);
  assert.equal(env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_BOT_TOKEN || "");
});
