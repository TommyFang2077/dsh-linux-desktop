import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = resolve('.')
const upstream = resolve(process.env.DSH_UPSTREAM_DEPENDENCIES ?? join(root, 'build/upstream'))
const sourceRepository = resolve(process.env.DSH_UPSTREAM_SOURCE ?? upstream)
const require = createRequire(join(upstream, 'package.json'))
const { build } = require(require.resolve('esbuild', { paths: [join(upstream, 'node_modules/.pnpm/node_modules')] }))
const deferred = () => Promise.withResolvers()
const tick = () => new Promise(resolve => setImmediate(resolve))

async function candidate(t) {
  const directory = await fs.mkdtemp('/tmp/dsh-admission-test-')
  if (process.env.DSH_ADMISSION_KEEP) console.log('Isolated candidate: ' + directory)
  else t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const { commit } = JSON.parse(await fs.readFile('upstream.json', 'utf8'))
  const archive = join(directory, 'sources.tar')
  execFileSync('git', ['-C', sourceRepository, 'archive', '--output=' + archive, commit, 'packages', 'vendor', 'apps', 'native', 'scripts/types', 'tsconfig.base.json', 'tsconfig.base.client.json', 'tsconfig.host.json', 'tsconfig.client.json', 'package.json'])
  execFileSync('tar', ['-xf', archive, '-C', directory])
  const packagePaths = execFileSync('git', ['-C', sourceRepository, 'ls-tree', '-r', '--name-only', commit, 'packages', 'vendor', 'apps', 'native'], { encoding: 'utf8' })
    .trim().split('\n').filter(path => path.endsWith('/package.json'))
  const packageSources = new Map()
  for (const path of packagePaths) {
    const metadata = JSON.parse(await fs.readFile(join(directory, path), 'utf8'))
    if (metadata.name) packageSources.set(metadata.name, { metadata, directory: join(directory, path, '..') })
  }
  const patch = await fs.readFile('patches/linux.patch', 'utf8')
  for (const part of patch.split('diff --git ').slice(1)) {
    const name = part.split('\n', 1)[0].split(' b/')[1]
    if (part.includes('\nnew file mode ')) continue
    await fs.mkdir(join(directory, name, '..'), { recursive: true })
    await fs.writeFile(join(directory, name), execFileSync('git', ['-C', sourceRepository, 'show', commit + ':' + name]))
  }
  execFileSync('git', ['apply', '-'], { cwd: directory, input: patch })
  if (process.env.DSH_ADMISSION_TYPECHECK) {
    await fs.symlink(join(upstream, 'node_modules'), join(directory, 'node_modules'), 'dir')
    for (const { directory: packageDirectory } of packageSources.values()) {
      const source = join(upstream, packageDirectory.slice(directory.length + 1), 'node_modules')
      if (await fs.stat(source).then(stat => stat.isDirectory(), () => false)) {
        await fs.symlink(source, join(packageDirectory, 'node_modules'), 'dir')
      }
    }
    const compiler = require.resolve('typescript/bin/tsc')
    const analytics = join(directory, 'packages/client/product-analytics')
    const compile = projects => execFileSync(process.execPath, [compiler, '--build', ...projects, '--pretty', 'false'],
      { maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' })
    compile([join(analytics, 'tsconfig.host.json')])
    const generator = join(directory, 'packages/typert/generator/fixture-generator.mjs')
    await build({ entryPoints: [join(directory, 'packages/typert/generator/src/workspace.ts')], outfile: generator,
      bundle: true, format: 'esm', platform: 'node', target: 'node24', packages: 'external' })
    const { WorkspaceTypertGenerator } = await import(pathToFileURL(generator))
    const artifacts = new WorkspaceTypertGenerator(directory).generate(['@deepseek-ai/dsh-client-product-analytics'], ['host'])
    assert.equal(artifacts.length, 1)
    const artifact = artifacts[0]
    assert.equal(artifact.packageRoot, 'packages/client/product-analytics')
    assert.ok(artifact.remote)
    const contract = join(analytics, 'lib/typert.remote-client.d.ts')
    await assert.rejects(fs.stat(contract), { code: 'ENOENT' })
    for (const [extension, field] of [['js', 'js'], ['d.ts', 'dts'], ['d.ts.map', 'dtsMap']]) {
      await fs.writeFile(join(analytics, 'lib/typert.remote-client.' + extension), artifact.remote[field])
    }
    assert.match(await fs.readFile(contract, 'utf8'), /'productAnalytics': TypertRemoteNamespace/)
    const ts = require('typescript')
    const config = ts.getParsedCommandLineOfConfigFile(join(analytics, 'tsconfig.client.json'), {}, { ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: diagnostic => assert.fail(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')) })
    const remote = ts.resolveModuleName('@deepseek-ai/dsh-client-product-analytics/remote',
      join(analytics, 'src/client/index.ts'), config.options, ts.sys).resolvedModule
    assert.equal(await fs.realpath(remote.resolvedFileName), contract)
    console.log('Generated Host remote contract resolves inside candidate: ' + contract)
    const projects = ['packages/core/agent', 'packages/core/agent-loop', 'packages/jobs/jobs', 'packages/jobs/jobs-local',
      'packages/schedule/schedule', 'packages/subagent/subagent', 'apps/desktop-host', 'apps/desktop']
    compile(projects.map(path => join(directory, path)))
    console.log('TypeScript project-reference build passed for eight patched packages/apps')
  }
  const alias = {
    '@deepseek-ai/dsh-agent': join(directory, 'packages/core/agent/src/index.ts'),
    '@deepseek-ai/dsh-agent-loop': join(directory, 'packages/core/agent-loop/src/index.ts'),
    '@deepseek-ai/dsh-jobs': join(directory, 'packages/jobs/jobs/src/index.ts'),
    '@deepseek-ai/dsh-jobs-local': join(directory, 'packages/jobs/jobs-local/src/index.ts'),
    '@deepseek-ai/dsh-subagent': join(directory, 'packages/subagent/subagent/src/index.ts'),
  }
  const entry = [
    "export { Context, Service } from '@deepseek-ai/cordis'",
    "export { default as AgentRegistry } from '@deepseek-ai/dsh-agent'",
    "export { default as SessionStore, Session, SessionId } from '@deepseek-ai/dsh-session'",
    "export { default as SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'",
    "export { createUserMessage } from '@deepseek-ai/dsh-llm'",
    "export { LocalJobRegistry } from '@deepseek-ai/dsh-jobs-local'",
    "export { UpdateAdmissionGate } from './packages/core/agent/src/update-admission.ts'",
    "export { ReactLoopInbox, inboxProjectionDefinition } from './packages/core/agent-loop/src/inbox.ts'",
    "export { default as AgentLoop } from './packages/core/agent-loop/src/index.ts'",
    "export { ReactLoopAgent } from './packages/core/agent-loop/src/agent.ts'",
    "export { ScheduleRuntime } from './packages/schedule/schedule/src/runtime.ts'",
    "export { createAtScheduleRecord, ScheduleId } from './packages/schedule/schedule/src/domain.ts'",
    "export { SubagentRuntime } from './packages/subagent/subagent/src/index.ts'",
    "export { SubagentManager } from './packages/subagent/subagent/src/manager.ts'",
    "export { DesktopHostProcess } from './apps/desktop/src/host-process.ts'",
    "export { hasDesktopActiveTasks, installDesktopUpdateTaskControl } from './apps/desktop-host/src/update-tasks.ts'",
  ].join('\n')
  const outfile = join(directory, 'candidate.mjs')
  await build({ stdin: { contents: entry, resolveDir: directory, loader: 'ts' }, outfile, bundle: true,
    format: 'esm', platform: 'node', target: 'node24', alias,
    plugins: [{ name: 'pinned-source-packages', setup(plugin) {
      plugin.onLoad({ filter: /\.[cm]?[jt]s$/ }, async ({ path }) => {
        if (!path.startsWith(directory + '/')) return
        const contents = (await fs.readFile(path, 'utf8')).replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path).href))
        return { contents, loader: path.endsWith('.ts') ? 'ts' : 'js' }
      })
      plugin.onResolve({ filter: /^@deepseek-ai\// }, async ({ path }) => {
        const name = path.split('/').slice(0, 2).join('/'), spec = packageSources.get(name)
        if (!spec) return
        const subpath = path.slice(name.length), entry = spec.metadata.exports?.[subpath ? '.' + subpath : '.']
        const target = typeof entry === 'string' ? entry : entry?.default ?? (!subpath ? spec.metadata.main : undefined)
        if (!target) return
        for (const relative of [target.replace(/^\.\/lib\/types\//, 'src/').replace(/\.js$/, '.ts'), target.replace(/^(\.\/)?lib\//, 'src/').replace(/\.js$/, '.ts')]) {
          const source = join(spec.directory, relative)
          if (await fs.stat(source).then(stat => stat.isFile(), () => false)) return { path: source }
        }
      })
    } }],
    nodePaths: [join(upstream, 'node_modules'), join(upstream, 'node_modules/.pnpm/node_modules')],
    banner: { js: "import { createRequire as __require } from 'node:module'; const require = __require(import.meta.url);" },
    logLevel: 'silent',
  })
  return { ...(await import(pathToFileURL(outfile))), directory }
}

test('pinned patched task admission uses real classes and reversible ownership', async t => {
  const c = await candidate(t)
  await t.test('gate covers success throw rejection nested work and expired async permits', async () => {
    const gate = new c.UpdateAdmissionGate()
    assert.equal(gate.run(() => 3), 3)
    assert.throws(() => gate.run(() => { throw Error('sync') }), /sync/)
    await assert.rejects(gate.run(async () => { throw Error('async') }), /async/)
    await tick(); assert.equal(gate.active, 0)
    const done = deferred()
    const pending = gate.run(async () => { await done.promise; return gate.run(() => 7) })
    gate.freeze('a'); assert.equal(gate.active, 1)
    assert.throws(() => gate.run(() => 1), /frozen/)
    done.resolve(); assert.equal(await pending, 7)
    await tick(); assert.equal(gate.active, 0)
    gate.freeze('a'); assert.throws(() => gate.freeze('b'), /owned/)
    assert.equal(gate.release('old'), false); assert.equal(gate.frozen, true)
    gate.release('a')
    const later = deferred(), caught = deferred()
    gate.run(() => { void later.promise.then(() => { try { gate.run(() => 0); caught.reject(Error('stale permit accepted')) } catch (error) { caught.resolve(error) } }) })
    gate.freeze('b'); later.resolve()
    assert.match((await caught.promise).message, /frozen/)
    gate.release('b'); assert.equal(gate.active, 0)
  })
  await t.test('real Cordis registry shares one gate and tracks unpublished factory work', async () => {
    const ctx = new c.Context(); await ctx.plugin(c.AgentRegistry)
    try {
      const gate = ctx.agents.updateAdmission
      const done = deferred()
      ctx.agents.setFactory({ createAgent: () => done.promise, resume: () => done.promise })
      const creation = ctx.agents.create({})
      assert.equal(ctx.agents.list().length, 0)
      assert.equal(gate.active, 1)
      gate.freeze('a')
      await assert.rejects(ctx.agents.resume({}), /frozen/)
      assert.throws(() => ctx.agents.withoutInitiator(() => 0), /frozen/)
      done.resolve({}); await creation; await tick()
      assert.equal(gate.active, 0)
      gate.release('a'); assert.equal(ctx.agents.withoutInitiator(() => 9), 9)
    } finally { await ctx.fiber.dispose() }
  })
  await t.test('real inbox rejects every insert before durable events but permits cleanup', async () => {
    const ctx = new c.Context(); await ctx.plugin(c.SessionStore); await ctx.plugin(c.SessionProjectionRegistry)
    ctx.sessionProjections.register(c.inboxProjectionDefinition)
    const gate = new c.UpdateAdmissionGate(), session = ctx.sessions.create(c.SessionId('inbox'))
    let emitted = 0
    const inbox = new c.ReactLoopInbox(ctx.sessionProjections, session, { emit: () => { emitted++ } }, gate)
    const old = c.createUserMessage('old'); inbox.append('next-turn', old)
    gate.freeze('a')
    for (const attempt of [() => inbox.append('next-turn', c.createUserMessage('a')), () => inbox.prepend('next-turn', c.createUserMessage('b')),
      () => inbox.replace(old.id, c.createUserMessage('c')), () => inbox.splice('next-turn', 0, 0, [c.createUserMessage('d')])]) assert.throws(attempt, /frozen/)
    assert.equal(inbox.nextTurn.length, 1); assert.equal(emitted, 1)
    inbox.clear(); assert.equal(inbox.nextTurn.length, 0)
    gate.release('a'); inbox.append('next-turn', c.createUserMessage('again')); assert.equal(inbox.nextTurn.length, 1)
    await ctx.fiber.dispose()
  })
  await t.test('maintenance remains pending while its public status is idle', async () => {
    const gate = new c.UpdateAdmissionGate(), done = deferred()
    const agent = Object.create(c.ReactLoopAgent.prototype)
    Object.assign(agent, { ctx: { agents: { updateAdmission: gate } }, phase: { kind: 'idle', lastTurn: 0 }, dispatch: { emit() {} }, id: 'maintenance', inbox: { hasPending: false } })
    const maintenance = agent.runMaintenance(() => done.promise)
    assert.equal(agent.status, 'idle'); assert.equal(gate.active, 1)
    gate.freeze('a'); assert.throws(() => agent.send({}, 'next-turn', true), /frozen/)
    done.resolve(); await maintenance; await tick()
    assert.equal(gate.active, 0); gate.release('a')
  })
  await t.test('real Host inspection covers main/subagent inboxes and global/owned background jobs', () => {
    const idle = { id: 'child', status: 'inactive', inbox: { nextTurn: [], nextStep: [] } }
    assert.equal(c.hasDesktopActiveTasks([idle], { list: () => [] }), false)
    assert.equal(c.hasDesktopActiveTasks([{ ...idle, status: 'running' }], { list: () => [] }), true)
    for (const queue of ['nextTurn', 'nextStep']) assert.equal(c.hasDesktopActiveTasks([{ ...idle, inbox: { ...idle.inbox, [queue]: ['queued'] } }], { list: () => [] }), true)
    for (const status of ['running', 'stopping']) for (const owner of [undefined, 'child']) {
      assert.equal(c.hasDesktopActiveTasks([idle], { list: id => id === owner ? [{ status }] : [] }), true)
    }
  })
  
  
  await t.test('Host drains admitted HTTP and enforces recoverable token ownership', async () => {
    const gate = new c.UpdateAdmissionGate(), live = [], roster = [], hooks = {}, effects = []
    const services = { agents: { updateAdmission: gate, list: () => live }, jobs: { updateAdmission: gate, list: () => roster } }
    const ctx = { get: name => services[name], effect: fn => effects.push(fn()), on: (name, fn) => { hooks[name] = fn } }
    const control = c.installDesktopUpdateTaskControl(ctx)
    assert.equal(await control('inspect'), false)
    const requestDone = deferred()
    const request = hooks['connection/request']({}, {}, () => requestDone.promise)
    let locked = false
    const first = control('lock', 'a').then(value => { locked = true; return value })
    await tick(); assert.equal(locked, false)
    const response = { writeHead(code) { this.code = code }, end() { this.ended = true } }
    await hooks['connection/request']({}, response, () => assert.fail('new HTTP admitted'))
    assert.equal(response.code, 503); assert.equal(response.ended, true)
    await assert.rejects(control('lock', 'b'), /already owned/)
    await control('unlock', 'obsolete')
    requestDone.resolve(); await request
    assert.equal(await first, false); assert.equal(gate.frozen, true)
    assert.throws(() => gate.run(() => 1), /frozen/)
    await control('unlock', 'a'); assert.equal(gate.frozen, false)
    const delayed = deferred(), secondRequest = hooks['connection/request']({}, {}, () => delayed.promise)
    const expired = control('lock', 'expired'); const expiredResult = assert.rejects(expired, /superseded/)
    await control('unlock', 'expired')
    const current = control('lock', 'current')
    delayed.resolve(); await secondRequest; await expiredResult
    assert.equal(await current, false)
    await control('unlock', 'expired'); assert.equal(gate.frozen, true)
    await control('unlock', 'current')
    const running = deferred(), work = gate.run(() => running.promise)
    assert.equal(await control('lock', 'busy'), true); assert.equal(gate.frozen, false)
    running.resolve(); await work; await tick()
    live.push({ updateAdmission: gate, status: 'idle', inbox: { nextTurn: [{}], nextStep: [] } })
    assert.equal(await control('lock', 'inbox'), true); live.length = 0
    roster.push({ status: 'stopping' }); assert.equal(await control('lock', 'job'), true); roster.length = 0
    live.push({ status: 'idle', inbox: { nextTurn: [], nextStep: [] } })
    await assert.rejects(control('inspect'), /lacks task admission/); live.length = 0
    services.jobs.updateAdmission = undefined
    await assert.rejects(control('lock', 'unknown'), /lacks complete/)
    services.jobs.updateAdmission = gate
    services.subagents = { updateAdmission: undefined }
    await assert.rejects(control('inspect'), /lacks complete/)
    delete services.subagents
    effects.forEach(fn => fn())
    await assert.rejects(control('lock', 'stopping'), /Host is stopping/)
  })
  await t.test('real job registry blocks before producer side effects and tracks prepublication reentry', async () => {
    const ctx = new c.Context(); await ctx.plugin(c.AgentRegistry); await ctx.plugin(c.LocalJobRegistry, {})
    ctx.jobs.attachController('admission-test')
    const control = c.installDesktopUpdateTaskControl(ctx)
    assert.equal(await control('lock', 'real-context'), false)
    await control('unlock', 'real-context')
    const gate = ctx.agents.updateAdmission, done = deferred()
    let starts = 0, observed = 0
    const events = []
    let registration
    ctx.jobs.events.subscribe({ owners: 'all' }, event => {
      events.push(event.type)
      if (event.type === 'registered') {
        registration = { active: gate.active > 0, count: ctx.jobs.list().length, progress: event.job.progress,
          output: ctx.jobs.readAt(event.job.id, 0).chunks.map(chunk => chunk.text).join('') }
      }
    })
    const spec = { kind: 'admission-test', label: 'pending', run(handle) {
      starts++; observed = gate.active
      assert.equal(ctx.jobs.list().length, 0)
      handle.append('staged output')
      handle.updateProgress('staged progress')
      assert.deepEqual(events, [])
      return { done: done.promise, cancel() { done.resolve({ status: 'killed' }) } }
    } }
    try {
      gate.freeze('a'); assert.throws(() => ctx.jobs.start(spec), /frozen/); assert.equal(starts, 0)
      gate.release('a'); ctx.jobs.start(spec)
      assert.equal(starts, 1); assert.equal(observed > 0, true)
      assert.deepEqual(events, ['registered'])
      assert.deepEqual(registration, { active: true, count: 1, progress: 'staged progress', output: 'staged output' })
      assert.match(ctx.jobs.list()[0].id, /^admission-test-[a-f0-9]{16}$/)
      assert.equal(ctx.jobs.list()[0].status, 'running')
      done.resolve({ status: 'completed' }); await tick(); await tick()
      assert.equal(ctx.jobs.list()[0].status, 'completed')
      assert.deepEqual(events, ['registered', 'settled', 'output'])
    } finally { await ctx.fiber.dispose() }
  })
  await t.test('scheduled internal dispatch survives a frozen admission and retries after release', async () => {
    const ctx = new c.Context(); await ctx.plugin(c.AgentRegistry)
    const gate = ctx.agents.updateAdmission, finish = deferred()
    let deliveries = 0
    const runtime = new c.ScheduleRuntime(ctx, () => [], async work => { deliveries++; await finish.promise; await work() }, async () => {}, {})
    try {
      gate.freeze('a'); runtime.requestDrive(); await tick()
      assert.equal(deliveries, 0)
      gate.release('a'); await tick()
      assert.equal(deliveries, 1); assert.equal(gate.active > 0, true)
      finish.resolve(); await runtime.dispose(); await tick()
      assert.equal(gate.active, 0)
    } finally { await runtime.dispose(); await ctx.fiber.dispose() }
  })
  await t.test('direct loop factories and subagent ingress reject before executing startup hooks', async () => {
    const gate = new c.UpdateAdmissionGate()
    const factory = Object.create(c.AgentLoop.prototype), manager = Object.create(c.SubagentManager.prototype)
    factory.ctx = manager.ctx = { agents: { updateAdmission: gate } }
    gate.freeze('a')
    for (const method of ['create', 'createAgent', 'resume', 'restoreOrCreateConfigured', 'resumeWith']) {
      await assert.rejects(async () => factory[method](), /frozen/, method)
    }
    for (const method of ['startLocal', 'startExternal', 'sendMessage', 'queuePrompt', 'steerPrompt']) {
      await assert.rejects(async () => manager[method](), /frozen/, method)
    }
    gate.release('a')
    const result = deferred(), disposal = deferred()
    let disposed = false
    manager.close = async (_activation, finish) => finish()
    manager.finishDisposal = async () => { disposed = true; await disposal.promise }
    manager.reportTeardownFailure = error => assert.fail(String(error))
    manager.announce({ kind: 'external', announced: false, run: { result: result.promise } })
    assert.equal(gate.active, 1)
    result.resolve(); await tick(); assert.equal(disposed, true); assert.equal(gate.active, 1)
    disposal.resolve(); await tick(); assert.equal(gate.active, 0)
  })
  await t.test('desktop IPC requires version and lease echo and retains timeout ownership until recovery', async () => {
    const host = Object.create(c.DesktopHostProcess.prototype), messages = []
    host.control = async request => {
      messages.push(request)
      return { type: 'update-tasks', active: false, admissionVersion: 1, token: request.token }
    }
    assert.equal(await host.updateTasks('inspect'), false)
    assert.equal(await host.updateTasks('lock'), false)
    const first = messages.at(-1).token; assert.equal(typeof first, 'string')
    await assert.rejects(host.updateTasks('lock'), /already requested/)
    assert.equal(await host.updateTasks('unlock'), false); assert.equal(messages.at(-1).token, first)
    host.control = async request => { messages.push(request); throw Error('timeout') }
    await assert.rejects(host.updateTasks('lock'), /timeout/)
    const timedOut = messages.at(-1).token
    await assert.rejects(host.updateTasks('lock'), /already requested/)
    host.control = async request => { messages.push(request); return { type: 'update-tasks', active: false, admissionVersion: 1, token: request.token } }
    await host.updateTasks('unlock'); assert.equal(messages.at(-1).token, timedOut)
    host.control = async () => ({ type: 'update-tasks', active: false })
    await assert.rejects(host.updateTasks('inspect'), /lacks verified/)
    host.control = async request => ({ type: 'update-tasks', active: false, admissionVersion: 1, token: 'wrong-' + request.token })
    await assert.rejects(host.updateTasks('lock'), /lacks verified/)
  })

  await t.test('real scoped agent jobs and subagent service retain the same Cordis admission identity', async () => {
    const ctx = new c.Context()
    await ctx.plugin(c.AgentRegistry); await ctx.plugin(c.SessionStore); await ctx.plugin(c.SessionProjectionRegistry)
    await ctx.plugin(c.LocalJobRegistry, {})
    class WorkingDirectory extends c.Service { constructor(ctx) { super(ctx, 'workingDirectory') } }
    await ctx.plugin(WorkingDirectory); await ctx.plugin(c.SubagentRuntime, {})
    ctx.sessionProjections.register(c.inboxProjectionDefinition)
    const session = ctx.sessions.create(c.SessionId('identity'))
    let agent
    await ctx.plugin({ inject: ['agents', 'sessions', 'sessionProjections'], apply(owner) { agent = new c.ReactLoopAgent(owner, session.id, {}, session) } })
    const unregister = ctx.agents.register(agent)
    try {
      const gate = ctx.agents.updateAdmission
      assert.equal(ctx.jobs.updateAdmission, gate); assert.equal(ctx.subagents.updateAdmission, gate)
      assert.equal(agent.updateAdmission, gate)
      const control = c.installDesktopUpdateTaskControl(ctx)
      assert.equal(await control('lock', 'identity'), false)
      assert.throws(() => agent.inbox.append('next-turn', c.createUserMessage('blocked')), /frozen/)
      await control('unlock', 'identity')
      agent.inbox.append('next-turn', c.createUserMessage('accepted'))
      assert.equal(await control('lock', 'queued'), true)
    } finally { unregister(); await agent.scope.dispose(); await ctx.fiber.dispose() }
  })
  await t.test('due schedule stays admitted through resolve flush and commit and delivers once after release', async () => {
    const gate = new c.UpdateAdmissionGate(), resolving = deferred(), flushing = deferred(), committing = deferred()
    const effects = [], services = { agents: { updateAdmission: gate, list: () => [], withoutInitiator: work => gate.run(work) }, jobs: { updateAdmission: gate, list: () => [] } }
    const now = Date.now(), record = c.createAtScheduleRecord(c.ScheduleId('due'), 'reminder', new Date(now - 1000).toISOString(), now - 2000, 'reminder')
    let task = { record, sessionId: 'scheduled-session', status: 'active' }, deliveries = 0, commits = 0
    const ctx = { ...services, get: name => services[name], effect: fn => effects.push(fn()), on() {}, logger: { warn: text => { if (!text.includes('frozen')) assert.fail(text) } },
      sessionController: { resolveAgent: () => resolving.promise }, sessions: { flush: () => flushing.promise } }
    const runtime = new c.ScheduleRuntime(ctx, () => [task], work => work(), async value => { commits++; await committing.promise; task = value }, { maxRecords: 10, maxBytes: 10000 })
    const control = c.installDesktopUpdateTaskControl(ctx)
    await control('lock', 'before'); runtime.requestDrive(); await tick(); assert.equal(gate.active, 0)
    await control('unlock', 'before'); await tick()
    assert.equal(await control('lock', 'resolving'), true)
    resolving.resolve({ agent: { session: {}, followup() { deliveries++ } } }); await tick()
    assert.equal(deliveries, 1); assert.equal(commits, 0); assert.equal(await control('lock', 'flushing'), true)
    flushing.resolve(true); await tick()
    assert.equal(commits, 1); assert.equal(await control('lock', 'committing'), true)
    committing.resolve(); await tick(); await tick()
    assert.equal(await control('lock', 'complete'), false)
    await control('unlock', 'complete'); runtime.requestDrive(); await tick()
    assert.equal(deliveries, 1); assert.equal(commits, 1); assert.equal(task.status, 'inactive')
    await runtime.dispose(); effects.forEach(fn => fn())
  })
  await t.test('actual external settlement waits for disposal and poisons admission only for uncertain cleanup', async () => {
    for (const resultFails of [false, true]) for (const disposalFails of [false, true]) {
      const gate = new c.UpdateAdmissionGate(), result = deferred(), disposal = deferred(), terminal = deferred()
      terminal.promise.catch(() => {})
      const manager = Object.create(c.SubagentManager.prototype), errors = []
      const services = { agents: { updateAdmission: gate, list: () => [] }, jobs: { updateAdmission: gate, list: () => [] } }
      const ctx = { ...services, get: name => services[name], effect() {}, on() {} }
      Object.assign(manager, { ctx, resident: new Map(), releaseOwnership() {}, reportTeardownFailure(_activation, error) { errors.push(error) } })
      let disposed = 0
      const activation = { kind: 'external', childId: 'external', announced: false, delivery: 'caller',
        run: { result: result.promise, dispose: () => { disposed++; return disposal.promise } }, result: terminal,
        releaseSlot() {}, observer: { settle() {} } }
      manager.resident.set('external', activation); manager.announce(activation)
      const control = c.installDesktopUpdateTaskControl(ctx)
      assert.equal(await control('lock', 'running'), true)
      if (resultFails) result.reject(Error('result failed'))
      else result.resolve({ output: [], stopReason: 'completed' })
      await tick(); assert.equal(disposed, 1); assert.equal(await control('lock', 'disposing'), true)
      if (disposalFails) disposal.reject(Error('resource cleanup uncertain'))
      else disposal.resolve()
      await tick(); await tick()
      assert.equal(manager.resident.size, 0)
      assert.equal(await control('lock', 'settled'), disposalFails)
      if (!disposalFails) await control('unlock', 'settled')
      assert.equal(errors.length, resultFails || disposalFails ? 1 : 0)
      if (disposalFails) {
        assert.equal(await control('lock', 'retry'), true)
        assert.equal(gate.frozen, false)
        assert.equal(gate.run(() => 'normal work remains available'), 'normal work remains available')
      }
    }
  })

})
