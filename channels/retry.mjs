/**
 * dsh-omnibridge 共享重试工具：指数退避 + 随机抖动。
 *
 * 之前 onebot / satori 固定间隔重连、telegram / weixin_oc 各自实现退避，
 * 统一收敛到这里（对齐 AstrBot「断网重连健壮性」演进项）：
 *  - backoffDelayMs：单次失败后的等待毫秒数（base × 2^attempt，封顶 + 抖动）
 *  - Reconnector：WS 断线重连调度器（失败排程退避、成功 reset、stop 关闭）
 *  - sleep / escapeRegExp：轮询与消息匹配的小工具
 *
 * @module dsh-omnibridge/channels/retry
 */

/** 默认退避封顶。 */
export const BACKOFF_CAP_MS = 30000

/**
 * 计算第 attempt 次连续失败后的等待毫秒数：
 * base × min(cap/base, 2^attempt) × 0.8~1.2 抖动，结果夹在 [base, cap]。
 * 抖动避免多实例同时断线后同步重连的"惊群"。
 */
export function backoffDelayMs(attempt, baseMs = 5000, capMs = BACKOFF_CAP_MS) {
  const base = Math.max(1, Math.floor(baseMs))
  const cap = Math.max(base, Math.floor(capMs))
  const factor = Math.min(cap / base, 2 ** Math.max(0, Math.floor(attempt)))
  const jitter = 0.8 + Math.random() * 0.4
  return Math.min(cap, Math.max(base, Math.floor(base * factor * jitter)))
}

/**
 * 重连调度器：schedule() 用 backoffDelayMs 排程下一次连接并递增 attempt，
 * 连接成功后调用 reset() 归零，stop 时 close()。
 */
export class Reconnector {
  constructor({ baseDelayMs = 5000, capMs = BACKOFF_CAP_MS } = {}) {
    this.baseDelayMs = Math.max(1, Math.floor(baseDelayMs))
    this.capMs = Math.max(this.baseDelayMs, Math.floor(capMs))
    this.attempt = 0
    this.timer = null
    this.closed = false
  }

  /** 排程连接回调；已关闭时忽略，已有挂起排程时幂等。 */
  schedule(connect) {
    if (this.closed || this.timer) return false
    const delay = backoffDelayMs(this.attempt++, this.baseDelayMs, this.capMs)
    this.timer = setTimeout(() => {
      this.timer = null
      connect()
    }, delay)
    this.timer.unref?.()
    return true
  }

  /** 连接成功后归零尝试计数。 */
  reset() {
    this.attempt = 0
  }

  /** 取消挂起排程并停止接受新排程。 */
  close() {
    this.closed = true
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }
}

/** unref 的 setTimeout promise 化（长轮询退避用）。 */
export function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })
}

/** 正则字面量转义（拼接 id/user 名等动态 pattern 前必用）。 */
export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
