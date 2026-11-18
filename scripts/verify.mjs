/**
 * 静态验证并行跑：把「改完之后先扫一遍」从四次命令往返压成一次。
 *
 * 分道而不是全并行，是因为 typecheck / nest build / eval 抢同一份 tsconfig 与 dist/：
 * 两个 tsc 同时写 .tsbuildinfo 与 dist 会出现「构建产物来自哪一次都不确定」的假绿。
 * 于是后端一条道走到底（typecheck → build → 断言），前端 lint 与前端构建各占一条道。
 *
 * 后端那条道里省掉了 `npm run eval` 自带的一次 nest build：这条道刚刚构建过，
 * 重跑一次只是多花 2~3 秒。改动 dist 的仍是同一次 nest build。
 *
 * 这条命令只覆盖静态与结构不变量。界面与 SSE 行为要靠
 * `npm run verify:live`（假上游 + 临时库）和真浏览器走一遍，见 README「改完怎么验」。
 *
 * lint 标成 advisory（只报不判）：它现在挂着一条与当次改动无关的既有报错，
 * 一条恒定返回 1 的命令没法当闸门用——真要卡 lint 请单独跑 `npm run lint`，它照旧返回非 0。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const apiRoot = path.join(repoRoot, 'functions', 'api')
const frontendRoot = path.join(repoRoot, 'frontend')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const STEPS = [
  { id: 'typecheck', command: npm, args: ['run', 'typecheck'], cwd: apiRoot },
  { id: 'build:api', command: npm, args: ['run', 'build'], cwd: apiRoot },
  { id: 'eval', command: process.execPath, args: ['evals/run-evals.mjs'], cwd: apiRoot },
  { id: 'lint', command: npm, args: ['run', 'lint'], cwd: frontendRoot, advisory: true },
  { id: 'build:frontend', command: npm, args: ['run', 'build'], cwd: frontendRoot },
]

// 一条道内串行，道与道之间并行
const LANES = [['typecheck', 'build:api', 'eval'], ['lint'], ['build:frontend']]

const requested = process.argv.slice(2).find((arg) => arg.startsWith('--only='))
const only = requested ? new Set(requested.slice('--only='.length).split(',').map((s) => s.trim())) : null
const byId = new Map(STEPS.map((step) => [step.id, step]))
const lanes = LANES.map((lane) =>
  lane.map((id) => byId.get(id)).filter((step) => !only || only.has(step.id)),
).filter((lane) => lane.length > 0)

const results = new Map()

function runStep(step) {
  return new Promise((resolve) => {
    const started = Date.now()
    // Windows 上 npm 是 .cmd，Node 22 拒绝在 shell:false 下启动它（EINVAL），只能过 shell
    const viaShell = process.platform === 'win32' && /\.cmd$/i.test(step.command)
    const child = viaShell
      ? spawn([step.command, ...step.args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' '), {
          cwd: step.cwd,
          shell: true,
        })
      : spawn(step.command, step.args, { cwd: step.cwd, shell: false })
    const lines = []
    const push = (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim()) {
          lines.push(line)
          process.stdout.write(`${pad(step.id)} ${line}\n`)
        }
      }
    }
    child.stdout.on('data', push)
    child.stderr.on('data', push)
    child.on('error', (error) => {
      results.set(step.id, { status: 'error', ms: Date.now() - started, note: error.message })
      resolve(false)
    })
    child.on('close', (code) => {
      const tail = lines.slice(-3).join(' / ')
      results.set(step.id, {
        status: code === 0 ? 'ok' : `exit ${code}`,
        ms: Date.now() - started,
        note: code === 0 ? '' : tail,
      })
      resolve(code === 0)
    })
  })
}

function pad(id) {
  return `[${id}]`.padEnd(18)
}

const totalStarted = Date.now()
const laneOutcomes = await Promise.all(
  lanes.map(async (lane) => {
    for (const step of lane) {
      const passed = await runStep(step)
      if (!passed && !step.advisory) {
        return false
      }
    }
    return true
  }),
)

const totalMs = Date.now() - totalStarted
const isAdvisory = (id) => byId.get(id)?.advisory === true
const failed = [...results.entries()].filter(
  ([id, value]) => value.status !== 'ok' && !isAdvisory(id),
)
const advised = [...results.entries()].filter(
  ([id, value]) => value.status !== 'ok' && isAdvisory(id),
)
const serialMs = [...results.values()].reduce((sum, value) => sum + value.ms, 0)

console.log('\n验证结果')
for (const step of STEPS) {
  const value = results.get(step.id)
  if (!value) {
    continue
  }
  const label =
    value.status === 'ok'
      ? '通过'
      : step.advisory
        ? `${value.status}（只报不判）`
        : value.status
  console.log(
    `${pad(step.id)} ${label}  ${(value.ms / 1000).toFixed(1)}s${
      value.note ? `  ${value.note.slice(0, 200)}` : ''
    }`,
  )
}
console.log(`并行 ${(totalMs / 1000).toFixed(1)}s；同口径串行约 ${(serialMs / 1000).toFixed(1)}s`)

if (advised.length > 0) {
  console.log(
    `\n提示：${advised.map(([id]) => id).join('、')} 未通过，但不计入结果（要卡它请单独跑 npm run lint）。`,
  )
}

if (failed.length > 0) {
  console.log(`\n有 ${failed.length} 步未通过：${failed.map(([id]) => id).join('、')}`)
  process.exit(1)
}
if (laneOutcomes.some((ok) => !ok)) {
  process.exit(1)
}
console.log('\n全部通过。界面与流式行为仍需 npm run verify:live + 浏览器实测。')
