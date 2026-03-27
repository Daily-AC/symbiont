import type { Router } from './router.ts'
import type { Logger } from './logger.ts'

/**
 * 进程生命周期管理。
 *
 * - SIGINT (Ctrl+C) / SIGTERM → 优雅关闭
 * - 第二次 Ctrl+C → 强制退出
 * - 15 秒超时兜底
 */
export function setupLifecycle(router: Router, logger: Logger): void {
  let shutdownInProgress = false

  const handleSignal = async (signal: string) => {
    if (shutdownInProgress) {
      logger.warn('lifecycle', 'force-exit', { signal })
      process.exit(1)
    }

    shutdownInProgress = true
    logger.info('lifecycle', 'graceful-shutdown', { signal })

    const timeout = setTimeout(() => {
      logger.error('lifecycle', 'shutdown-timeout')
      process.exit(1)
    }, 15000)
    timeout.unref()

    try {
      await router.stop()
    } catch (err) {
      logger.error('lifecycle', 'shutdown-error', { error: (err as Error).message })
    }

    clearTimeout(timeout)
    process.exit(0)
  }

  process.on('SIGINT', () => handleSignal('SIGINT'))
  process.on('SIGTERM', () => handleSignal('SIGTERM'))

  // 未捕获异常 — 尽量 sleep sessions 再退出
  process.on('uncaughtException', (err) => {
    logger.error('lifecycle', 'uncaught-exception', { error: err.message, stack: err.stack })
    router.stop().catch(() => {}).finally(() => process.exit(1))
    // 兜底：如果 stop 卡住，5 秒后强制退出
    setTimeout(() => process.exit(1), 5000).unref()
  })

  process.on('unhandledRejection', (reason) => {
    logger.error('lifecycle', 'unhandled-rejection', { reason: String(reason) })
  })
}
