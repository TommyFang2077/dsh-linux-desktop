import * as fs from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'

const within = (root, path) => path === root || path.startsWith(root + sep)
const gone = error => ['ENOENT', 'ESRCH'].includes(error.code)
const same = (left, right) => left.pid === right.pid && left.startTime === right.startTime && left.bootId === right.bootId

export async function processIdentity(pid) {
  const contents = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
  const fields = contents.slice(contents.lastIndexOf(')') + 2).trim().split(/\s+/)
  return { pid, state: fields[0], parentPid: Number(fields[1]), startTime: fields[19],
    bootId: (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() }
}

export async function originalAlive(identity) {
  try {
    const actual = await processIdentity(identity.pid)
    return actual.state !== 'Z' && same(actual, identity)
  } catch (error) { if (gone(error)) return false; throw error }
}

async function processes() {
  const result = []
  for (const name of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      if ((await fs.stat(`/proc/${name}`)).uid !== process.getuid()) continue
      const identity = await processIdentity(Number(name))
      if (identity.state !== 'Z') result.push(identity)
    } catch (error) { if (!gone(error)) throw error }
  }
  return result
}

function descendants(all, seeds) {
  let found = all.filter(actual => seeds.some(seed => same(actual, seed)))
  while (true) {
    const next = all.filter(actual => found.some(parent => actual.parentPid === parent.pid) && !found.some(item => same(item, actual)))
    if (!next.length) return found
    found = [...found, ...next]
  }
}

async function command(pid) {
  return (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean)
}

async function sameDataHome(pid, dshHome) {
  const environment = (await fs.readFile(`/proc/${pid}/environ`, 'utf8')).split('\0')
  const value = key => environment.find(entry => entry.startsWith(`${key}=`))?.slice(key.length + 1)
  const configured = value('DSH_HOME') || (value('HOME') && join(value('HOME'), '.dsh'))
  if (!configured) return false
  let actual = resolve(configured)
  try { actual = await fs.realpath(actual) } catch (error) { if (!gone(error)) throw error }
  return within(dshHome, actual) || within(actual, dshHome)
}

// Only the actual Node entry is authoritative; a dsh-looking argument is not permission to signal.
async function dshEntry(pid) {
  const args = await command(pid)
  if (!args[1]?.startsWith('/')) return false
  const executable = await fs.readlink(`/proc/${pid}/exe`)
  if (!/^node(?:js)?$/.test(executable.split('/').at(-1))) return false
  const entry = await fs.realpath(args[1])
  for (const [name, file] of [['@deepseek-ai/dsh', 'lib/bin.js'], ['@deepseek-ai/dsh-desktop-host', 'lib/index.js']]) {
    const directory = dirname(dirname(entry))
    if (entry !== join(directory, file)) continue
    try {
      if (JSON.parse(await fs.readFile(join(directory, 'package.json'), 'utf8')).name === name) return { executable, entry: args[1] }
    }
    catch (error) { if (!gone(error)) throw error }
  }
  return false
}

/** Capture before Host shutdown so orphaned bundled helpers remain identifiable afterwards. */
async function ownedHelper(identity, request) {
  const executable = await fs.readlink(`/proc/${identity.pid}/exe`)
  const node = await fs.realpath(request.node)
  const installation = dirname(request.oldExecutable)
  if (executable !== node && !within(join(installation, 'resources/runtime'), executable)
    && !(request.activeRuntime && within(request.activeRuntime, executable))) return false
  const args = await command(identity.pid)
  if (!args[1]?.startsWith('/')) return false
  const entry = await fs.realpath(args[1])
  if ((within(join(installation, 'resources/app'), entry) || within(request.dshHome, entry)
    || (request.activeDsh && within(request.activeDsh, entry))) && await sameDataHome(identity.pid, request.dshHome)) {
    return { executable, entry: args[1] }
  }
  return false
}

export async function captureMigrationProcesses(request, seeds) {
  const all = await processes()
  const family = descendants(all, seeds ?? [await processIdentity(process.pid)])
  const result = []
  for (const identity of family) {
    if ((seeds ?? []).some(seed => same(seed, identity)) || identity.pid === process.pid) continue
    try {
      if (await ownedHelper(identity, request)) result.push(identity)
    } catch (error) { if (!gone(error) && error.code !== 'EACCES') throw error }
  }
  return result
}

