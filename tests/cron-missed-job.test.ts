import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CronScheduler } from '../src/core/cron-scheduler.ts'
import { createTestLogger } from './helpers.ts'

function makeDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'sia-cron-test-'))
}

function makeJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'job-test-001',
    name: 'Test Job',
    schedule: '0 * * * *',  // hourly
    executor: 'native',
    handler: 'testHandler',
    enabled: true,
    createdAt: new Date().toISOString(),
    consecutiveFailures: 0,
    ...overrides,
  }
}

function writeJobsJsonl(dataDir: string, jobs: Record<string, unknown>[]): void {
  const cronDir = join(dataDir, 'cron')
  mkdirSync(cronDir, { recursive: true })
  writeFileSync(
    join(cronDir, 'jobs.jsonl'),
    jobs.map(j => JSON.stringify(j)).join('\n') + '\n'
  )
}

describe('Cron missed-job 补偿', () => {
  test('lastCompletedAt 超过 2x 周期 → 触发补偿', () => {
    const dataDir = makeDataDir()
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000 - 1000).toISOString()

    writeJobsJsonl(dataDir, [
      makeJob({ lastCompletedAt: twoHoursAgo, schedule: '0 * * * *' })  // hourly
    ])

    const triggered: string[] = []
    const scheduler = new CronScheduler(dataDir, {
      logger: createTestLogger(),
      onTrigger: (job) => { triggered.push(job.id) },
    })

    scheduler.start()
    scheduler.stop()

    assert.equal(triggered.length, 1, '应该触发一次补偿')
    assert.equal(triggered[0], 'job-test-001')

    rmSync(dataDir, { recursive: true, force: true })
  })

  test('lastCompletedAt 在 2x 周期内 → 不触发', () => {
    const dataDir = makeDataDir()
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()

    writeJobsJsonl(dataDir, [
      makeJob({ lastCompletedAt: fiveMinutesAgo, schedule: '0 * * * *' })  // hourly
    ])

    const triggered: string[] = []
    const scheduler = new CronScheduler(dataDir, {
      logger: createTestLogger(),
      onTrigger: (job) => { triggered.push(job.id) },
    })

    scheduler.start()
    scheduler.stop()

    assert.equal(triggered.length, 0, '周期内不应触发补偿')

    rmSync(dataDir, { recursive: true, force: true })
  })

  test('没有 lastCompletedAt → 不触发', () => {
    const dataDir = makeDataDir()

    writeJobsJsonl(dataDir, [
      makeJob({ schedule: '0 * * * *' })  // no lastCompletedAt
    ])

    const triggered: string[] = []
    const scheduler = new CronScheduler(dataDir, {
      logger: createTestLogger(),
      onTrigger: (job) => { triggered.push(job.id) },
    })

    scheduler.start()
    scheduler.stop()

    assert.equal(triggered.length, 0, '无历史记录时不应触发补偿')

    rmSync(dataDir, { recursive: true, force: true })
  })

  test('disabled job → 不触发', () => {
    const dataDir = makeDataDir()
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000 - 1000).toISOString()

    writeJobsJsonl(dataDir, [
      makeJob({ lastCompletedAt: twoHoursAgo, schedule: '0 * * * *', enabled: false })
    ])

    const triggered: string[] = []
    const scheduler = new CronScheduler(dataDir, {
      logger: createTestLogger(),
      onTrigger: (job) => { triggered.push(job.id) },
    })

    scheduler.start()
    scheduler.stop()

    assert.equal(triggered.length, 0, '禁用的 job 不应触发补偿')

    rmSync(dataDir, { recursive: true, force: true })
  })

  test('completeRun 成功后记录 lastCompletedAt', () => {
    const dataDir = makeDataDir()

    writeJobsJsonl(dataDir, [makeJob()])

    const scheduler = new CronScheduler(dataDir, {
      logger: createTestLogger(),
      onTrigger: () => {},
    })

    const runId = scheduler.triggerNow('job-test-001')!
    assert.ok(runId, '应该返回 runId')

    const before = Date.now()
    scheduler.completeRun(runId, true, 'ok')
    const after = Date.now()

    const job = scheduler.getJob('job-test-001')
    assert.ok(job?.lastCompletedAt, 'lastCompletedAt 应该被设置')
    const ts = new Date(job!.lastCompletedAt!).getTime()
    assert.ok(ts >= before && ts <= after, 'lastCompletedAt 时间应在合理范围内')

    rmSync(dataDir, { recursive: true, force: true })
  })

  test('completeRun 失败时不更新 lastCompletedAt', () => {
    const dataDir = makeDataDir()
    const oldTs = new Date(Date.now() - 10000).toISOString()

    writeJobsJsonl(dataDir, [makeJob({ lastCompletedAt: oldTs })])

    const scheduler = new CronScheduler(dataDir, {
      logger: createTestLogger(),
      onTrigger: () => {},
    })

    const runId = scheduler.triggerNow('job-test-001')!
    scheduler.completeRun(runId, false, 'error')

    const job = scheduler.getJob('job-test-001')
    assert.equal(job?.lastCompletedAt, oldTs, '失败时不应更新 lastCompletedAt')

    rmSync(dataDir, { recursive: true, force: true })
  })
})

describe('estimateIntervalMs — cron 表达式解析', () => {
  // 通过创建一个 scheduler 来访问 estimateIntervalMs
  function makeScheduler(): CronScheduler {
    const dataDir = makeDataDir()
    return new CronScheduler(dataDir, {
      logger: createTestLogger(),
      onTrigger: () => {},
    })
  }

  test('*/5 * * * * → 5 分钟', () => {
    const s = makeScheduler()
    assert.equal(s.estimateIntervalMs('*/5 * * * *'), 5 * 60 * 1000)
  })

  test('*/1 * * * * → 1 分钟', () => {
    const s = makeScheduler()
    assert.equal(s.estimateIntervalMs('*/1 * * * *'), 1 * 60 * 1000)
  })

  test('*/30 * * * * → 30 分钟', () => {
    const s = makeScheduler()
    assert.equal(s.estimateIntervalMs('*/30 * * * *'), 30 * 60 * 1000)
  })

  test('0 */1 * * * → 1 小时', () => {
    const s = makeScheduler()
    assert.equal(s.estimateIntervalMs('0 */1 * * *'), 60 * 60 * 1000)
  })

  test('0 */6 * * * → 6 小时', () => {
    const s = makeScheduler()
    assert.equal(s.estimateIntervalMs('0 */6 * * *'), 6 * 60 * 60 * 1000)
  })

  test('0 * * * * → 1 小时（固定分钟+任意小时）', () => {
    const s = makeScheduler()
    assert.equal(s.estimateIntervalMs('0 * * * *'), 60 * 60 * 1000)
  })

  test('30 2 * * * → 24 小时（固定时刻）', () => {
    const s = makeScheduler()
    assert.equal(s.estimateIntervalMs('30 2 * * *'), 24 * 60 * 60 * 1000)
  })

  test('0 0 * * * → 24 小时（午夜）', () => {
    const s = makeScheduler()
    assert.equal(s.estimateIntervalMs('0 0 * * *'), 24 * 60 * 60 * 1000)
  })

  test('复杂表达式（无法估算）→ 0', () => {
    const s = makeScheduler()
    assert.equal(s.estimateIntervalMs('0 0 1 * *'), 0)   // 每月 1 号
    assert.equal(s.estimateIntervalMs('0 0 * * 1'), 0)   // 每周一
    assert.equal(s.estimateIntervalMs('*/5 */2 * * *'), 0)  // 分钟+小时都是 */N
  })
})
