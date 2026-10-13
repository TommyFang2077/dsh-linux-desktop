const CHANNELS = ['desktop', 'desktopUpgrade', 'kernel']
let working = false
let checked = false
let checkFailed = false
let last
const revision = (version, linuxRevision) => linuxRevision ? `${version} · Linux r${linuxRevision}` : version
const target = status => CHANNELS.find(channel => status[channel]?.available)

function render(status) {
  const { desktop, kernel } = status
  const kernelNote = kernel.version !== desktop.version ? ` · 内核 ${kernel.version}` : ''
  document.getElementById('version').textContent = `当前版本：${revision(desktop.version, desktop.linuxRevision)}${kernelNote}`
  const channel = target(status)
  const state = channel && status[channel]
  document.getElementById('latest').textContent = state
    ? `可更新至：${channel === 'kernel' ? `内核 ${state.available}` : revision(state.available, state.availableLinuxRevision)}`
    : checked && !checkFailed ? '已是最新版本。' : ''
  for (const button of document.querySelectorAll('button')) {
    button.disabled = working || status.busy || (button.dataset.action === 'install' && !channel)
  }
  document.getElementById('status').textContent = status.busy ? (status.progress || '正在下载并校验，请稍候…')
    : status.restartRequired ? '内核已准备好，等待重启。' : status.notice
}

async function call(action, channel) {
  const result = await window.workbenchUpdates.invoke(action, channel)
  last = result.status
  return result
}

async function run(task, message) {
  working = true
  for (const button of document.querySelectorAll('button')) button.disabled = true
  document.getElementById('error').textContent = ''
  document.getElementById('status').textContent = message
  try { await task() } catch (error) { document.getElementById('error').textContent = error.message }
  working = false
  if (last) render(last)
}

async function check() {
  const errors = []
  await call('status')
  for (const channel of CHANNELS) {
    if (!last[channel]?.configured) continue
    const result = await call('check', channel)
    if (result.error && !last[channel].crossEpoch) errors.push(result.error)
  }
  checked = true
  checkFailed = !target(last) && errors.length > 0
  if (checkFailed) document.getElementById('error').textContent = errors[0]
}

async function install() {
  const result = await call('install', target(last))
  if (result.error) document.getElementById('error').textContent = result.error
}

for (const button of document.querySelectorAll('button')) {
  button.addEventListener('click', () => button.dataset.action === 'install'
    ? run(install, '处理中，下载和校验可能需要几分钟…') : run(check, '正在检查更新…'))
}
void run(check, '正在检查更新…')
setInterval(async () => {
  if (working) return
  try {
    const result = await window.workbenchUpdates.invoke('status')
    if (!working) { last = result.status; render(last) }
  } catch (error) { document.getElementById('error').textContent = error.message }
}, 1500)
