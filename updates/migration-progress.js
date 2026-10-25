const stages = [
  ['waiting-parent', '关闭当前应用'], ['stopping-processes', '检查并停止占用进程'],
  ['backup', '备份应用与数据'], ['verifying-backup', '校验完整备份'],
  ['installing', '安装更新'], ['spawned', '启动并检查新版本'],
]
const phaseText = Object.fromEntries([...stages, ['prepared', '更新已校验，正在准备升级'],
  ['ready', '升级进程已就绪'], ['backup-verified', '备份已校验'], ['healthy', '升级完成，新版本已正常启动'],
  ['failed', '升级失败'], ['cancelled', '升级已取消']])
const element = id => document.getElementById(id)
let polling = false

function render({ report, reportPath }) {
  const finished = ['healthy', 'failed', 'cancelled'].includes(report.phase)
  element('title').textContent = report.phase === 'failed' ? '升级失败' : report.phase === 'healthy' ? '升级完成' : '正在升级'
  element('status').textContent = phaseText[report.phase] || report.phase
  element('error').textContent = report.error || ''
  element('recovery').textContent = report.recovery || ''
  element('fallback-error').textContent = report.fallbackError ? `原版本恢复启动失败：${report.fallbackError}` : ''
  element('report-path').textContent = `报告：${reportPath}`
  element('copy').textContent = report.phase === 'failed' ? '复制错误报告' : '复制升级报告'
  const observed = new Set((report.events || []).map(event => event.phase))
  const index = stages.findIndex(([phase]) => phase === (report.failedPhase || report.phase))
  element('progress').max = stages.length
  if (report.phase === 'healthy') element('progress').value = stages.length
  else if (index >= 0) element('progress').value = index
  else if (finished) element('progress').value = 0
  else element('progress').removeAttribute('value')
  element('stages').replaceChildren(...stages.map(([phase, label], position) => {
    const item = document.createElement('li')
    item.textContent = label
    item.className = phase === report.phase ? 'current' : report.phase === 'healthy' || observed.has(phase) && position < index ? 'done' : ''
    if (phase === report.phase) item.setAttribute('aria-current', 'step')
    return item
  }))
  element('processes').textContent = (report.processActions || []).map(action =>
    `进程 ${action.pid ?? '?'}：${action.action || ''}${action.result ? ` · ${action.result}` : ''}`).join('\n')
  element('close').textContent = finished ? '关闭' : '关闭窗口'
}

async function refresh() {
  if (polling) return
  polling = true
  try { render(await window.migrationProgress.invoke('status')) }
  catch (error) { element('title').textContent = '无法读取升级状态'; element('error').textContent = error.message }
  finally { polling = false }
}

for (const action of ['copy', 'open', 'close']) element(action).addEventListener('click', async () => {
  const button = element(action)
  button.disabled = true
  try {
    await window.migrationProgress.invoke(action)
    element('feedback').textContent = action === 'copy' ? '报告已复制。' : ''
  } catch (error) { element('feedback').textContent = error.message }
  finally { button.disabled = false }
})
void refresh()
setInterval(() => { void refresh() }, 250)
