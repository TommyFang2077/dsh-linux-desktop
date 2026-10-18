import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'

// Source-contract probe only: provider IO and Cordis lifecycle are stubbed.
const repository = process.argv[2]
assert.ok(repository, 'Usage: node scripts/check-rc2-compatibility.mjs <upstream-git-checkout>')
const old = '1517a4dbca0a2789ff1d41ba439600f8547d23fa'
const next = '687f282e8625c6b8d11ff58211a90524be2e4317'
const source = (sha, path) => execFileSync('git', ['show', `${sha}:${path}`], { cwd: repository, encoding: 'utf8' })
const controller = source(next, 'packages/client/ui-settings-web-search/src/client/web-search-card-controller.ts')
const providers = controller.slice(controller.indexOf('const PROVIDERS ='), controller.indexOf('/** Credential reference'))
const select = controller.slice(controller.indexOf('  private select('), controller.indexOf('\n  /**\n   * Save the provider'))
const selectApi = runInNewContext(stripTypeScriptTypes(`${providers}\nclass Probe {${select}}; Probe.prototype.select`))
let settings = {}
selectApi.call({ scopes: { web: { getSnapshot: () => ({ base: { searchProvider: 'deepseek-official', fetchProvider: 'http' } }) } },
  selection: { actions: () => ({ edit: (field, value) => { settings = { ...settings, [field]: value } }, resetField: () => assert.fail('unexpected reset') }) } }, true)
assert.deepEqual(settings, { searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' })
const oldBundle = source(old, 'packages/bundle/base/cordis.patch.yml')
assert.doesNotMatch(oldBundle, /web-deepseek-api/)
assert.match(source(next, 'packages/bundle/base/cordis.patch.yml'), /web-deepseek-api/)
class Service { constructor(ctx) { this.ctx = ctx } }
class WebError extends Error { constructor(message, code) { super(message); this.code = code } }
const z = { string: () => ({ volatile: () => ({}) }), object: () => ({}) }
function runtime(sha, selection) {
  const web = source(sha, 'packages/web/web/src/index.ts')
  const code = web.slice(web.indexOf('export class WebRuntime')).replace('export class', 'class').replace('export default WebRuntime', '; WebRuntime')
  const Runtime = runInNewContext(stripTypeScriptTypes(code, { mode: 'transform' }), { Service, WebError, z, process: { env: {} } })
  const ctx = { effect: fn => { const iterator = fn(); iterator.next(); return () => iterator.return() } }
  return new Runtime(ctx, sha === old ? selection : Object.fromEntries(Object.entries(selection).map(([key, value]) => [key, { get: () => value }])))
}
function register(web, search, fetch) {
  web.registerSearchProvider({ id: search, available: () => true, search: async () => ({ sources: [], truncated: false }) })
  web.registerFetchProvider({ id: fetch, available: () => true, fetch: async () => ({ statusCode: 200 }) })
}
const defaults = { searchProvider: 'deepseek-official', fetchProvider: 'http' }
let results = []
for (const sha of [old, next]) {
  const web = runtime(sha, defaults)
  register(web, defaults.searchProvider, defaults.fetchProvider)
  await web.search({ query: 'fixture' })
  await web.fetch({ url: 'https://example.test/' })
  results = [...results, { sha, settings: 'alpha.5 defaults', search: 'pass', fetch: 'pass' }]
}
const rc = runtime(next, settings)
register(rc, settings.searchProvider, settings.fetchProvider)
await rc.search({ query: 'fixture' })
await rc.fetch({ url: 'https://example.test/' })
results = [...results, { sha: next, settings: 'rc.2 saved selection', search: 'pass', fetch: 'pass' }]
const rollback = runtime(old, settings)
register(rollback, defaults.searchProvider, defaults.fetchProvider)
for (const [method, request] of [['search', { query: 'fixture' }], ['fetch', { url: 'https://example.test/' }]]) {
  await assert.rejects(rollback[method](request), error => {
    assert.equal(error.code, 'WEB_PROVIDER_CONFIGURED_MISSING')
    results = [...results, { sha: old, settings: 'rc.2 saved selection', method, error: error.code, message: error.message }]
    return true
  })
}
console.log(JSON.stringify({ old, next, sameEpochCompatible: false, savedSelection: settings, results }, null, 2))
