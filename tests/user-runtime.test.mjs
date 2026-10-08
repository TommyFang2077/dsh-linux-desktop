import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const main = readFileSync(new URL('../build/upstream/apps/desktop/src/main.ts', import.meta.url), 'utf8')

test('desktop activation restarts the explicit new executable while kernel restart retains its default', () => {
  const line = main.split('\n').find(line => line.includes('restart: (execPath) =>'))
  assert.ok(line)
  let options, quits = 0
  const restart = runInNewContext(`({${line.trim()}}).restart`, {
    app: { relaunch: value => { options = value } }, quitWithoutConfirmation: () => { quits++ },
  })
  restart('/home/user/Applications/dsh-linux-desktop/versions/new/dsh-workbench')
  assert.equal(options.execPath, '/home/user/Applications/dsh-linux-desktop/versions/new/dsh-workbench')
  restart()
  assert.equal(options, undefined)
  assert.equal(quits, 0, 'Scheduling relaunch must not exit before archive/lock cleanup')
  const finishLine = main.split('\n').find(line => line.includes('finishRestart: () => {'))
  assert.ok(finishLine)
  const finish = runInNewContext(`({${finishLine.trim()}}).finishRestart`, { quitWithoutConfirmation: () => { quits++ } })
  finish()
  assert.equal(quits, 1)
})

test('packaged Linux Hosts advertise the actual selected kernel, not an assumed /opt tree', () => {
  const start = main.indexOf('{ ...hostEnvironment, DSH_CLIENT_VERSION: desktopClientVersion(),')
  const end = main.indexOf('}, onFailure,', start) + 1
  assert.ok(start >= 0 && end > start)
  const environment = runInNewContext(`(${main.slice(start, end)})`, {
    join, dirname, process: { platform: 'linux' }, app: { isPackaged: true,
      getAppPath: () => '/home/user/Applications/dsh-linux-desktop/versions/desktop/resources/app' },
    resources: { dsh: '/home/user/.config/dsh-workbench/updates/kernels/kernel/dsh' },
    hostEnvironment: { DSH_BASE: '/old/kernel' }, desktopClientVersion: () => '1.0.0',
  })
  assert.equal(environment.DSH_SURFACE, 'desktop')
  assert.equal(environment.DSH_BASE, '/home/user/.config/dsh-workbench/updates/kernels/kernel/dsh/node_modules/@deepseek-ai')
  assert.equal(environment.DSH_DESKTOP_INSTALL, '/home/user/Applications/dsh-linux-desktop/versions/desktop')
  const adapter = readFileSync(new URL('../updates/desktop.mjs', import.meta.url), 'utf8')
  assert.match(adapter, /else installed = await manager\.installDesktop\(options\.prepareRestart, artifact => installUserDesktop/)
  assert.doesNotMatch(adapter, /installSystemDesktop|installedFormat|system-install\.mjs/)
})
