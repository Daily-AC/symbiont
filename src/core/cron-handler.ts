/**
 * Cron 触发处理 — 从 symbiont-core.ts 提取。
 *
 * handleCronTrigger 和 runCognitionCycle 的逻辑。
 */
import type { CronJob } from './cron-scheduler.ts'
import type { SymbiontCore } from './symbiont-core.ts'

/** 带超时的 Promise 包装 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
    promise.then(
      result => { clearTimeout(timer); resolve(result) },
      err => { clearTimeout(timer); reject(err) }
    )
  })
}

export function handleCronTrigger(core: SymbiontCore, job: CronJob, runId: string): void {
  if (job.executor === 'native') {
    core.logger.info('cron', 'native-exec', { jobId: job.id, handler: job.handler })
    try {
      if (job.handler === 'memory.decay') {
        const result = core.memoryLifecycle.run()
        core.cronScheduler.completeRun(runId, true, JSON.stringify(result))
      } else if (job.handler === 'cognition.scan') {
        runCognitionCycle(core, runId)
      } else {
        core.cronScheduler.completeRun(runId, false, `Unknown handler: ${job.handler}`)
      }
    } catch (err) {
      core.cronScheduler.completeRun(runId, false, (err as Error).message)
    }
  } else {
    // cc 执行器：通过 DM session 注入 prompt，结果推送到群聊
    const CC_CRON_TIMEOUT = 3 * 60 * 1000 // 3 minutes
    const CRON_NOTIFY_CHAT_ID = process.env.SYMBIONT_CRON_CHAT_ID ?? 'oc_ffee250cd527431a3eb87a6a7e88d24b'
    const dmSessionKey = core.findDmSessionKey()
    if (dmSessionKey && core.router) {
      const systemEvent = `【系统事件】定时任务「${job.name}」触发。${job.prompt ?? ''}\n请处理并回复结果。`

      withTimeout(core.router.sendTo(dmSessionKey, systemEvent), CC_CRON_TIMEOUT, `cron-cc:${job.name}`).then(async result => {
        core.cronScheduler.completeRun(runId, true, result.slice(0, 500))
        // 定时任务结果推送到群聊（不是 DM）
        try {
          await core.sendFeishuNotification(CRON_NOTIFY_CHAT_ID, `📋 定时任务「${job.name}」\n\n${result}`)
        } catch { /* 推送失败不影响任务完成 */ }
        if ((job as any)._oneShot) {
          core.cronScheduler.removeJob(job.id)
          core.logger.info('cron', 'oneshot-removed', { id: job.id, name: job.name })
        }
      }).catch(async err => {
        core.logger.error('cron', 'cc-exec-failed', { jobId: job.id, name: job.name, error: (err as Error).message })
        core.cronScheduler.completeRun(runId, false, (err as Error).message)
        try { await core.sendFeishuNotification(CRON_NOTIFY_CHAT_ID, `❌ 定时任务失败「${job.name}」\n\n${(err as Error).message}`) } catch { /* ignore */ }
      })
    } else {
      // 没有 DM session → 派 worker 执行，结果发到群聊
      withTimeout(core.workerManager.dispatch({
        id: `cron-${job.id}-${runId}`,
        description: job.prompt ?? job.name,
        parentSessionId: 'cron',
      }), CC_CRON_TIMEOUT, `cron-worker:${job.name}`).then(async (result) => {
        core.cronScheduler.completeRun(runId, result.success, result.result.slice(0, 500))
        if ((job as any)._oneShot) {
          core.cronScheduler.removeJob(job.id)
          core.logger.info('cron', 'oneshot-removed', { id: job.id, name: job.name })
        }
        // 将结果发送到群聊
        try {
          await core.sendFeishuNotification(CRON_NOTIFY_CHAT_ID, `【定时任务】${job.name}\n\n${result.result.slice(0, 2000)}`)
        } catch (err) {
          core.logger.warn('cron', 'notify-chat-failed', { jobId: job.id, error: String(err) })
        }
      }).catch(async (err) => {
        core.logger.error('cron', 'cc-exec-failed', { jobId: job.id, name: job.name, error: (err as Error).message })
        core.cronScheduler.completeRun(runId, false, (err as Error).message)
        // 失败也通知群聊
        try {
          await core.sendFeishuNotification(CRON_NOTIFY_CHAT_ID, `【定时任务失败】${job.name}\n\n${(err as Error).message}`)
        } catch (notifyErr) {
          core.logger.warn('cron', 'notify-chat-failed', { jobId: job.id, error: String(notifyErr) })
        }
      })
    }
  }
}

