import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFileKV, pollOnce, drainPending, runPolling } from "../src/polling.js";

const chatId = 7933991754;
const token = "fake-token";

async function tmpState() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "playlist-bot-"));
  return path.join(dir, "state.json");
}

// Stub Telegram: getUpdates returns queued updates, every other method
// records the call and answers OK.
function stubTelegram({ updatesByTimeout = {}, onCall = () => {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, opts });
    onCall(u, opts);
    if (u.includes("/getUpdates")) {
      const timeout = new URL(u).searchParams.get("timeout");
      const result = (updatesByTimeout[timeout] || []).slice();
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

function envFor(stateFile, overrides = {}) {
  return {
    TELEGRAM_BOT_TOKEN: token,
    GITHUB_PAT: "",
    BOT_KV: createFileKV(stateFile),
    ...overrides,
  };
}

test("file KV round-trips and survives a new instance", async () => {
  const file = await tmpState();
  const kv1 = createFileKV(file);
  assert.equal(await kv1.get("last-sync-bot:1"), null);
  await kv1.put("last-sync-bot:1", JSON.stringify({ id: "cool" }));
  assert.equal(await kv1.get("last-sync-bot:1"), JSON.stringify({ id: "cool" }));
  const kv2 = createFileKV(file);
  assert.equal(await kv2.get("last-sync-bot:1"), JSON.stringify({ id: "cool" }));
});

test("file KV missing/corrupt file returns null and recovers on put", async () => {
  const file = await tmpState();
  const kv1 = createFileKV(file);
  assert.equal(await kv1.get("x"), null);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "{not json");
  const kv2 = createFileKV(file);
  assert.equal(await kv2.get("x"), null);
  await kv2.put("x", "y");
  assert.equal(await kv2.get("x"), "y");
});

test("pollOnce delivers /help to the allowed chat only", async () => {
  const file = await tmpState();
  const { calls, fetchImpl } = stubTelegram({
    updatesByTimeout: {
      30: [
        { update_id: 10, message: { chat: { id: chatId }, text: "/help" } },
        { update_id: 11, message: { chat: { id: 123 }, text: "/help" } },
      ],
    },
  });
  const next = await pollOnce(envFor(file), 0, fetchImpl);
  assert.equal(next, 12);
  const sends = calls.filter((c) => c.url.includes("/sendMessage"));
  assert.equal(sends.length, 1);
  const body = JSON.parse(sends[0].opts.body);
  assert.equal(body.chat_id, chatId);
  assert.match(body.text, /\/sync/);
});

test("pollOnce handles a callback query: answers it, edits the message, remembers the pick", async () => {
  const file = await tmpState();
  const { calls, fetchImpl } = stubTelegram({
    updatesByTimeout: {
      30: [
        {
          update_id: 20,
          callback_query: {
            id: "cb1",
            data: "pick:trending",
            from: { id: chatId },
            message: { chat: { id: chatId }, message_id: 99 },
          },
        },
      ],
    },
  });
  const next = await pollOnce(envFor(file), 0, fetchImpl);
  assert.equal(next, 21);
  assert.ok(calls.some((c) => c.url.includes("/answerCallbackQuery")));
  const edits = calls.filter((c) => c.url.includes("/editMessageText"));
  assert.equal(edits.length, 1);
  const editBody = JSON.parse(edits[0].opts.body);
  assert.equal(editBody.message_id, 99);
  assert.match(editBody.text, /Trending Phonk/);
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(JSON.parse(saved[`last-sync-bot:${chatId}`]).id, "trending");
});

test("pollOnce with no updates returns the same offset", async () => {
  const file = await tmpState();
  const { fetchImpl } = stubTelegram({ updatesByTimeout: { 30: [] } });
  assert.equal(await pollOnce(envFor(file), 41, fetchImpl), 41);
});

test("drainPending returns last update_id + 1, or 0 when empty", async () => {
  const file = await tmpState();
  const { fetchImpl } = stubTelegram({
    updatesByTimeout: { 0: [{ update_id: 5 }, { update_id: 9 }] },
  });
  assert.equal(await drainPending(envFor(file), fetchImpl), 10);
  const { fetchImpl: emptyFetch } = stubTelegram({ updatesByTimeout: { 0: [] } });
  assert.equal(await drainPending(envFor(file), emptyFetch), 0);
});

test("runPolling drains pending updates on start and never replays them", async () => {
  const file = await tmpState();
  const { calls, fetchImpl } = stubTelegram({
    updatesByTimeout: {
      0: [{ update_id: 7, message: { chat: { id: chatId }, text: "/sync cool" } }],
      30: [{ update_id: 8, message: { chat: { id: chatId }, text: "/help" } }],
    },
  });
  let runs = 0;
  await runPolling(envFor(file), {
    fetchImpl,
    sleep: async () => {},
    shouldContinue: () => runs++ < 1,
  });
  const sends = calls.filter((c) => c.url.includes("/sendMessage"));
  assert.equal(sends.length, 1);
  // Only the new /help update was answered — the drained /sync cool
  // update was never delivered, so no Dry/Real choice was sent.
  assert.match(JSON.parse(sends[0].opts.body).text, /Playlist sync control bot — commands/);
  assert.doesNotMatch(JSON.parse(sends[0].opts.body).text, /Dry run previews only/);
});

test("runPolling stops when shouldContinue returns false", async () => {
  const file = await tmpState();
  const { fetchImpl } = stubTelegram({ updatesByTimeout: { 0: [], 30: [] } });
  const offset = await runPolling(envFor(file), {
    fetchImpl,
    sleep: async () => {},
    shouldContinue: () => false,
  });
  assert.equal(offset, 0);
});

test("runPolling backs off and continues after a getUpdates failure", async () => {
  const file = await tmpState();
  let n = 0;
  const errors = [];
  const fetchImpl = async (url) => {
    n++;
    if (String(url).includes("/getUpdates") && n <= 2) {
      return new Response("bad gateway", { status: 502 });
    }
    return new Response(JSON.stringify({ ok: true, result: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  let runs = 0;
  await runPolling(envFor(file), {
    fetchImpl,
    sleep: async () => {},
    onError: (e) => errors.push(e.message),
    shouldContinue: () => runs++ < 2,
  });
  assert.ok(errors.some((m) => /502/.test(m)));
});
