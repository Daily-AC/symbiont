import * as Lark from '@larksuiteoapi/node-sdk'

export interface FeishuConfig {
  appId: string
  appSecret: string
  encryptKey?: string
  verificationToken?: string
}

let clientInstance: Lark.Client | null = null
let wsClientInstance: Lark.WSClient | null = null
let _testClient: any = null

export function setTestClient(client: any): void { _testClient = client }

export function createFeishuClient(config: FeishuConfig): Lark.Client {
  if (clientInstance) return clientInstance
  clientInstance = new Lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    disableTokenCache: false,
  })
  return clientInstance
}

export function createFeishuWSClient(config: FeishuConfig): Lark.WSClient {
  if (wsClientInstance) return wsClientInstance
  wsClientInstance = new Lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
  })
  return wsClientInstance
}

export function getClient(): Lark.Client {
  if (_testClient) return _testClient
  if (!clientInstance) throw new Error('Feishu client not initialized')
  return clientInstance
}