/**
 * 认知闭环：scan → 派工人聚合 → 小希 review → 自动审批。
 *
 * 流程：
 * 1. scan 找到候选标签（≥5 张同标签卡片）
 * 2. 对每个候选标签，收集相关卡片内容
 * 3. 派工人让 CC 生成认知总结
 * 4. 再派工人让 CC review 总结质量
 * 5. review 通过则 approve，否则 reject
 */
export function runCognitionCycle(core: SymbiontCore, runId: string): void {
  const lifecycleResult = core.memoryLifecycle.run()
  core.cronScheduler.completeRun(runId, true, JSON.stringify({ aggregated: lifecycleResult.aggregated }))
  return

  // 以下旧系统代码保留但不再执行
  const tags = core.cognitionEngine.scan()
  if (tags.length === 0) {
    core.cronScheduler.completeRun(runId, true, '无可聚合标签')
    return
  }

  core.logger.info('cognition', 'cycle-start', { tags })
  const results: string[] = []

  const processTag = async (tag: string) => {
    const cards = core.memoryBridge.search({ tags: [tag] })
    const cardSummary = cards.map(c => `- [${c.confidence.toFixed(2)}] ${c.content} (场景: ${c.scene})`).join('\n')

    // Step 1: 派工人生成认知总结
    const genResult = await core.workerManager.dispatch({
      id: `cognition-gen-${tag}-${Date.now()}`,
      description: [
        `你是小希的认知聚合助手。以下是标签「${tag}」下的 ${cards.length} 条经验卡片：`,
        '', cardSummary, '',
        `请从这些经验中提炼出一条跨场景的认知规律（Pattern）。`,
        `要求：简洁、可操作、不是鸡汤。一句话总结规律，再用 1-2 句解释为什么。`,
        `只输出总结内容，不要其他格式。`,
      ].join('\n'),
      parentSessionId: 'cognition',
    })

    if (!genResult.success) {
      results.push(`${tag}: 生成失败`)
      return
    }

    // Step 2: 添加为 pending 候选
    const candidate = core.cognitionEngine.addCandidate({
      tag,
      sourceCards: cards.map(c => c.id),
      proposedContent: genResult.result,
    })

    // Step 3: 派工人 review
    const reviewResult = await core.workerManager.dispatch({
      id: `cognition-review-${tag}-${Date.now()}`,
      description: [
        `你是小希的认知审查助手。请评估以下认知总结的质量：`,
        '', `标签：${tag}`,
        `总结：${genResult.result}`,
        `来源卡片数：${cards.length}`,
        '',
        `评估标准：`,
        `1. 是否真正跨场景适用（不是只对一种场景有效）`,
        `2. 是否可操作（不是笼统的废话）`,
        `3. 是否与来源经验一致（不是凭空编造）`,
        '',
        `只回答 APPROVE 或 REJECT，加一句理由。`,
      ].join('\n'),
      parentSessionId: 'cognition',
    })

    if (reviewResult.success && reviewResult.result.toUpperCase().includes('APPROVE')) {
      core.cognitionEngine.approve(candidate.id)
      results.push(`${tag}: ✅ ${genResult.result.slice(0, 80)}`)
    } else {
      core.cognitionEngine.reject(candidate.id)
      results.push(`${tag}: ❌ review 未通过`)
    }
  }

  // 串行执行所有标签
  const run = async () => {
    for (const tag of tags) {
      try { await processTag(tag) } catch (err) {
        results.push(`${tag}: 异常 ${(err as Error).message}`)
      }
    }
    core.cronScheduler.completeRun(runId, true, results.join('; '))
    core.logger.info('cognition', 'cycle-done', { results })
  }
  run().catch(err => {
    core.cronScheduler.completeRun(runId, false, (err as Error).message)
  })
}
