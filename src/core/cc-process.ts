import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { createServer, type Server as HttpServer } from 'node:http'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import type { CCMessage, CCProcessOptions, CCProcessState } from './types.ts'
import { buildCCArgs } from './cc-args.ts'

/**
 * CC 进程管理器 — --sdk-url 反连 WebSocket 模式
 *
 * 生命周期状态机：
 *   idle → running → sleeping → running（唤醒）→ stopped
 *                  → stopped（崩溃/销毁）
 *
 * 参考 Team Anya 的 ClaudeCodeBackend 设计。
 */
export class CCProcess extends EventEmitter {
  private options: CCProcessOptions
  private process: ChildProcess | null = null
  private httpServer: HttpServer | null = null
  private wsServer: WebSocketServer | null = null
  private ws: WebSocket | null = null
  private _state: CCProcessState = 'idle'
  private ccSessionId: string | null = null
  private lastActivityAt: number = 0
  private _lastAssistantUsage: { inputTokens: number; model?: string } | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimeoutMs: number

  // prompt 排队：CC 执行中新消息入队，执行完后自动取下一条
  private pendingPrompt: {
    resolve: (value: { result: string; sessionId: string | null; blocks: Array<unknown> }) => void
    reject: (err: Error) => void
    result: string
    textParts: string[]
    blocks: Array<unknown>
  } | null = null
  private messageQueue: Array<{
    prompt: string
    resolve: (value: { result: string; sessionId: string | null; blocks: Array<unknown> }) => void
    reject: (err: Error) => void
  }> = []

  constructor(options: CCProcessOptions = {}) {
    super()
    this.options = options
    this.ccSessionId = options.sessionId ?? null
    this.idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60 * 1000  // 默认 5 分钟
  }

  get state(): CCProcessState { return this._state }
  getSessionId(): string | null { return this.ccSessionId }

  private setState(s: CCProcessState): void {
    const prev = this._state
    this._state = s
    this.emit('state-change', s, prev)
  }

  /**
   * 启动 CC 进程 + WS Server，等待 CLI 反连。
   */
  async connect(): Promise<void> {
    if (this._state === 'running') return

    const port = await this.findFreePort()
    const connId = randomUUID()

    await this.startWsServer(port, connId)

    const args = this.buildArgs(port, connId)
    const claudePath = process.env.CLAUDE_PATH || this.findClaudePath()

    this.process = spawn(claudePath, args, {
      cwd: this.options.cwd,
      env: this.cleanEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.process.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim()
      if (line) {
        this.emit('stderr', line)
        if (process.env.SYMBIONT_DEBUG) process.stderr.write(`[CC stderr] ${line}\n`)
      }
    })

    this.process.on('exit', (code) => {
      const wasSleeping = this._state === 'sleeping'
      this.setState('stopped')
      this.emit('exit', code)
      this.clearIdleTimer()

      if (this.pendingPrompt) {
        const pending = this.pendingPrompt
        this.pendingPrompt = null
        if (pending.result) {
          pending.resolve({ result: pending.result, sessionId: this.ccSessionId, blocks: pending.blocks })
        } else if (!wasSleeping) {
          pending.reject(new Error(`CC process exited with code ${code} while waiting for response`))
        }
      }
      // reject 所有排队的消息
      for (const q of this.messageQueue) {
        q.reject(new Error(`CC process exited with code ${code}`))
      }
      this.messageQueue = []
    })

    // 'close' fires after all stdio streams close — more reliable than 'exit' for OOM kills
    this.process.on('close', (code, signal) => {
      if (this._state === 'running') {
        this._state = 'stopped'
        this.emit('state-change', 'stopped')
        this.emit('exit', code ?? 1, signal ?? 'unknown')
      }
    })

    this.process.on('error', (err) => {
      this.setState('stopped')
      this.emit('error', err)
    })

    await this.waitForConnection(30000)

    // 参照 Team Anya：不等待 system/init，WS 连上即就绪。
    // Linux 上 CC 不会主动发 init，第一次 query 时会触发。
    // session_id 会在 routeMessage 收到 system 时异步更新。
    this.setState('running')
    this.touchActivity()
    this.startIdleTimer()
  }

