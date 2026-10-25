// 运行锁探针（每个场景一个进程，避免"进程内上一轮还没结束"的守卫干扰）
// 用法：node --import ./tools/register.mjs probe-runlock.mjs <scenario>
// 场景：busy / expired / garbled / none / own
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

const scenario = process.argv[2] || 'busy'
const HOME = join(tmpdir(), 'bili-runlock-' + scenario)
try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 清不掉就留着 */ }
mkdirSync(join(HOME, 'bili-duty'), { recursive: true })
// ⚠️ 关键：把 dshBin 指到一个不存在的地方 ⇒ 即使真的"开跑"也不会启动真会话（不会花 token / 不联网）
writeFileSync(join(HOME, 'bili-duty', 'config.json'), JSON.stringify({ dshBin: 'C:/__nope__/fake-dsh.js' }), 'utf8')

const mod = await import('./index.js')
const tools = new Map()
const fakeCtx = {
  get: (k) => (k === 'dshHomePath' ? (...seg) => join(HOME, ...seg) : undefined),
  logger: { info: () => {}, warn: () => {} },
  tools: { register: (t) => { tools.set(t?.name, t); return t } },
  webServer: { register: () => ({ dispose() {} }) },
  effect: (fn) => { try { return fn() } catch { return undefined } },
  settings: { register: () => ({}) },
  slots: { inject: () => {}, register: () => ({}) },
}
mod.apply(fakeCtx, {})

const lockPath = join(HOME, 'bili-duty', 'run-lock.json')
const writeLock = (pid, ts) => writeFileSync(lockPath, JSON.stringify({ pid, ts }), 'utf8')
const readLock = () => { try { return JSON.parse(readFileSync(lockPath, 'utf8')) } catch { return null } }

let other = null
if (scenario === 'busy' || scenario === 'expired') {
  other = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 600))
}

if (scenario === 'busy') writeLock(other.pid, Date.now())
if (scenario === 'expired') writeLock(other.pid, Date.now() - 20 * 60_000)
if (scenario === 'garbled') writeFileSync(lockPath, '这不是 json{{{', 'utf8')
if (scenario === 'own') writeLock(process.pid, Date.now())

const run = tools.get('bili_run')
const r = await run.execute({})
const lock = readLock()

const cases = {
  busy: ['另一个宿主正在跑 ⇒ 让开', (r) => r.busy === true && r.started === false],
  expired: ['锁过期 ⇒ 不拦（不是 busy）', (r) => r.busy !== true],
  garbled: ['锁文件乱码 ⇒ 照跑不崩（不是 busy）', (r) => r.busy !== true],
  none: ['没锁 ⇒ 照跑，并写下自己的 pid', (r, l) => r.busy !== true && Number(l?.pid) === process.pid],
  own: ['锁是自己的 ⇒ 不拦自己（不是 busy）', (r) => r.busy !== true],
}
const [name, fn] = cases[scenario] || ['未知场景', () => false]
const ok = fn(r, lock)
console.log((ok ? '  过  ' : '  挂  ') + scenario + '：' + name + '  → ' + JSON.stringify(r).slice(0, 100))
try { other?.kill() } catch { /* 已退出 */ }
process.exit(ok ? 0 : 1)
