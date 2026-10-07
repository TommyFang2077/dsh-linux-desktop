let working = false
function render(status) {
  for (const channel of ['kernel', 'desktop']) {
    const state = status[channel]
    const build = channel === 'desktop' ? ` · Linux 构建 r${state.linuxRevision}` : ''
    const availableBuild = channel === 'desktop' ? ` · Linux 构建 r${state.availableLinuxRevision}` : ''
    document.getElementById(`${channel}-version`).textContent = `当前版本：${state.version}${build}${state.available ? ` · 可用版本：${state.available}${availableBuild}` : ''}`
    document.getElementById(`${channel}-source`).textContent = state.configured ? '已配置独立签名更新源' : '尚未配置此通道的发布源与签名公钥'
    for (const button of document.querySelectorAll(`[data-channel="${channel}"]`)) {
      button.disabled = working || status.busy || !state.configured || (button.dataset.action === 'install' && !state.available)
    }
  }
  document.getElementById('status').textContent = status.busy ? (status.progress || '正在下载、校验或安装，请稍候…')
    : status.restartRequired ? '内核已准备好，等待重启。' : status.notice
}
async function invoke(action = 'status', channel) {
  working = true
  for (const button of document.querySelectorAll('button')) button.disabled = true
  document.getElementById('error').textContent = ''
  document.getElementById('status').textContent = action === 'status' ? '正在读取…' : '处理中，请稍候。下载和校验可能需要几分钟…'
  try {
    const result = await window.workbenchUpdates.invoke(action, channel)
    working = false
    render(result.status)
    if (result.error) document.getElementById('error').textContent = result.error
    else if (action === 'check' && !result.status[channel].available) document.getElementById('status').textContent = '当前通道没有更新版本。'
  } catch (error) {
    working = false
    document.getElementById('error').textContent = error.message
  }
}
for (const button of document.querySelectorAll('button')) button.addEventListener('click', () => invoke(button.dataset.action, button.dataset.channel))
void invoke()
setInterval(async () => {
  if (working) return
  try {
    const result = await window.workbenchUpdates.invoke('status')
    if (!working) render(result.status)
  } catch (error) { document.getElementById('error').textContent = error.message }
}, 1500)
