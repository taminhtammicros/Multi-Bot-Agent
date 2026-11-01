import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  Zalo,
  LoginQRCallbackEventType as E,
  type LoginQRCallback,
} from "zca-js";
import { ZaloBridge } from "../src/zalo.js";
function fake() {
  let callback: LoginQRCallback | undefined,
    attempts = 0,
    aborts = 0;
  const client = {
    loginQR: (_options: unknown, cb: LoginQRCallback) => {
      callback = cb;
      attempts++;
      return new Promise((_, reject) => {
        client.reject = reject;
      });
    },
    login: async () => {
      throw new Error("not used");
    },
    reject: (_e: unknown) => {},
  };
  const bridge = new ZaloBridge(
    () => client as unknown as Pick<Zalo, "loginQR" | "login">,
  );
  return {
    bridge,
    get attempts() {
      return attempts;
    },
    get aborts() {
      return aborts;
    },
    emit(type: E, image = "test-image") {
      callback!({
        type,
        data: type === E.QRCodeGenerated ? { image } : null,
        actions: {
          abort() {
            aborts++;
            client.reject(new Error("aborted"));
          },
        },
      } as any);
    },
    client,
  };
}
test("QR lifecycle is idempotent, expires with specific error, and can retry", async () => {
  const f = fake();
  f.bridge.start();
  f.bridge.start();
  await delay(0);
  assert.equal(f.attempts, 1);
  f.emit(E.QRCodeGenerated);
  assert.equal(f.bridge.state().qr, "data:image/png;base64,test-image");
  assert.equal(f.bridge.status, "qr");
  f.emit(E.QRCodeScanned);
  assert.equal(f.bridge.status, "scanned");
  f.emit(E.QRCodeExpired);
  await delay(0);
  assert.equal(f.bridge.pending, false);
  assert.match(f.bridge.error!, /hết hạn/);
  assert.equal(f.bridge.qr, null);
  assert.equal(f.aborts, 1);
  f.bridge.start();
  await delay(0);
  assert.equal(f.attempts, 2);
  f.emit(E.QRCodeGenerated);
  assert.equal(f.bridge.status, "qr");
  f.emit(E.QRCodeDeclined);
  await delay(0);
  assert.match(f.bridge.error!, /từ chối/);
});
test("startup rejection allows a new attempt", async () => {
  const f = fake();
  f.bridge.start();
  await delay(0);
  f.client.reject(new Error("private upstream error"));
  await delay(0);
  assert.equal(f.bridge.status, "disconnected");
  assert.equal(f.bridge.pending, false);
  assert.ok(!f.bridge.error?.includes("private"));
  f.bridge.start();
  await delay(0);
  assert.equal(f.attempts, 2);
  f.emit(E.QRCodeExpired);
});
test("stalled QR generation times out and late callback is fenced", async () => {
  let cb: LoginQRCallback | undefined,
    aborts = 0;
  const bridge = new ZaloBridge(
    () =>
      ({
        loginQR: (_o: unknown, callback: LoginQRCallback) => {
          cb = callback;
          return new Promise(() => {});
        },
      }) as unknown as Pick<Zalo, "loginQR" | "login">,
    10,
  );
  bridge.start();
  await delay(30);
  assert.equal(bridge.pending, false);
  assert.equal(bridge.status, "disconnected");
  assert.match(bridge.error!, /chưa trả mã/);
  cb!({
    type: E.QRCodeGenerated,
    data: { image: "old" },
    actions: {
      abort() {
        aborts++;
      },
    },
  } as any);
  assert.equal(bridge.qr, null);
  assert.equal(aborts, 1);
});
