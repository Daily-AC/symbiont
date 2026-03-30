/**
 * IM 插件接口
 *
 * 蓝图 §9：IM 适配器作为插件接入，Sia Core 提供统一接口。
 * v1 实现飞书插件，其他 IM 后续按需添加。
 */

export interface MessageContent {
  type: 'text' | 'image' | 'file' | 'card' | 'post'
  text?: string
  url?: string
  data?: unknown
}

export interface IncomingMessage {
  /** 消息来源标识（群 ID / 用户 ID） */
  chatId: string
  /** 发送者标识 */
  senderId: string
  /** 消息内容 */
  content: MessageContent
  /** 原始消息（IM 平台原始格式） */
  raw?: unknown
  /** 话题 thread_id（有则为话题消息） */
  threadId?: string
  /** 私聊 / 群聊 */
  chatType?: 'p2p' | 'group'
  /** 消息 ID */
  messageId?: string
}

export type MessageHandler = (message: IncomingMessage) => Promise<void>

export interface IMPlugin {
  /** 插件名称 */
  name: string

  /** 连接到 IM 平台 */
  connect(): Promise<void>

  /** 注册消息处理回调 */
  onMessage(handler: MessageHandler): void

  /** 发送消息到指定目标 */
  send(chatId: string, content: MessageContent): Promise<void>

  /** 断开连接 */
  disconnect(): Promise<void>
}
