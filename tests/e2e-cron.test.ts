import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, existsSync, readFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CronScheduler } from '../src/core/cron-scheduler.ts'
import { createTestLogger } from './helpers.ts'

describe('E2E: Cron Scheduling', { timeout: 30_000 }, () => {
  let dataDir: string
  let scheduler: CronScheduler
  let triggerLog: Array<{ jobId: string; runId: string }>

  before(() => {
    const logger = createTestLogger()
    dataDir = mkdtempSync(join(tmpdir(), 'symbiont-cron-test-'))
    triggerLog = []
    scheduler = new CronScheduler(dataDir, {
      logger,
      onTrigger: (job, runId) => { triggerLog.push({ jobId: job.id, runId }) },
    })
  })

  after(() => {
    scheduler.stop()
    rmSync(dataDir, { recursive: true, force: true })
  })

  test('addJob creates a job and persists it', () => {
    const job = scheduler.addJob({
      name: 'test-job',
      schedule: '*/5 * * * *',
      executor: 'cc',
      prompt: 'say hello',
      enabled: true,
    })
    assert.ok(job.id.startsWith('cron-'))
    assert.equal(job.name, 'test-job')
    assert.equal(job.consecutiveFailures, 0)
    const jobsFile = join(dataDir, 'cron', 'jobs.jsonl')
    assert.ok(existsSync(jobsFile))
    const content = readFileSync(jobsFile, 'utf-8')
    assert.ok(content.includes('test-job'))
  })

  test('triggerNow fires the onTrigger callback', () => {
    const jobs = scheduler.listJobs()
    const job = jobs[0]
    const runId = scheduler.triggerNow(job.id)
    assert.ok(runId, 'Should return a runId')
    assert.equal(triggerLog.length, 1)
    assert.equal(triggerLog[0].jobId, job.id)
  })

  test('completeRun marks success and resets failures', () => {
    const runId = triggerLog[0].runId
    scheduler.completeRun(runId, true, 'done')
    const job = scheduler.getJob(scheduler.listJobs()[0].id)
    assert.equal(job?.consecutiveFailures, 0)
  })

  test('overlap skip prevents duplicate runs', () => {
    const job = scheduler.addJob({
      name: 'overlap-test',
      schedule: '* * * * *',
      executor: 'cc',
      prompt: 'test',
      enabled: true,
      overlapPolicy: 'skip',
    })
    const runId1 = scheduler.triggerNow(job.id)
    assert.ok(runId1)
    const runId2 = scheduler.triggerNow(job.id)
    assert.equal(runId2, '', 'Should skip overlapping trigger')
    scheduler.completeRun(runId1!, true)
    const runId3 = scheduler.triggerNow(job.id)
    assert.ok(runId3, 'Should trigger after previous completed')
    scheduler.completeRun(runId3!, true)
  })

  test('circuit breaker disables job after N failures', () => {
    const job = scheduler.addJob({
      name: 'breaker-test',
      schedule: '* * * * *',
      executor: 'cc',
      prompt: 'test',
      enabled: true,
      maxFailures: 3,
    })
    for (let i = 0; i < 3; i++) {
      const runId = scheduler.triggerNow(job.id)
      scheduler.completeRun(runId!, false, 'error')
    }
    const updated = scheduler.getJob(job.id)
    assert.equal(updated?.enabled, false, 'Should be disabled after max failures')
    assert.equal(updated?.consecutiveFailures, 3)
  })

  test('persistence survives restart', () => {
    scheduler.stop()
    const logger2 = createTestLogger()
    const scheduler2 = new CronScheduler(dataDir, { logger: logger2, onTrigger: () => {} })
    const jobs = scheduler2.listJobs()
    assert.ok(jobs.length >= 3, `Should restore jobs, got ${jobs.length}`)
    assert.ok(jobs.some(j => j.name === 'test-job'))
    scheduler2.stop()
  })

  test('removeJob deletes and persists', () => {
    // Re-create scheduler since we stopped it
    const logger3 = createTestLogger()
    scheduler = new CronScheduler(dataDir, { logger: logger3, onTrigger: () => {} })
    const countBefore = scheduler.listJobs().length
    const firstJob = scheduler.listJobs()[0]
    scheduler.removeJob(firstJob.id)
    assert.equal(scheduler.listJobs().length, countBefore - 1)
  })
})