// pidfds bind both signals to the inspected process, including across PID reuse and reparenting.
const signalProcesses = `import json, os, select, signal, sys
request = json.load(sys.stdin)
boot = open('/proc/sys/kernel/random/boot_id').read().strip()
def identity(pid):
    text = open('/proc/%s/stat' % pid).read()
    fields = text[text.rfind(')') + 2:].split()
    return fields[0], fields[19]
def matches(target):
    pid = target['pid']
    try:
        state, start = identity(pid)
        valid = state != 'Z' and start == target['startTime'] and boot == target['bootId'] and os.stat('/proc/%s' % pid).st_uid == os.getuid()
        if target.get('executable'):
            args = open('/proc/%s/cmdline' % pid, 'rb').read().decode().split('\\0')
            valid = valid and os.readlink('/proc/%s/exe' % pid) == target['executable'] and len(args) > 1 and args[1] == target['entry']
            environment = dict(item.split('=', 1) for item in open('/proc/%s/environ' % pid, 'rb').read().decode().split('\\0') if '=' in item)
            configured = environment.get('DSH_HOME') or os.path.join(environment.get('HOME', ''), '.dsh')
            actual, expected = os.path.realpath(configured), target['dshHome']
            valid = valid and (actual == expected or actual.startswith(expected + '/') or expected.startswith(actual + '/'))
    except FileNotFoundError:
        valid = False
    return valid

def send(target, fd, signum):
    if not matches(target):
        if select.select([fd], [], [], 0)[0]:
            return
        raise RuntimeError('Process identity changed; refusing further signals: PID %s' % target['pid'])
    try:
        signal.pidfd_send_signal(fd, signum)
    except ProcessLookupError:
        pass

handles = []
try:
    for target in request['targets']:
        try:
            fd = os.pidfd_open(target['pid'])
        except ProcessLookupError:
            continue
        handles.append((target, fd))
        if not matches(target):
            os.close(fd)
            handles.pop()
    for target, fd in handles:
        send(target, fd, signal.SIGTERM)
    deadline = __import__('time').monotonic() + 5
    pending = handles[:]
    while pending and __import__('time').monotonic() < deadline:
        pending = [(target, fd) for target, fd in pending if not select.select([fd], [], [], 0)[0]]
        if pending:
            select.select([fd for target, fd in pending], [], [], 0.1)
    for target, fd in pending:
        send(target, fd, signal.SIGKILL)
    deadline = __import__('time').monotonic() + 2
    remaining = handles[:]
    while remaining and __import__('time').monotonic() < deadline:
        remaining = [(target, fd) for target, fd in remaining if not select.select([fd], [], [], 0)[0]]
        if remaining:
            select.select([fd for target, fd in remaining], [], [], 0.1)
    if remaining:
        raise RuntimeError('Process did not exit after TERM/KILL: PID %s' % remaining[0][0]['pid'])
    print(json.dumps([dict(pid=target['pid'], action='SIGKILL' if (target, fd) in pending else 'SIGTERM', result='exited') for target, fd in handles]))
finally:
    for target, fd in handles:
        os.close(fd)
`

export async function stopProcesses(python, targets) {
  if (!targets.length) return []
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-I', '-c', signalProcesses], { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', errors = ''
    child.stdout.on('data', bytes => { output += bytes })
    child.stderr.on('data', bytes => { errors = (errors + bytes).slice(-8_000) })
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error) })
    child.once('error', reject)
    child.once('close', code => {
      if (code !== 0) return reject(new Error(`无法安全停止升级相关进程（pidfd）：${errors || `退出码 ${code}`}`))
      try { resolve(JSON.parse(output)) } catch (error) { reject(error) }
    })
    child.stdin.end(JSON.stringify({ targets }))
  })
}

/** Unknown writers remain the responsibility of the fail-closed writer inspector. */
export async function stopMigrationProcesses(transaction, notify) {
  const all = await processes()
  let protectedProcesses = descendants(all, [await processIdentity(process.pid), transaction.progressIdentity].filter(Boolean))
  let current = await processIdentity(process.pid)
  while (current.parentPid > 0) {
    current = all.find(item => item.pid === current.parentPid)
    if (!current) break
    protectedProcesses = [...protectedProcesses, current]
  }
  const owned = transaction.shutdownProcesses ?? []
  const candidates = []
  for (const identity of all) {
    if (protectedProcesses.some(item => same(item, identity))) continue
    try {
      let authorization = owned.some(item => same(item, identity)) && await ownedHelper(identity, transaction)
      if (!authorization) {
        const entry = await dshEntry(identity.pid)
        if (entry && await sameDataHome(identity.pid, transaction.dshHome)) authorization = entry
      }
      if (authorization) candidates.push({ ...identity, ...authorization, dshHome: transaction.dshHome })
    } catch (error) { if (!gone(error) && error.code !== 'EACCES') throw error }
  }
  if (!candidates.length) return []
  if (candidates.length > 256) throw new Error('Too many upgrade-related processes; refusing an unbounded shutdown')
  await notify(candidates.map(item => ({ pid: item.pid, action: 'SIGTERM', result: 'waiting' })))
  const result = await stopProcesses(transaction.python ?? join(dirname(transaction.node), '../../python/bin/python3'), candidates)
  await notify(result)
  return result
}

