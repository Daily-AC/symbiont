import { createInterface } from 'node:readline'
import { Router } from '../core/router.ts'

const T = Router.TERMINAL_KEY

export async function startTerminal(router: Router): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  await router.initialize()

  console.log('')
  console.log('\x1b[35m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m')
  console.log('\x1b[35m  Symbiont — online\x1b[0m')
  console.log('\x1b[35m  Type a message to chat\x1b[0m')
  console.log('\x1b[35m  /fork <任务>  分叉专员  /done <摘要> 完成分叉\x1b[0m')
  console.log('\x1b[35m  /back 回主Agent  /forks 查看分叉\x1b[0m')
  console.log('\x1b[35m  /worker <任务>  派工人  /timeline 时间线\x1b[0m')
  console.log('\x1b[35m  /quit 退出\x1b[0m')
  console.log('\x1b[35m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m')
  console.log('')

  const askQuestion = (): void => {
    rl.question('\x1b[32mYou:\x1b[0m ', async (input) => {
      const trimmed = input.trim()
      if (!trimmed) { askQuestion(); return }

      // 退出
      if (trimmed === '/quit' || trimmed === '/exit') {
        console.log('\n\x1b[36mAI: See you next time!\x1b[0m\n')
        await router.stop()
        rl.close()
        process.exit(0)
      }

      // 创建分叉（专员）
      if (trimmed.startsWith('/fork ')) {
        const desc = trimmed.slice(6).trim()
        if (!desc) { console.log('\x1b[33m用法: /fork <任务描述>\x1b[0m'); askQuestion(); return }
        console.log('\x1b[33m[创建专员分叉...]\x1b[0m')
        try {
          const fork = await router.createForkFor(T, desc)
          console.log(`\x1b[36m专员已就位 (${fork.id})，消息将路由到专员\x1b[0m\n`)
        } catch (e) { console.log(`\x1b[31m分叉失败: ${(e as Error).message}\x1b[0m`) }
        askQuestion(); return
      }

      // 完成分叉
      if (trimmed.startsWith('/done ')) {
        const summary = trimmed.slice(6).trim()
        if (!summary) { console.log('\x1b[33m用法: /done <摘要>\x1b[0m'); askQuestion(); return }
        await router.completeForkFor(T, summary)
        console.log('\x1b[36m分叉已完成，回到主Agent\x1b[0m\n')
        askQuestion(); return
      }

      // 回到主 Agent
      if (trimmed === '/back') {
        const session = router.getSession(T)
        if (session) session.activeForkId = null
        console.log('\x1b[36m已切回主Agent\x1b[0m\n')
        askQuestion(); return
      }

      // 查看分叉
      if (trimmed === '/forks') {
        const session = router.getSession(T)
        const currentFork = session?.activeForkId ?? null
        if (!currentFork) {
          console.log('\x1b[33m无活跃分叉\x1b[0m')
        } else {
          console.log(`  \x1b[36m[${currentFork}]\x1b[0m ← 当前`)
        }
        console.log('')
        askQuestion(); return
      }

      // 派遣工人
      if (trimmed.startsWith('/worker ')) {
        const task = trimmed.slice(8).trim()
        if (!task) { console.log('\x1b[33m用法: /worker <任务描述>\x1b[0m'); askQuestion(); return }
        console.log('\x1b[33m[派遣工人...]\x1b[0m')
        const result = await router.dispatchWorker(task)
        console.log(`\n\x1b[36m工人结果:\x1b[0m ${result}\n`)
        askQuestion(); return
      }

      // 时间线
      if (trimmed === '/timeline') {
        const timeline = router.getTimeline(T)
        if (timeline.length === 0) {
          console.log('\x1b[33m暂无时间线\x1b[0m')
        } else {
          for (const e of timeline.slice(-20)) {
            const time = new Date(e.timestamp).toLocaleTimeString()
            console.log(`  \x1b[90m${time}\x1b[0m [\x1b[36m${e.type}\x1b[0m] ${e.summary}`)
          }
        }
        console.log('')
        askQuestion(); return
      }

      // 普通消息
      const session = router.getSession(T)
      const label = session?.activeForkId ? '专员' : 'AI'
      console.log(`\x1b[33m[${label}思考中...]\x1b[0m`)
      const result = await router.sendTo(T, trimmed)
      console.log(`\n\x1b[36m${label}:\x1b[0m ${result}\n`)

      askQuestion()
    })
  }

  askQuestion()
}
