import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SymbiontCore } from './core/symbiont-core.ts'
import { Router } from './core/router.ts'
import { setupLifecycle } from './core/lifecycle.ts'
import { startTerminal } from './interface/terminal.ts'
import { startHealthServer } from './core/health.ts'
import { HotReloader } from './core/hot-reload.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const core = new SymbiontCore({
  dataDir: join(ROOT, 'data'),
  personaPackDir: join(ROOT, 'persona-xiaoxi'),
  userDir: join(ROOT, 'user'),
})

const router = new Router(core)
core.setRouter(router)

// 注册默认定时任务（只在首次时添加）
const existingJobs = core.cronScheduler.listJobs()
if (!existingJobs.some(j => j.handler === 'memory.decay')) {
  core.cronScheduler.addJob({
    name: '记忆衰减', schedule: '0 3 * * *',
    executor: 'native', handler: 'memory.decay',
    enabled: true, overlapPolicy: 'skip',
  })
}
if (!existingJobs.some(j => j.handler === 'cognition.scan')) {
  core.cronScheduler.addJob({
    name: '认知扫描', schedule: '0 4 * * *',
    executor: 'native', handler: 'cognition.scan',
    enabled: true, overlapPolicy: 'skip',
  })
}
if (!existingJobs.some(j => j.name === '心跳')) {
  core.cronScheduler.addJob({
    name: '心跳', schedule: '0 */4 * * *',
    executor: 'cc',
    prompt: [
      '你是小希的心跳进程。请执行以下检查：',
      '1. 调用 symbiont_system_status 查看系统状态',
      '2. 如果有异常（实例卡死、内存过高），报告问题',
      '3. 调用 symbiont_recall 搜索最近的经验，看看有没有值得整理的',
      '4. 如果发现值得记住的模式，用 symbiont_remember 记录',
      '5. 简要报告你的发现（一两句话）',
    ].join('\n'),
    enabled: true, overlapPolicy: 'skip',
  })
}

// 启动 cron 调度器（等 router 就绪后再启动，避免 CC 执行器找不到 DM session）
// 同时恢复重启前中断的工人任务
router.waitForReady().then(async () => {
  core.startCron()
  core.logger.info('cron', 'started-after-router-ready')
  // Recovery 放在这里确保 MCP Gateway 和 Router 都已就绪
  try {
    await core.recoverInterruptedTasks()
  } catch (err) {
    core.logger.error('recovery', 'recover-failed', { error: (err as Error).message })
  }
}).catch(err => {
  core.logger.error('cron', 'router-ready-timeout', { error: err.message })
  core.startCron()
})

setupLifecycle(router, core.logger)

// 健康检查端点
startHealthServer(core).catch((err) => {
  core.logger.warn('main', 'health-server-failed', { error: err.message })
})

// 配置热重载（persona/user 文件变化时自动更新 CLAUDE.md）
const hotReloader = new HotReloader(core)
hotReloader.start()

// Feishu plugin (optional, requires env vars)
const feishuAppId = process.env.FEISHU_APP_ID
const feishuAppSecret = process.env.FEISHU_APP_SECRET
if (feishuAppId && feishuAppSecret) {
  const { FeishuPlugin } = await import('./interface/feishu/index.ts')
  const feishuPlugin = new FeishuPlugin(
    { appId: feishuAppId, appSecret: feishuAppSecret },
    join(ROOT, 'data', 'feishu'),
  )
  feishuPlugin.setRouter(router)
  feishuPlugin.setDB(core.memoryDB)
  await feishuPlugin.connect()
  console.log('[symbiont] Feishu plugin connected')

  // 注册飞书 MCP 到 Gateway（通过 Gateway 代理，CC 只连 Gateway 一个入口）
  const feishuMcp = feishuPlugin.getMcpServer()
  if (feishuMcp) {
    core.registerGatewayBackend('symbiont-feishu', feishuMcp.url)
    console.log(`[symbiont] Feishu MCP registered to gateway: ${feishuMcp.url}`)
  }

  // 注入飞书消息发送能力（供 cron 等场景使用）
  const { sendText: feishuSendText } = await import('./interface/feishu/send.ts')
  core.setFeishuSender(async (chatId, text) => { await feishuSendText(chatId, text) })

  // 启动完成后通知以琳（找到 session-map 里最近活跃的 p2p 会话）
  const ownerChatId = feishuPlugin.getSessionMap().getOwnerChatId()
  if (ownerChatId) {
    const { sendText } = await import('./interface/feishu/send.ts')
    const uptime = Math.round(process.uptime())
    sendText(ownerChatId, `🌻 我重启好了（耗时 ${uptime}s）`).catch(() => {})
  }
}

// 终端界面（只在有 stdin 时启动，后台运行时跳过）
if (process.stdin.isTTY) {
  startTerminal(router).catch((err) => {
    core.logger.error('main', 'startup-failed', { error: err.message })
    process.exit(1)
  })
} else {
  // 后台模式：只靠飞书插件和 MCP 接收消息
  core.logger.info('main', 'running-headless', { feishu: !!feishuAppId })
  // 初始化 router（创建主 CC 实例）
  router.initialize().catch((err) => {
    core.logger.error('main', 'init-failed', { error: err.message })
    process.exit(1)
  })
}
