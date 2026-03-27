export interface WorkerTask {
  id: string
  description: string
  systemPrompt?: string
  cwd?: string
  parentSessionId: string
  /** worker 使用的 persona 名称（用于 Gateway 工具权限识别） */
  persona?: string
}

export interface WorkerResult {
  taskId: string
  success: boolean
  result: string
  sessionId: string | null
  duration: number
}
