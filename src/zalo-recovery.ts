export type RecoveryOptions = {
  baseMs: number;
  maxMs: number;
  timeoutMs: number;
  stableMs: number;
  random: () => number;
};
const defaults: RecoveryOptions = {
  baseMs: 2000,
  maxMs: 60000,
  timeoutMs: 30000,
  stableMs: 60000,
  random: Math.random,
};
/** Owns all reconnect timers. SDK retries are disabled to avoid competing listeners. */
export class ZaloRecovery {
  readonly state = {
    enabled: false,
    inProgress: false,
    attempts: 0,
    nextRetryAt: null as string | null,
    lastConnectedAt: null as string | null,
    lastDisconnectedAt: null as string | null,
    lastCloseCode: null as number | null,
    conflict: false,
    requiresLogin: false,
  };
  private retryTimer?: NodeJS.Timeout;
  private timeoutTimer?: NodeJS.Timeout;
  private stableTimer?: NodeJS.Timeout;
  private epoch = 0;
  private stopped = true;
  readonly options: RecoveryOptions;
  constructor(
    private readonly connect: (isCurrent: () => boolean) => Promise<void>,
    private readonly retire: () => void,
    private readonly report: (message: string) => void,
    options: Partial<RecoveryOptions> = {},
  ) {
    this.options = { ...defaults, ...options };
  }
  enable() {
    this.stopped = false;
    this.state.enabled = true;
    this.state.conflict = false;
    this.state.requiresLogin = false;
  }
  stop() {
    this.stopped = true;
    this.state.enabled = false;
    this.cancelAttempt();
    this.clearRetry();
    clearTimeout(this.stableTimer);
  }
  private clearRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.state.nextRetryAt = null;
  }
  private cancelAttempt() {
    ++this.epoch;
    clearTimeout(this.timeoutTimer);
    this.timeoutTimer = undefined;
    this.state.inProgress = false;
  }
  watchConnection() {
    if (this.stopped) return;
    const epoch = ++this.epoch;
    this.state.inProgress = true;
    this.armWatchdog(() => epoch === this.epoch && !this.stopped);
  }
  private armWatchdog(current: () => boolean) {
    clearTimeout(this.timeoutTimer);
    this.timeoutTimer = setTimeout(() => {
      if (!current()) return;
      this.cancelAttempt();
      this.retire();
      this.report("Kết nối Zalo quá thời gian chờ; sẽ tự thử lại.");
      this.schedule();
    }, this.options.timeoutMs);
    this.timeoutTimer.unref();
  }
  async retryNow() {
    if (this.stopped || !this.state.enabled || this.state.inProgress) return;
    this.clearRetry();
    const epoch = ++this.epoch;
    const current = () => epoch === this.epoch && !this.stopped;
    this.state.inProgress = true;
    this.state.attempts++;
    this.report("Đang phục hồi kết nối Zalo bằng phiên đã lưu…");
    this.armWatchdog(current);
    try {
      await this.connect(current);
      if (!current())
        return; /* Wait for connected event; watchdog covers socket handshake too. */
    } catch {
      if (!current()) return;
      this.cancelAttempt();
      this.retire();
      this.report(
        "Chưa phục hồi được phiên Zalo; sẽ tự thử lại. Có thể đăng nhập QR nếu phiên đã hết hạn.",
      );
      this.schedule();
    }
  }
  connected() {
    if (this.stopped) return;
    this.cancelAttempt();
    this.clearRetry();
    this.state.lastConnectedAt = new Date().toISOString();
    this.state.conflict = false;
    this.state.requiresLogin = false;
    clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      this.state.attempts = 0;
    }, this.options.stableMs);
    this.stableTimer.unref();
  }
  disconnected(code: number) {
    if (this.stopped) return;
    this.cancelAttempt();
    this.clearRetry();
    clearTimeout(this.stableTimer);
    this.state.lastDisconnectedAt = new Date().toISOString();
    this.state.lastCloseCode = code;
    if (code === 3000 || code === 3003) {
      this.state.conflict = code === 3000;
      this.state.requiresLogin = code === 3003;
      this.state.enabled = false;
      this.stopped = true;
      this.report(
        code === 3000
          ? "Zalo báo kết nối trùng (3000). Đóng Zalo Web hoặc bridge khác rồi bấm Kết nối lại."
          : "Zalo đã đá phiên (3003). Hãy đăng nhập lại bằng QR.",
      );
      return;
    }
    this.report(`Mất kết nối Zalo (${code}); hệ thống sẽ tự kết nối lại.`);
    this.schedule();
  }
  private schedule() {
    if (this.stopped || !this.state.enabled || this.retryTimer) return;
    const base = Math.min(
      this.options.maxMs,
      this.options.baseMs *
        2 ** Math.min(Math.max(this.state.attempts - 1, 0), 10),
    );
    const delay = Math.min(
      this.options.maxMs,
      Math.round(base * (1 + 0.2 * this.options.random())),
    );
    this.state.nextRetryAt = new Date(Date.now() + delay).toISOString();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.retryNow();
    }, delay);
    this.retryTimer.unref();
  }
}