const fail = message => { throw new Error(message) }

export async function assertNoWriters(roots, inodes = new Set()) {
  for (const name of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue
    const processPath = `/proc/${name}`
    let dsh = false
    try {
      if ((await fs.stat(processPath)).uid !== process.getuid()) continue
      if ((await processIdentity(Number(name))).state === 'Z') continue
      const command = (await fs.readFile(join(processPath, 'cmdline'), 'utf8')).split('\0').filter(Boolean)
      dsh = command.some(value => /(^|\/)(dsh|dsh-desktop-host|dsh\.mjs)(\/|$)/.test(value))
      if (dsh) {
        // Classify a known CLI by its effective DSH_HOME; unrelated isolated roots do not share data.
        const environment = (await fs.readFile(join(processPath, 'environ'), 'utf8')).split('\0')
        const value = key => environment.find(entry => entry.startsWith(`${key}=`))?.slice(key.length + 1)
        const configured = value('DSH_HOME') || (value('HOME') && join(value('HOME'), '.dsh'))
        if (!configured) fail(`Shared DSH process has an unknown data root: PID ${name}`)
        let actual = resolve(configured)
        try { actual = await fs.realpath(actual) } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (roots.some(root => within(root, actual) || within(actual, root))) fail(`Shared DSH process must be closed before migration: PID ${name}`)
      }
      for (const descriptor of await fs.readdir(join(processPath, 'fd'))) {
        try {
          const target = (await fs.readlink(join(processPath, 'fd', descriptor))).replace(/ \(deleted\)$/, '')
          const info = await fs.stat(join(processPath, 'fd', descriptor), { bigint: true })
          if (!roots.some(root => within(root, target)) && !inodes.has(`${info.dev}:${info.ino}`)) continue
          const fdinfo = await fs.readFile(join(processPath, 'fdinfo', descriptor), 'utf8')
          const flags = /^flags:\s+([0-7]+)/m.exec(fdinfo)
          if (!flags || (parseInt(flags[1], 8) & 3)) fail(`Data writer must be closed before migration: PID ${name}`)
        } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error }
      }
      const mappings = await fs.readFile(join(processPath, 'maps'), 'utf8')
      for (const line of mappings.split('\n')) {
        if (!line) continue
        const mapping = /^[\da-fA-F]+-[\da-fA-F]+\s+([r-][w-][x-][ps])\s+[\da-fA-F]+\s+([\da-fA-F]{1,8}):([\da-fA-F]{1,8})\s+(\d{1,20})(?:\s+([^\n]*))?$/.exec(line)
        if (!mapping) fail(`Malformed process memory mapping: PID ${name}`)
        if (mapping[1][1] !== 'w' || mapping[1][3] !== 's') continue
        const major = BigInt(`0x${mapping[2]}`), minor = BigInt(`0x${mapping[3]}`)
        // Linux dev_t packs the high major/minor bits separately; maps prints hexadecimal components.
        const device = ((major & 0xfffn) << 8n) | (minor & 0xffn)
          | ((major & ~0xfffn) << 32n) | ((minor & ~0xffn) << 12n)
        const inode = BigInt(mapping[4])
        if (inode > 0xffffffffffffffffn) fail(`Malformed process memory mapping: PID ${name}`)
        const target = mapping[5]?.replace(/ \(deleted\)$/, '')
        if ((target && roots.some(root => within(root, target))) || inodes.has(`${device}:${inode}`)) {
          fail(`Shared writable data mapping must be closed before migration: PID ${name}`)
        }
      }
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes(error.code)) continue
      // Non-dumpable session processes such as systemd --user and (sd-pam) hide their fds from their own UID.
      if (error.code === 'EACCES' && !dsh) continue
      fail(`Shared writer inspection failed or writer is active: ${error.message}`)
    }
  }
}