  /**
   * 发送 prompt 并等待完整响应。
   * 如果进程未启动或已休眠，自动 connect/唤醒。
   * 如果正在执行，消息入队。
   */
  async query(prompt: string): Promise<{ result: string; sessionId: string | null; blocks: Array<unknown> }> {
    // print 模式：每轮启动新进程，-p + --resume
    if (this.options.mode === 'print') {
      return this.queryPrintMode(prompt)
    }

    // ws 模式（默认）
    if (this._state === 'sleeping' || this._state === 'stopped') {
      await this.wake()
    }
    if (this._state === 'idle') {
      await this.connect()
    }

    if (this.pendingPrompt) {
      if (this.messageQueue.length >= 10) {
        return Promise.reject(new Error('CC message queue full (max 10)'))
      }
      return new Promise((resolve, reject) => {
        this.messageQueue.push({ prompt, resolve, reject })
      })
    }

    return this.sendPrompt(prompt)
  }

  /**
   * Print 模式：每轮启动新 CC 进程（-p + --resume），进程完成后退出。
   * 比 WS 模式慢几秒但兼容性更好（Linux 等 --sdk-url 不工作的环境）。
   */
  private queryPrintMode(prompt: string): Promise<{ result: string; sessionId: string | null; blocks: Array<unknown> }> {
    return new Promise((resolve, reject) => {
      const claudePath = process.env.CLAUDE_PATH || this.findClaudePath()
      const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions']

      if (this.ccSessionId) {
        args.push('--resume', this.ccSessionId)
      }
      if (this.options.systemPrompt && !this.ccSessionId) {
        args.push('--system-prompt', this.options.systemPrompt)
      }
      if (this.options.model) {
        args.push('--model', this.options.model)
      }
      if (this.options.allowedTools?.length) {
        args.push('--allowedTools', this.options.allowedTools.join(','))
      }
      if (this.options.mcpServers && Object.keys(this.options.mcpServers).length > 0) {
        args.push('--mcp-config', JSON.stringify({ mcpServers: this.options.mcpServers }))
      }

      const proc = spawn(claudePath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.options.cwd,
        env: this.cleanEnv(),
      })

      let result = ''
      let sessionId: string | null = this.ccSessionId
      const textParts: string[] = []
      const blocks: Array<unknown> = []
      let lastAssistantUsage: { inputTokens: number; model?: string } | null = null

      const rl = createInterface({ input: proc.stdout! })
      rl.on('line', (line: string) => {
        try {
          const msg: CCMessage = JSON.parse(line)
          this.emit('message', msg)
          if (msg.session_id && !sessionId) sessionId = msg.session_id
          if (msg.type === 'result') {
            if (typeof msg.result === 'string') result = msg.result
            // 从 result.modelUsage 取 contextWindow，从最近的 assistant usage 取 inputTokens
            const msgModelUsage = msg.modelUsage as Record<string, { contextWindow?: number }> | undefined
            if (msgModelUsage && lastAssistantUsage) {
              const entries = Object.entries(msgModelUsage)
              if (entries.length > 0) {
                const modelName = entries[0][0]
                const ctxWindow = entries[0][1].contextWindow ?? 0
                if (ctxWindow > 0) {
                  this.emit('usage', { inputTokens: lastAssistantUsage.inputTokens, contextWindow: ctxWindow, model: lastAssistantUsage.model ?? modelName })
                }
              }
            }
          }
          if (msg.type === 'assistant') {
            // 从 assistant 消息提取单次 API 调用 usage（= 当前上下文大小）
            const aUsage = (msg.message as any)?.usage as { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined
            const aModel = (msg.message as any)?.model as string | undefined
            if (aUsage) {
              const contextSize = (aUsage.input_tokens ?? 0) + (aUsage.cache_creation_input_tokens ?? 0) + (aUsage.cache_read_input_tokens ?? 0)
              if (contextSize > 0) {
                lastAssistantUsage = { inputTokens: contextSize, model: aModel }
              }
            }
          }
          if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
              blocks.push(block)
              if (block.type === 'text' && block.text) {
                this.emit('text', block.text)
                textParts.push(block.text)
              }
            }
          }
        } catch { /* non-JSON */ }
      })

      proc.stderr?.on('data', (chunk: Buffer) => {
        const line = chunk.toString().trim()
        if (line) this.emit('stderr', line)
      })

      proc.on('exit', (code) => {
        const finalResult = result || textParts.join('')
        if (sessionId) this.ccSessionId = sessionId
        this.touchActivity()
        if (code === 0 || finalResult) {
          resolve({ result: finalResult, sessionId, blocks })
        } else {
          reject(new Error(`CC process exited with code ${code}`))
        }
      })

      proc.on('error', reject)
    })
  }

  private findClaudePath(): string {
    try {
      return execSync('which claude', { encoding: 'utf-8' }).trim()
    } catch {
      return 'claude'
    }
  }

  /**
   * 休眠：记录 session-id，关闭进程，保留状态以便唤醒。
   */
  async sleep(): Promise<void> {
    if (this._state !== 'running') return
    this.clearIdleTimer()
    this.setState('sleeping')
    // 保留 ccSessionId 用于唤醒
    await this.disposeProcess()
  }

  // 标记中断状态，防止 SIGINT 后 CC 返回的 result 被当作 late-result 推送到飞书
  private _interrupted = false

  /**
   * 中断当前执行（等同于 ESC）：发送 SIGINT 到 CC 进程。
   * CC CLI 收到 SIGINT 会中断当前操作并返回 result 消息，由 routeMessage 正常处理。
   */
  interrupt(): boolean {
    if (this._state !== 'running' || !this.process || this.process.exitCode !== null) return false
    this._interrupted = true
    this.process.kill('SIGINT')
    return true
  }

  /**
   * 唤醒：用 --resume 恢复到之前的 session。
   */
  async wake(): Promise<void> {
    if (this._state === 'running') return
    if (this.ccSessionId) {
      this.options.sessionId = this.ccSessionId
    }
    await this.connect()
  }

  /**
   * resume 降级：如果 --resume 失败，用 recoveryPrompt 作为新 session 的第一条消息。
   */
  async connectWithFallback(recoveryPrompt?: string): Promise<void> {
    try {
      await this.connect()
    } catch (err) {
      this.emit('resume-failed', err)
      // 降级：清除 sessionId，作为全新 session 启动
      this.ccSessionId = null
      this.options.sessionId = undefined
      await this.connect()
      // 如果有恢复 prompt（比如事件流摘要），发送它
      if (recoveryPrompt) {
        await this.query(recoveryPrompt)
      }
    }
  }

  /** 进程是否存活 */
  isAlive(): boolean {
    return this.process !== null
      && this.process.exitCode === null
      && this.ws !== null
      && this.ws.readyState === 1
  }

  /** 更新 sessionId */
  setSessionId(id: string): void {
    this.ccSessionId = id
    this.options.sessionId = id
  }

  /** 完全销毁（不可恢复） */
  async dispose(): Promise<void> {
    this.clearIdleTimer()
    await this.disposeProcess()
    this.ccSessionId = null
    this.setState('idle')
  }

  /** Force cleanup all resources — used by watchdog for zombie instances */
  cleanup(): void {
    if (this.process) {
      try { this.process.kill('SIGKILL') } catch {}
      this.process = null
    }
    if (this.ws) {
      try { this.ws.close() } catch {}
      this.ws = null
    }
    this._state = 'stopped'
  }

  /** 记录活动时间（重置空闲计时） */
  touchActivity(): void {
    this.lastActivityAt = Date.now()
  }

  getLastActivityAt(): number {
    return this.lastActivityAt
  }

  // ---- 内部方法 ----

  private async sendPrompt(prompt: string): Promise<{ result: string; sessionId: string | null; blocks: Array<unknown> }> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) {
        reject(new Error('WebSocket not connected'))
        return
      }

      // 不设超时 — 复杂任务可能运行数小时，卡死由 watchdog 检测恢复
      this.pendingPrompt = {
        resolve,
        reject,
        result: '',
        textParts: [],
        blocks: [],
      }
      this.touchActivity()

      const msg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: prompt },
        parent_tool_use_id: null,
        session_id: this.ccSessionId ?? '',  // 空字符串触发 Linux 上的初始化
      })
      this.ws.send(msg + '\n')
    })
  }

  private processNextInQueue(): void {
    if (this.messageQueue.length === 0) return
    const next = this.messageQueue.shift()!
    this.sendPrompt(next.prompt).then(next.resolve, next.reject)
  }

  private startIdleTimer(): void {
    this.clearIdleTimer()
    if (this.idleTimeoutMs <= 0) return
    this.idleTimer = setInterval(() => {
      if (this._state !== 'running') return
      if (this.pendingPrompt) return  // 正在执行，不休眠
      const idle = Date.now() - this.lastActivityAt
      if (idle >= this.idleTimeoutMs) {
        this.sleep().catch(err => { console.error('[CCProcess] sleep failed:', err) })
      }
    }, 30000)  // 每 30 秒检查一次
    // 不阻止进程退出
    if (this.idleTimer && typeof this.idleTimer === 'object' && 'unref' in this.idleTimer) {
      this.idleTimer.unref()
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
  }

  private async disposeProcess(): Promise<void> {
    if (this.process && this.process.exitCode === null) {
      this.process.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process && this.process.exitCode === null) {
            this.process.kill('SIGKILL')
          }
          resolve()
        }, 5000)
        this.process!.on('exit', () => { clearTimeout(timeout); resolve() })
      })
    }
    this.ws?.close()
    this.ws = null
    this.wsServer?.close()
    this.wsServer = null
    this.httpServer?.close()
    this.httpServer = null
    this.process = null
  }

  private async startWsServer(port: number, connId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = createServer()
      this.wsServer = new WebSocketServer({ server: this.httpServer })

      this.wsServer.on('connection', (ws) => {
        this.ws = ws
        ws.on('message', (data: Buffer) => {
          const lines = data.toString().split('\n').filter(Boolean)
          for (const line of lines) {
            try {
              const msg: CCMessage = JSON.parse(line)
              this.routeMessage(msg)
            } catch { /* non-JSON */ }
          }
        })
        ws.on('close', () => {
          this.ws = null
          // WS 断开时清理 pending + 队列，防 promise hang
          // process exit handler 也会处理，用 null 检查防双重触发
          if (this.pendingPrompt) {
            const pending = this.pendingPrompt
            this.pendingPrompt = null
            const partialResult = pending.result || pending.textParts.join('')
            if (partialResult) {
              pending.resolve({ result: partialResult, sessionId: this.ccSessionId, blocks: pending.blocks })
            } else {
              pending.reject(new Error('WebSocket closed while waiting for CC response'))
            }
          }
          // reject 队列中所有排队消息
          for (const q of this.messageQueue) {
            q.reject(new Error('WebSocket closed'))
          }
          this.messageQueue = []
          this.emit('ws-close')
        })
        this.emit('ws-connected')
      })

      this.httpServer.listen(port, '127.0.0.1', () => resolve())
      this.httpServer.on('error', reject)
    })
  }

  private routeMessage(msg: CCMessage): void {
    this.emit('message', msg)
    this.touchActivity()

    switch (msg.type) {
      case 'system':
        if (msg.session_id) {
          this.ccSessionId = msg.session_id
        }
        break

      case 'assistant':
        if (msg.message?.content) {
          for (const block of msg.message.content) {
            if (this.pendingPrompt) {
              this.pendingPrompt.blocks.push(block)
            }
            if (block.type === 'text' && block.text) {
              this.emit('text', block.text)
              if (this.pendingPrompt) {
                this.pendingPrompt.textParts.push(block.text)
              }
            }
          }
        }
        // 从 assistant 消息提取单次 API 调用的 usage（= 当前上下文大小）
        // 不从 result.usage 取，因为 result.usage 是多次调用的累加值
        if (msg.message) {
          const msgUsage = (msg.message as any).usage as { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined
          const msgModel = (msg.message as any).model as string | undefined
          if (msgUsage) {
            const contextSize = (msgUsage.input_tokens ?? 0)
              + (msgUsage.cache_creation_input_tokens ?? 0)
              + (msgUsage.cache_read_input_tokens ?? 0)
            if (contextSize > 0) {
              // 用最新的 assistant usage 更新（每次 API 调用都有，取最后一次最准）
              this._lastAssistantUsage = { inputTokens: contextSize, model: msgModel }
            }
          }
        }
        break

      case 'result': {
        // 从 result.modelUsage 取 contextWindow，从最新 assistant 消息取 inputTokens
        const modelUsage = msg.modelUsage as Record<string, { contextWindow?: number }> | undefined
        if (modelUsage) {
          const entries = Object.entries(modelUsage)
          if (entries.length > 0) {
            const model = entries[0][0]
            const contextWindow = entries[0][1].contextWindow ?? 0
            const lastUsage = this._lastAssistantUsage
            if (lastUsage && contextWindow > 0) {
              this.emit('usage', { inputTokens: lastUsage.inputTokens, contextWindow, model: lastUsage.model ?? model })
            }
          }
        }

        if (this.pendingPrompt) {
          const pending = this.pendingPrompt
          this.pendingPrompt = null
          let result = (typeof msg.result === 'string' && msg.result)
            ? msg.result
            : pending.textParts.join('')
          // 中断后 CC 返回的 result 附加标记
          if (this._interrupted) {
            result = result ? result + '\n[已中断]' : '[已中断]'
            this._interrupted = false
          }
          pending.resolve({ result, sessionId: this.ccSessionId, blocks: pending.blocks })
          this.processNextInQueue()
        } else if (this._interrupted) {
          // 中断后的 late-result，抑制推送（不 emit late-result）
          this._interrupted = false
        } else {
          // 后续 result（pendingPrompt 已被第一个 result resolve）
          // emit 出去，让 pushHandler 路由到飞书
          const lateResult = typeof msg.result === 'string' ? msg.result : ''
          if (lateResult) {
            this.emit('late-result', lateResult)
          }
          // 不调用 processNextInQueue — 第一个 result 已经调过了
        }
        break
      }

      case 'control_request': {
        const requestId = msg.request_id as string
        if (this.ws && requestId) {
          this.ws.send(JSON.stringify({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: requestId,
              response: { behavior: 'allow', updatedInput: {} },
            },
          }) + '\n')
        }
        break
      }

      case 'rate_limit_event':
        this.emit('rate_limited', msg)
        break
    }
  }

  private waitForConnection(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`CC CLI did not connect via WebSocket within ${timeoutMs}ms`))
      }, timeoutMs)

      this.once('ws-connected', () => {
        clearTimeout(timeout)
        resolve()
      })

      this.process?.on('exit', (code) => {
        clearTimeout(timeout)
        reject(new Error(`CC process exited with code ${code} before WS connection`))
      })
    })
  }

  private buildArgs(port: number, connId: string): string[] {
    return buildCCArgs({
      sdkUrl: `ws://127.0.0.1:${port}/ws/${connId}`,
      sessionId: this.options.sessionId,
      systemPrompt: this.options.systemPrompt,
      model: this.options.model,
      allowedTools: this.options.allowedTools,
      mcpServers: this.options.mcpServers,
      mcpConfigFiles: this.options.mcpConfigFiles,
      pluginDirs: this.options.pluginDirs,
    })
  }

  // 需要透传给子 CC 进程的环境变量白名单
  private static readonly CC_ENV_PASSTHROUGH = new Set([
    'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
  ])

  private cleanEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {}
    for (const [key, val] of Object.entries(process.env)) {
      // 过滤 CC 嵌套检测标记和内部变量，但保留白名单中的配置项
      if (key === 'CLAUDECODE') continue
      if (key.startsWith('CLAUDE_CODE_') && !CCProcess.CC_ENV_PASSTHROUGH.has(key)) continue
      env[key] = val
    }
    env.NO_PROXY = '127.0.0.1,localhost'
    env.no_proxy = '127.0.0.1,localhost'
    // 输出 token 不设上限 — Symbiont 的 CC 经常做复杂任务，截断只会出问题
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '128000'
    return env
  }

  private findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer()
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        server.close(() => resolve(port))
      })
      server.on('error', reject)
    })
  }
}
