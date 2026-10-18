export const CHECK_INTERVAL = 6 * 60 * 60 * 1000
export const RETRY_INTERVAL = 5 * 60 * 1000

export async function requireIdle(inspect) {
  let active
  try { active = await inspect?.() } catch { throw new Error('无法确认任务状态，暂缓安装，请稍后重试。') }
  if (active !== false) throw new Error(active === true
    ? '有活动任务，暂缓安装；任务完成后请重试。' : '无法确认任务状态，暂缓安装，请稍后重试。')
}

export async function confirmUpdate({ manager, channel, inspect, confirm }) {
  const expected = JSON.stringify(manager.candidates[channel]?.release)
  if (!expected) throw new Error('请先检查更新')
  const refresh = async () => {
    if (channel === 'desktopUpgrade') await manager.checkWholeDesktopUpgrade()
    else await manager.check(channel)
    if (JSON.stringify(manager.candidates[channel]?.release) !== expected) throw new Error('更新目标已改变，请重新检查并确认')
    if (channel !== 'desktopUpgrade') await manager.prepareDownload(channel)
    await requireIdle(inspect)
  }
  await refresh()
  if (!await confirm()) return false
  await refresh()
  return true
}

/** Owns timing only. Installation is deliberately not a capability of this controller. */
export class AutomaticUpdates {
  constructor({ manager, run = operation => operation(), notify = () => {}, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { manager, run, notify, now, setTimer, clearTimer })
    this.running = false
    this.failures = 0
    this.notified = new Set()
    this.state = { nextCheck: null, errors: {} }
  }

  start() {
    if (this.running) return
    this.running = true
    void this.check()
  }

  stop() {
    this.running = false
    this.clearTimer(this.timer)
    this.state.nextCheck = null
  }

  check() {
    if (this.inFlight) return this.inFlight
    this.clearTimer(this.timer)
    this.inFlight = this.perform().finally(() => {
      this.inFlight = undefined
      if (!this.running) return
      const delay = this.failures ? Math.min(CHECK_INTERVAL, RETRY_INTERVAL * 2 ** Math.min(10, this.failures - 1)) : CHECK_INTERVAL
      this.state.nextCheck = this.now() + delay
      this.timer = this.setTimer(() => { void this.check() }, delay)
      this.timer?.unref?.()
    })
    return this.inFlight
  }

  async perform() {
    const errors = {}
    try {
      await this.run(async () => {
        for (const channel of ['kernel', 'desktop']) {
          if (!this.manager.status()[channel]?.configured) continue
          try {
            await this.manager.check(channel)
            if (!this.manager.status()[channel].available) continue
            await this.manager.prepareDownload(channel)
            const release = this.manager.candidates[channel].release
            const key = `${channel}:${release.asset.sha256}`
            if (this.running && !this.notified.has(key)) {
              this.notify(channel, release)
              this.notified.add(key)
            }
            // A ready kernel gets priority over the optional full desktop download.
            if (channel === 'kernel') break
          } catch (error) { errors[channel] = error.message }
        }
      })
    } catch (error) { errors.operation = error.message }
    this.failures = Object.keys(errors).length ? this.failures + 1 : 0
    this.state = { ...this.state, lastCheck: this.now(), errors }
  }
}
