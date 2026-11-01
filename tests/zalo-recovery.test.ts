import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { EventEmitter } from "node:events";
import { ZaloRecovery } from "../src/zalo-recovery.js";
import { ZaloBridge } from "../src/zalo.js";
async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await delay(10);
  }
  assert.ok(condition(), "Condition timed out");
}
const fast = {
  baseMs: 10,
  maxMs: 40,
  timeoutMs: 100,
  stableMs: 1000,
  random: () => 0,
};
test("1006 triggers session reconnect and stable recovery resets attempts", async () => {
  let calls = 0;
  const r = new ZaloRecovery(
    async () => {
      calls++;
      r.connected();
    },
    () => {},
    () => {},
    { ...fast, stableMs: 20 },
  );
  try {
    r.enable();
    await r.retryNow();
    assert.equal(calls, 1);
    r.disconnected(1006);
    assert.ok(r.state.nextRetryAt);
    await until(() => calls === 2);
    assert.ok(r.state.lastConnectedAt);
    assert.equal(r.state.nextRetryAt, null);
    await until(() => r.state.attempts === 0);
  } finally {
    r.stop();
  }
});
test("network failures retry with bounded backoff and only one login at a time", async () => {
  let calls = 0,
    active = 0,
    max = 0;
  const r = new ZaloRecovery(
    async () => {
      calls++;
      active++;
      max = Math.max(max, active);
      await delay(2);
      active--;
      throw new Error("offline");
    },
    () => {},
    () => {},
    fast,
  );
  try {
    r.enable();
    await Promise.all([r.retryNow(), r.retryNow()]);
    await until(() => calls >= 3);
    assert.equal(max, 1);
    assert.ok(r.state.attempts >= 3);
    assert.ok(
      new Date(r.state.nextRetryAt || Date.now() + 40).getTime() - Date.now() <=
        45,
    );
  } finally {
    r.stop();
  }
});
test("duplicate/kicked session pauses retries until explicit action", async () => {
  for (const code of [3000, 3003]) {
    let calls = 0;
    const r = new ZaloRecovery(
      async () => {
        calls++;
        r.connected();
      },
      () => {},
      () => {},
      fast,
    );
    try {
      r.enable();
      await r.retryNow();
      r.disconnected(code);
      await delay(60);
      assert.equal(calls, 1);
      assert.equal(r.state.enabled, false);
      assert.equal(r.state.conflict, code === 3000);
      assert.equal(r.state.requiresLogin, code === 3003);
      assert.equal(r.state.nextRetryAt, null);
    } finally {
      r.stop();
    }
  }
});
test("watchdog fences late connection and stop cancels pending retries", async () => {
  let current: (() => boolean) | undefined,
    retired = 0,
    calls = 0;
  const r = new ZaloRecovery(
    async (valid) => {
      current = valid;
      calls++;
      await delay(60);
    },
    () => {
      retired++;
    },
    () => {},
    { ...fast, baseMs: 50, maxMs: 50, timeoutMs: 10 },
  );
  r.enable();
  const first = r.retryNow();
  await until(() => retired === 1);
  assert.equal(current!(), false);
  r.stop();
  await first;
  await delay(70);
  assert.equal(calls, 1);
  assert.equal(r.state.nextRetryAt, null);
});
test("bridge reuses stored credentials and discards callbacks from old listener", async () => {
  const apis: any[] = [];
  let logins = 0;
  const credentials = { cookie: "private", imei: "private", userAgent: "test" };
  const bridge = new ZaloBridge(
    () =>
      ({
        login: async (value: any) => {
          assert.equal(value, credentials);
          logins++;
          const listener: any = new EventEmitter();
          listener.start = (opts: any) => {
            assert.equal(opts.retryOnClose, false);
            listener.emit("connected");
          };
          listener.stop = () => {
            listener.stops = (listener.stops || 0) + 1;
          };
          const api = { listener, getOwnId: () => "12345" };
          apis.push(api);
          return api;
        },
      }) as any,
    20000,
    {
      loadSession: async () => credentials,
      recordEvent: async () => {},
      recovery: fast,
    },
  );
  try {
    await bridge.restore();
    assert.equal(bridge.status, "connected");
    apis[0].listener.emit("disconnected", 1006);
    assert.equal(bridge.status, "connecting");
    await until(() => logins === 2 && bridge.status === "connected");
    apis[0].listener.emit("closed", 1006);
    assert.equal(bridge.status, "connected");
    assert.equal(logins, 2);
    assert.equal(bridge.state().accountId, "12345");
  } finally {
    bridge.shutdown();
  }
});

test("shutdown fences saved-session loading before a late restore can log in", async () => {
  let resolve!: (value: any) => void,
    logins = 0;
  const loaded = new Promise((r) => {
    resolve = r;
  });
  const bridge = new ZaloBridge(
    () =>
      ({
        login: async () => {
          logins++;
        },
      }) as any,
    20000,
    { loadSession: () => loaded, recordEvent: async () => {}, recovery: fast },
  );
  const restoring = bridge.restore();
  bridge.shutdown();
  resolve({ cookie: "test" });
  await restoring;
  await delay(30);
  assert.equal(logins, 0);
  assert.equal(bridge.recovery.state.enabled, false);
});
test("shutdown while QR session is saving cannot reenable recovery", async () => {
  let callback: any,
    resolveLogin!: (api: any) => void,
    resolveSave!: () => void,
    saving = false,
    starts = 0,
    stops = 0;
  const saved = new Promise<void>((r) => {
    resolveSave = r;
  });
  const api = {
    listener: {
      start() {
        starts++;
      },
      stop() {
        stops++;
      },
    },
  };
  const bridge = new ZaloBridge(
    () =>
      ({
        loginQR: (_o: any, cb: any) => {
          callback = cb;
          return new Promise((r) => {
            resolveLogin = r;
          });
        },
      }) as any,
    20000,
    {
      saveSession: async () => {
        saving = true;
        await saved;
      },
      recordEvent: async () => {},
      recovery: fast,
    },
  );
  bridge.start();
  await until(() => !!callback);
  callback({ type: 4, data: { cookie: "test" }, actions: null });
  resolveLogin(api);
  await until(() => saving);
  bridge.shutdown();
  resolveSave();
  await delay(30);
  assert.equal(starts, 0);
  assert.ok(stops >= 1);
  assert.equal(bridge.recovery.state.enabled, false);
  assert.equal(bridge.recovery.state.nextRetryAt, null);
});

test("watchdog aborts HTTP login before the next recovery attempt", async () => {
  let calls = 0,
    active = 0,
    maxActive = 0;
  const bridge = new ZaloBridge(
    (signal) =>
      ({
        login: async () => {
          calls++;
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((_, reject) =>
            signal!.addEventListener(
              "abort",
              () => {
                active--;
                reject(new Error("cancelled"));
              },
              { once: true },
            ),
          );
        },
      }) as any,
    20000,
    {
      loadSession: async () => ({ cookie: "test" }),
      recordEvent: async () => {},
      recovery: { ...fast, timeoutMs: 10 },
    },
  );
  try {
    void bridge.restore();
    await until(() => calls >= 3);
    assert.equal(maxActive, 1);
  } finally {
    bridge.shutdown();
  }
});
