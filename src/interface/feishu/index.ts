import type { IMPlugin, MessageHandler, MessageContent, IncomingMessage } from '../im-plugin.ts'
import type { Router } from '../../core/router.ts'
import { createFeishuClient, createFeishuWSClient, type FeishuConfig } from './client.ts'
import { createFeishuMcpServer, type FeishuMcpServerHandle } from './mcp-server.ts'
import { SessionMap } from './session-map.ts'
import { Whitelist } from './whitelist.ts'
import { MessageDedup } from './dedup.ts'
import { handleFeishuMessage } from './message-handler.ts'
import * as Lark from '@larksuiteoapi/node-sdk'

export type { FeishuConfig } from './client.ts'

export class FeishuPlugin implements IMPlugin {
  readonly name = 'feishu'
  private config: FeishuConfig
  private dataDir: string
  private wsClient: Lark.WSClient | null = null
  private router: Router | null = null
  private sessionMap: SessionMap
  private whitelist: Whitelist
  private dedup: MessageDedup
  private messageHandlers: MessageHandler[] = []
  private mcpServer: FeishuMcpServerHandle | null = null
  private db?: import('../../memory/db.ts').MemoryDB

  constructor(config: FeishuConfig, dataDir: string) {
    this.config = config
    this.dataDir = dataDir
    this.sessionMap = new SessionMap(dataDir)
    this.whitelist = new Whitelist(dataDir)
    this.dedup = new MessageDedup()

    // Initialize Lark HTTP Client
    createFeishuClient(config)
  }

  setDB(db: import('../../memory/db.ts').MemoryDB): void {
    this.db = db
  }

  setRouter(router: Router): void {
    this.router = router

    // 注册话题创建器，让 Router 在创建 fork 时能创建飞书话题
    router.setTopicCreator(async (parentSessionKey: string, title: string) => {
      const { createTopic } = await import('./topic.ts')

      const parentMapping = this.sessionMap.get(parentSessionKey)
      if (!parentMapping) throw new Error(`No chat mapping found for session: ${parentSessionKey}`)

      const chatId = parentMapping.chatId
      const threadId = await createTopic(chatId, `🔀 专员: ${title.slice(0, 30)}`, this.sessionMap)
      const topicSessionKey = `topic:${chatId}:${threadId}`

      // 获取 anchorMessageId 用于回复到话题
      const topicMapping = this.sessionMap.get(topicSessionKey)
      const anchorMessageId = topicMapping?.anchorMessageId

      // 注册 pushHandler 让专员的回复发到话题里（用 replyInThread 确保回复在话题内）
      router.setPushHandlerFor(topicSessionKey, async (text: string) => {
        if (anchorMessageId) {
          const { replyInThread } = await import('./send.ts')
          await replyInThread(anchorMessageId, text)
        } else {
          const { sendMarkdownCard } = await import('./send.ts')
          await sendMarkdownCard(chatId, text)
        }
      })

      return { sessionKey: topicSessionKey, threadId }
    })
  }

  getSessionMap(): SessionMap {
    return this.sessionMap
  }

  getWhitelist(): Whitelist {
    return this.whitelist
  }

  getMcpServer(): FeishuMcpServerHandle | null {
    return this.mcpServer
  }

  async connect(): Promise<void> {
    if (!this.router) throw new Error('Router not set. Call setRouter() first.')

    // Clear all instance IDs on restart (processes are gone)
    this.sessionMap.clearAllInstances()

    const botId = this.config.appId
    const botName = process.env.SYMBIONT_BOT_NAME ?? 'Symbiont'

    // Create event dispatcher
    const dispatcher = new Lark.EventDispatcher({})
    dispatcher.register({
      'im.message.receive_v1': async (event: any) => {
        try {
          // Notify IMPlugin handlers
          const incoming = this.parseIncoming(event)
          if (incoming) {
            for (const handler of this.messageHandlers) {
              await handler(incoming)
            }
          }

          // Core message handling
          await handleFeishuMessage(event, {
            router: this.router!,
            sessionMap: this.sessionMap,
            whitelist: this.whitelist,
            dedup: this.dedup,
            botId,
            botName,
            db: this.db,
          })
        } catch (err) {
          console.error('[feishu] message handling error:', err)
        }
      },
      'card.action.trigger': async (event: any) => {
        const { handleCardAction } = await import('./card-action.ts')
        return handleCardAction(event)
      },
    } as Record<string, (event: any) => any>)

    // Start WebSocket long connection
    console.log('[feishu] starting WSClient with appId:', this.config.appId)
    this.wsClient = createFeishuWSClient(this.config)
    this.wsClient.start({ eventDispatcher: dispatcher })
    console.log('[feishu] WSClient connected')

    // Debug: 直接监听 WSClient 的事件
    console.log('[feishu] dispatcher registered events:', Object.keys((dispatcher as any)?._events ?? {}).length > 0 ? 'yes' : 'no')

    // Start MCP server for CC tool access
    this.mcpServer = await createFeishuMcpServer(this.sessionMap, this.whitelist, this.db)
    console.log(`[feishu] MCP server started at ${this.mcpServer.url}`)
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler)
  }

  async send(chatId: string, content: MessageContent): Promise<void> {
    const { sendMarkdownCard, sendText } = await import('./send.ts')
    if (content.type === 'text' && content.text) {
      await sendMarkdownCard(chatId, content.text)
    }
  }

  async disconnect(): Promise<void> {
    if (this.mcpServer) {
      await this.mcpServer.close()
      this.mcpServer = null
    }
    this.wsClient = null
    console.log('[feishu] disconnected')
  }

  private parseIncoming(event: any): IncomingMessage | null {
    const msg = event?.message
    if (!msg) return null
    return {
      chatId: msg.chat_id,
      senderId: event?.sender?.sender_id?.open_id ?? '',
      content: {
        type: (msg.message_type as any) ?? 'text',
        text: msg.content,
      },
      raw: event,
      threadId: msg.thread_id,  // root_id 是引用回复，不是话题
      chatType: msg.chat_type as 'p2p' | 'group',
      messageId: msg.message_id,
    }
  }
}
