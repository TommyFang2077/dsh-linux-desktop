import { execFile, spawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const executable = '/opt/dsh-workbench/dsh-workbench'

export async function installedFormat(current, run = execute) {
  if (await realpath(current) !== executable) throw new Error('请先安装并启动 deb/rpm 系统版；不会从用户目录执行提权安装')
  for (const [format, command, args] of [
    ['deb', '/usr/bin/dpkg-query', ['-W', '-f=${db:Status-Status}', 'dsh-workbench']],
    ['rpm', '/usr/bin/rpm', ['-q', '--queryformat', '%{NAME}', 'dsh-workbench']],
  ]) {
    try {
      const { stdout } = await run(command, args, { timeout: 10_000 })
      if (stdout.trim() === (format === 'deb' ? 'installed' : 'dsh-workbench')) return format
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 1) throw error }
  }
  throw new Error('未找到已安装的 dsh-workbench deb/rpm 软件包')
}

export async function verifySystemHelper(helper, inspect = lstat) {
  if (helper !== '/opt/dsh-workbench/resources/app/workbench/install.py') throw new Error('提权安装器必须来自系统安装目录')
  for (let path = helper; ; path = dirname(path)) {
    const stat = await inspect(path)
    if (stat.uid !== 0 || (stat.mode & 0o022) || stat.isSymbolicLink()
      || (path === helper ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error('提权安装器及上级目录必须由 root 所有且不可被普通用户修改')
    }
    if (path === '/') return helper
  }
}

function authorizeInstall(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/pkexec', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', DISPLAY: process.env.DISPLAY ?? '',
        XAUTHORITY: process.env.XAUTHORITY ?? '', LANG: process.env.LANG ?? 'C.UTF-8' },
    })
    let diagnostic = ''
    child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-16_384) })
    child.once('error', reject)
    // Do not time out or kill a package manager during a privileged transaction.
    child.once('close', (code, signal) => code === 0 ? resolve()
      : reject(new Error(`系统授权或安装失败 (${code ?? signal})：${diagnostic}`)))
  })
}

export async function installSystemDesktop(artifact, resources) {
  const helper = await verifySystemHelper(join(resources, 'install.py'))
  if (!await artifact.prepareRestart()) return null
  await authorizeInstall(['/usr/bin/python3', '-I', helper, artifact.archive, artifact.format,
    artifact.version, String(artifact.linuxRevision), artifact.sha256, String(artifact.size)])
  await artifact.restart(executable)
  return { executable }
}
