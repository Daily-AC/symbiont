import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createMcpHttpServer, type McpHttpServerHandle } from './mcp-transport.ts'
import type { Logger } from './logger.ts'

export type { McpHttpServerHandle as SiaMcpServerHandle } from './mcp-transport.ts'

/** Coerce tags from MCP args to string[] (handles string, array, undefined) */
function coerceTags(raw: unknown): string[] {
  if (typeof raw === 'string') {
    // CC 可能传 JSON 字符串 '["tag1","tag2"]' 而非数组
    const trimmed = raw.trim()
    if (trimmed.startsWith('[')) {
      try { return coerceTags(JSON.parse(trimmed)) } catch { /* fall through */ }
    }
    return raw.split(',').map(t => t.trim()).filter(Boolean)
  }
  if (Array.isArray(raw)) {
    return raw
      .map(t => String(t).replace(/^[\["]+|[\]"]+$/g, '').trim())  // 清理残留的 [ ] "
      .filter(Boolean)
  }
  return []
}

export interface SiaMcpToolHandler {
  dispatchWorker: (description: string, systemPrompt?: string, allowedTools?: string[], isAsync?: boolean, persona?: string, sessionKey?: string) => Promise<string>
  createFork: (description: string, sessionKey?: string, createTopic?: boolean, persona?: string) => Promise<{ id: string }>
  completeFork: (summary: string, sessionKey?: string) => Promise<void>
  addMemoryCard: (content: string, scene: string, tags: string[], confidence?: number, sessionKey?: string) => Promise<string | { duplicates: Array<{ id: string; content: string; scene: string; similarity: number }> }>
  updateMemoryCard: (id: string, updates: { content?: string; scene?: string; tags?: string[]; confidence?: number }) => Promise<string>
  getMemoryCards: (keyword?: string, tags?: string[], scope?: 'self' | 'shared' | 'all', sessionKey?: string) => Promise<Array<{ id: string; content: string; scene: string; tags: string[]; confidence: number; owner: string; source?: 'exact' | 'semantic' }>>
  decayMemory: () => Promise<{ decayed: number; archived: number }>
  scanCognition: () => Promise<string[]>
  getSystemStatus: () => Record<string, unknown>
  getSystemLogs: (lines?: number) => string
  reload: (sessionKey: string, reason: string) => void
  scheduleRestart: (reason: string) => void
  cronAdd: (name: string, schedule: string, prompt: string, options?: { timezone?: string; oneShot?: boolean }) => { id: string; nextRun?: string }
  cronList: () => Array<{ id: string; name: string; schedule: string; enabled: boolean; nextRun?: string }>
  cronRemove: (id: string) => boolean
  personaList: () => Array<{ name: string; description: string; tags: string[] }>
  personaGet: (name: string) => string | undefined
  personaRescan: () => number
  listInstances: () => Array<{ id: string; role: string; state: string; description?: string; uptime: number }>
  killInstance: (id: string) => boolean
  compile: (target: string, content: string, reason: string, personaName?: string, sourceCards?: string[]) => string
  beginSettle: (sessionKey: string, reason?: string) => { prompt: string; usage: number }
  completeSettle: (sessionKey: string, summaryFile?: string) => void
  addWish: (title: string, reason?: string, priority?: string) => { id: string; title: string }
  wishList: (status?: string) => Array<{ id: string; title: string; status: string; priority: string }>
  updateWish: (id: string, updates: { status?: string; comment?: string }) => { id: string; title: string; status: string } | undefined
  reportIssue: (title: string, description?: string, severity?: string) => { id: string; title: string }
  issueList: (status?: string) => Array<{ id: string; title: string; severity: string; status: string; created_at: string }>
  issueGet: (id: string) => { id: string; title: string; description?: string; severity: string; status: string; resolution?: string; created_by: string; created_at: string; comments: string } | undefined
  updateIssue: (id: string, updates: { description?: string; severity?: string; status?: string; comment?: { author: string; content: string } }) => { id: string; title: string; status: string } | undefined
  closeIssue: (id: string, resolution?: string, status?: string) => { id: string; title: string; status: string } | undefined
  taskAdd: (title: string, description?: string, assignee?: string, priority?: string, due_date?: string) => { id: string; title: string; status: string; assignee: string; priority: string }
  taskUpdate: (id: string, updates: { status?: string; title?: string; description?: string; priority?: string; due_date?: string }) => { id: string; title: string; status: string } | undefined
  taskList: (status?: string, assignee?: string) => Array<{ id: string; title: string; status: string; assignee: string; priority: string; due_date?: string }>
  changelog: (limit?: number) => Array<{ id: string; version: string; commits: string[]; deployed_at: string; git_hash?: string }>
  configPersona: (personaName: string, field: 'mcp.tools' | 'skills.include', values: string[]) => string
  configShared: (field: 'mcp.always_available' | 'skills.always_available', values: string[]) => string
  listCapabilities: (personaName?: string) => { tools: string[]; skills: string[]; temporaryGrants?: string[] }
  grantTool: (sessionKey: string, toolName: string, durationMinutes?: number) => string
  revokeTool: (sessionKey: string, toolName: string) => string
  requestTool: (toolName: string, reason: string) => { id: string; title: string }
  requestSkill: (skillName: string, reason: string) => { id: string; title: string }
  listGatewayBackends: () => Array<{ name: string; url: string; tools: string[] }>
  addBackend: (name: string, url: string, description?: string) => Promise<{ tools: string[] }>
  removeBackend: (name: string) => boolean
}

const toolDefinitions = [
  {
    name: 'symbiont_dispatch_worker',
    description: '派遣一个工人 Agent 执行一次性任务。工人不会与用户交互，完成后返回结果。适用于编码、分析、搜索等独立任务。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        description: { type: 'string', description: '任务描述' },
        persona: { type: 'string', description: '指定 persona pack 名称（如 "code-reviewer"）。不指定则自动匹配，都不匹配用 default。用 symbiont_persona_list 查看可用角色。' },
        system_prompt: { type: 'string', description: '工人的 system prompt（可选，指定后覆盖 persona）' },
        allowed_tools: { type: 'array', items: { type: 'string' }, description: '允许使用的工具列表（可选，默认全部）' },
        async: { type: 'boolean', description: '异步模式：立即返回任务ID，工人后台执行，完成后结果会注入主对话供你审核（默认 false）' },
      },
      required: ['description'],
    },
  },
  {
    name: 'symbiont_create_fork',
    description: '创建一个专员分叉（异步，立即返回）。专员是你的分身，可以与用户进行深度对话处理复杂任务。create_topic=true 时会在飞书创建话题，专员在话题中与用户对话，不阻塞你。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        description: { type: 'string', description: '分叉任务描述' },
        persona: { type: 'string', description: '指定专员的 persona pack 名称（如 "code-reviewer"）。不指定则自动匹配。' },
        create_topic: { type: 'boolean', description: '是否在飞书中创建话题来承载专员对话（推荐为 true，这样不会替换主对话）' },
      },
      required: ['description'],
    },
  },
  {
    name: 'symbiont_complete_fork',
    description: '完成当前的专员分叉，生成摘要回传主会话。',
    inputSchema: {
      type: 'object' as const,
      properties: { summary: { type: 'string', description: '任务摘要' } },
      required: ['summary'],
    },
  },
  {
    name: 'symbiont_remember',
    description: '记录一条经验卡片到记忆系统。用于保存重要的经验教训、解决方案、用户偏好等。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: '经验内容' },
        scene: { type: 'string', description: '适用场景' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签（3-5个）' },
        confidence: { type: 'number', description: '置信度 0-1，默认 0.7' },
      },
      required: ['content', 'scene', 'tags'],
    },
  },
  {
    name: 'symbiont_update_memory',
    description: '更新已有的经验卡片。当 symbiont_remember 返回重复提示时，可用此工具更新已有卡片而非新建。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: '要更新的卡片 ID' },
        content: { type: 'string', description: '新的经验内容（不填则不改）' },
        scene: { type: 'string', description: '新的适用场景（不填则不改）' },
        tags: { type: 'array', items: { type: 'string' }, description: '新的标签（不填则不改）' },
        confidence: { type: 'number', description: '新的置信度 0-1（不填则不改）' },
      },
      required: ['id'],
    },
  },
  {
    name: 'symbiont_recall',
    description: '从记忆系统搜索经验卡片。按关键词或标签检索相关经验。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        keyword: { type: 'string', description: '搜索关键词' },
        tags: { type: 'array', items: { type: 'string' }, description: '按标签过滤' },
        scope: { type: 'string', enum: ['self', 'shared', 'all'], description: '搜索范围：self=只看自己的记忆（默认），shared=共享知识库，all=所有人的（需要主角色权限）' },
      },
    },
  },
  {
    name: 'symbiont_scan_cognition',
    description: '扫描经验卡片，发现可以聚合的认知模式（同标签 ≥5 张卡片）。',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'symbiont_system_status',
    description: '获取 Symbiont 系统状态快照：CC 实例池、记忆统计、定时任务、认知候选等。用于诊断问题和了解系统健康。',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'symbiont_system_logs',
    description: '读取 Symbiont 系统日志（NDJSON 格式）。返回最近 N 行日志，包含时间、级别、模块、事件。用于排查问题和了解系统行为。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        lines: { type: 'number', description: '返回最近多少行日志，默认 50' },
      },
    },
  },
  {
    name: 'symbiont_reload',
    description: '重启 Symbiont。修改了 MCP 配置时只重启 CC 实例（快，3 秒）；涉及 Symbiont 源码变更时重启整个 Symbiont Core（5 秒，会短暂断连但 systemd 自动恢复）。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        reason: { type: 'string', description: '为什么需要重启（如"装了新的飞书文档 skill"）' },
        full: { type: 'boolean', description: '是否重启 Symbiont Core（涉及源码变更时设为 true，默认 false 只重启 CC）' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'symbiont_cron_add',
    description: '创建持久化定时任务（跨会话存活）。用标准 cron 表达式。比 CC 内置的 CronCreate 更可靠——任务存在 Symbiont Core 里，重启不丢失。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: '任务名称（如"叫以琳起床"）' },
        schedule: { type: 'string', description: '标准 cron 表达式（如 "0 8 * * *" = 每天 8 点，"*/30 * * * *" = 每 30 分钟）' },
        prompt: { type: 'string', description: '触发时执行的 prompt（发给你自己处理）' },
        timezone: { type: 'string', description: '时区，默认 Asia/Shanghai' },
        one_shot: { type: 'boolean', description: '是否一次性任务（执行后自动删除），默认 false' },
      },
      required: ['name', 'schedule', 'prompt'],
    },
  },
  {
    name: 'symbiont_cron_list',
    description: '列出所有持久化定时任务。',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'symbiont_cron_remove',
    description: '删除一个持久化定时任务。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: '任务 ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'symbiont_persona_list',
    description: '列出所有可用的 persona pack（角色包）。派工人或专员前先看看有哪些角色可选。',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'symbiont_persona_rescan',
    description: '重新扫描 persona-packs 目录，加载运行时新增的角色包。创建新 pack 后调用此工具让系统识别。',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'symbiont_list_instances',
    description: '列出所有正在运行的 CC 实例（主实例、专员、工人）。用于了解当前系统负载和管理实例。',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'symbiont_kill_instance',
    description: '终止一个 CC 实例（工人或专员）。用于取消不需要的任务或清理卡死的实例。不能终止主实例。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        instance_id: { type: 'string', description: '要终止的实例 ID（从 symbiont_list_instances 获取）' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'symbiont_compile',
    description: '将反思中发现的规律编译成长期知识。支持四个写入目标：identity（写入 identity.md 的"编译知识"节）、cc_memory（写入 CC 持久记忆文件）、persona（写入指定角色包的 soul）、shared（写入共享知识库，所有角色可见）。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', enum: ['identity', 'cc_memory', 'persona', 'shared'], description: '写入目标：identity=核心决策框架, cc_memory=CC 长期知识, persona=角色包经验, shared=共享知识库' },
        content: { type: 'string', description: '要写入的规律/知识（一条简洁的规则）' },
        reason: { type: 'string', description: '为什么这条知识值得编译（来自什么经验）' },
        persona_name: { type: 'string', description: '角色包名称（target=persona 时必填）' },
        source_cards: { type: 'array', items: { type: 'string' }, description: '来源经验卡片 ID（可追溯）' },
      },
      required: ['target', 'content', 'reason'],
    },
  },
  {
    name: 'symbiont_settle',
    description: '触发上下文沉淀流程：整理记忆、写会话总结、准备开新会话。当上下文快满时主动调用，避免被动 compact 丢失信息。也可手动调用来整理当前会话。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        reason: { type: 'string', description: '沉淀原因（如"上下文快满了"、"话题切换，先整理一下"）' },
      },
    },
  },
  {
    name: 'symbiont_settle_done',
    description: '标记上下文沉淀完成。在完成 symbiont_settle 的所有步骤（记忆整理、写会话总结文件）后调用此工具。必须传入总结文件路径，新会话将读取该文件恢复上下文。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        summary_file: { type: 'string', description: '会话总结文件的绝对路径（你在工作区中写好的总结文件）' },
      },
      required: ['summary_file'],
    },
  },
  {
    name: 'symbiont_wish',
    description: '许愿池：向以琳许一个愿望（功能请求、想要的改进、希望学会的东西等）。愿望会出现在监控看板上，等待以琳批准或拒绝。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: '愿望标题（简洁描述你想要什么）' },
        reason: { type: 'string', description: '为什么想要这个（可选）' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'], description: '优先级（默认 normal）' },
      },
      required: ['title'],
    },
  },
  {
    name: 'symbiont_wish_list',
    description: '查看许愿池中的所有愿望及状态。可按状态过滤。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: ['pending', 'accepted', 'rejected', 'done'], description: '按状态过滤' },
      },
    },
  },
  {
    name: 'symbiont_update_wish',
    description: '更新许愿池中的愿望状态。用于标记已完成(done)的愿望或更新评论。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: '愿望 ID' },
        status: { type: 'string', enum: ['pending', 'accepted', 'rejected', 'done'], description: '新状态' },
        comment: { type: 'string', description: '评论/备注' },
      },
      required: ['id'],
    },
  },
  {
    name: 'symbiont_task_add',
    description: '创建一个任务到任务板。任务会出现在监控看板的任务 tab 中。用于跟踪待办事项、开发任务等。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: '任务标题' },
        description: { type: 'string', description: '任务详细描述（可选）' },
        assignee: { type: 'string', enum: ['xiaoxi', 'yilin'], description: '指派给谁（默认 xiaoxi）' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: '优先级（默认 normal）' },
        due_date: { type: 'string', description: '截止日期，ISO 格式如 2026-03-25（可选）' },
      },
      required: ['title'],
    },
  },
  {
    name: 'symbiont_task_update',
    description: '更新任务板中的一个任务。可以修改状态、标题、描述、优先级、截止日期。状态改为 done 时自动记录完成时间。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: '任务 ID' },
        status: { type: 'string', enum: ['todo', 'doing', 'done', 'cancelled'], description: '任务状态' },
        title: { type: 'string', description: '新标题' },
        description: { type: 'string', description: '新描述' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: '新优先级' },
        due_date: { type: 'string', description: '新截止日期' },
      },
      required: ['id'],
    },
  },
  {
    name: 'symbiont_task_list',
    description: '列出任务板中的任务。可按状态和指派人过滤。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: ['todo', 'doing', 'done', 'cancelled'], description: '按状态过滤' },
        assignee: { type: 'string', enum: ['xiaoxi', 'yilin'], description: '按指派人过滤' },
      },
    },
  },
  {
    name: 'symbiont_report_issue',
    description: '报告问题：向以琳报告一个问题（bug、异常、需要关注的事项等）。问题会出现在监控看板的 Issue tab 上，等待以琳处理。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: '问题标题（简洁描述问题）' },
        description: { type: 'string', description: '问题详细描述（可选）' },
        severity: { type: 'string', enum: ['low', 'normal', 'high', 'critical'], description: '严重程度（默认 normal）' },
      },
      required: ['title'],
    },
  },
  {
    name: 'symbiont_issue_list',
    description: '列出所有 issue。可按状态过滤（open/investigating/resolved/wontfix）。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: ['open', 'investigating', 'resolved', 'wontfix'], description: '按状态过滤' },
      },
    },
  },
  {
    name: 'symbiont_issue_get',
    description: '查看某个 issue 的详细信息，包括完整描述、评论讨论、解决方案等。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Issue ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'symbiont_update_issue',
    description: '更新已有问题的描述、严重程度或状态，或在 issue 上发表评论讨论。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: '问题 ID' },
        description: { type: 'string', description: '新的问题描述' },
        severity: { type: 'string', enum: ['low', 'normal', 'high', 'critical'], description: '新的严重程度' },
        status: { type: 'string', enum: ['open', 'investigating', 'resolved', 'wontfix'], description: '新的状态' },
        comment: { type: 'string', description: '评论内容（讨论、反馈、补充信息）' },
      },
      required: ['id'],
    },
  },
  {
    name: 'symbiont_close_issue',
    description: '关闭一个问题。状态默认设为 resolved，也可以设为 wontfix。可附带解决方案说明。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: '问题 ID' },
        resolution: { type: 'string', description: '解决方案说明（可选）' },
        status: { type: 'string', enum: ['resolved', 'wontfix'], description: '关闭状态（默认 resolved）' },
      },
      required: ['id'],
    },
  },
  {
    name: 'symbiont_changelog',
    description: '查看 Symbiont 系统更新日志。列出最近的版本部署记录，包括 commit 列表和部署时间。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: '返回多少条记录，默认 10' },
      },
    },
  },
  {
    name: 'symbiont_config_persona',
    description: '更新某个 persona 的配置（MCP 工具权限或 Skill 权限）。修改后自动生效，Gateway 会重新计算权限。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        persona_name: { type: 'string', description: 'persona pack 目录名（如 "code-reviewer"、"default"、"frontend"）' },
        field: { type: 'string', enum: ['mcp.tools', 'skills.include'], description: '要修改的字段' },
        values: { type: 'array', items: { type: 'string' }, description: '新的值列表（如 ["symbiont_*"] 或 ["code-review", "deploy"]）' },
      },
      required: ['persona_name', 'field', 'values'],
    },
  },
  {
    name: 'symbiont_config_shared',
    description: '更新公用白名单配置。所有角色都能使用公用白名单中的工具和 skill。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        field: { type: 'string', enum: ['mcp.always_available', 'skills.always_available'], description: '要修改的字段' },
        values: { type: 'array', items: { type: 'string' }, description: '新的值列表' },
      },
      required: ['field', 'values'],
    },
  },
  {
    name: 'symbiont_list_capabilities',
    description: '查看某个角色的完整能力列表（合并 persona 配置 + 公用白名单 + 临时授权后的结果）。不指定角色名则列出所有角色的能力。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        persona_name: { type: 'string', description: 'persona 名称（可选，不填则列出所有）' },
      },
    },
  },
  {
    name: 'symbiont_grant_tool',
    description: '临时给某个会话开通工具权限。默认 60 分钟后自动过期。用于工人/专员申请后的临时授权。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_key: { type: 'string', description: '目标会话的 session key' },
        tool_name: { type: 'string', description: '要授权的工具名' },
        duration_minutes: { type: 'number', description: '授权时长（分钟），默认 60' },
      },
      required: ['session_key', 'tool_name'],
    },
  },
  {
    name: 'symbiont_revoke_tool',
    description: '回收某个会话的临时工具权限。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_key: { type: 'string', description: '目标会话的 session key' },
        tool_name: { type: 'string', description: '要回收的工具名' },
      },
      required: ['session_key', 'tool_name'],
    },
  },
  {
    name: 'symbiont_request_tool',
    description: '向小希申请使用某个工具（工人/专员用）。申请会记录到许愿池，等待小希审批并 grant。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tool_name: { type: 'string', description: '想申请的工具名' },
        reason: { type: 'string', description: '申请原因' },
      },
      required: ['tool_name', 'reason'],
    },
  },
  {
    name: 'symbiont_request_skill',
    description: '向小希申请使用某个 Skill（工人/专员用）。申请会记录到许愿池，等待小希审批。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        skill_name: { type: 'string', description: '想申请的 skill 名' },
        reason: { type: 'string', description: '申请原因' },
      },
      required: ['skill_name', 'reason'],
    },
  },
  {
    name: 'symbiont_gateway_backends',
    description: '查看 MCP Gateway 上所有已注册的后端及其工具列表（按后端分组）。',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'symbiont_mcp_add_backend',
    description: '添加第三方 MCP Server 到 Gateway。添加后 CC 自动刷新工具列表，不需要重启。添加后还需用 symbiont_config_persona 给对应角色授权（格式: "后端名:*" 或 "后端名:工具名"）。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: '后端名（也是分组名，如 "github"）' },
        url: { type: 'string', description: 'MCP Server 的 HTTP endpoint URL' },
        description: { type: 'string', description: '可选描述' },
      },
      required: ['name', 'url'],
    },
  },
  {
    name: 'symbiont_mcp_remove_backend',
    description: '从 Gateway 移除第三方 MCP Server。内置后端（symbiont-core, symbiont-feishu）不可移除。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: '要移除的后端名' },
      },
      required: ['name'],
    },
  },
]

/**
 * Symbiont MCP Server — 让主 Agent 的 CC 能自主调用 Symbiont Core 的功能。
 */
export async function createSiaMcpServer(
  handler: SiaMcpToolHandler,
  logger: Logger,
): Promise<McpHttpServerHandle> {
  async function handleToolCall(name: string, args: Record<string, unknown> | undefined, sessionKey?: string) {
    logger.info('mcp', 'tool-call', { name, args, sessionKey })

    switch (name) {
      case 'symbiont_dispatch_worker':
        return handler.dispatchWorker(
          args?.description as string,
          args?.system_prompt as string | undefined,
          args?.allowed_tools as string[] | undefined,
          args?.async as boolean | undefined,
          args?.persona as string | undefined,
          sessionKey,
        ).then(r => ({ content: [{ type: 'text' as const, text: r }] }))
      case 'symbiont_create_fork': {
        const forkDesc = args?.description as string
        const createTopic = args?.create_topic as boolean | undefined
        const forkPersona = args?.persona as string | undefined
        // 异步创建：立即返回，后台启动专员
        handler.createFork(forkDesc, sessionKey, createTopic, forkPersona)
          .then(f => logger.info('mcp', 'fork-created-async', { forkId: f.id, sessionKey }))
          .catch(err => logger.error('mcp', 'fork-create-failed', { error: (err as Error).message, sessionKey }))
        return Promise.resolve({ content: [{ type: 'text' as const, text: `专员正在创建中（话题模式: ${createTopic ? '是' : '否'}）。创建完成后专员会在话题中开始工作。` }] })
      }
      case 'symbiont_complete_fork':
        return handler.completeFork(args?.summary as string, sessionKey)
          .then(() => ({ content: [{ type: 'text' as const, text: '分叉已完成' }] }))
      case 'symbiont_remember': {
        return handler.addMemoryCard(
          args?.content as string, args?.scene as string,
          coerceTags(args?.tags), (args?.confidence as number) ?? 0.7, sessionKey,
        ).then(result => {
          if (typeof result === 'string') {
            return { content: [{ type: 'text' as const, text: `已记录: ${result}` }] }
          }
          // Dedup: found similar cards
          const dupes = result.duplicates
          const lines = dupes.map(d =>
            `  - [${d.id}] (相似度 ${(d.similarity * 100).toFixed(0)}%) ${d.content.slice(0, 80)} (场景: ${d.scene})`
          ).join('\n')
          return { content: [{ type: 'text' as const, text:
            `⚠️ 发现语义相似的已有卡片:\n${lines}\n\n请选择:\n` +
            `1. 用 symbiont_update_memory 更新已有卡片\n` +
            `2. 用 symbiont_remember 新建并在内容中注明是对旧卡片的迭代（系统会自动建立 evolves 关系）\n` +
            `3. 如确认需要新建，在 content 前加 "[force]" 前缀强制写入` }] }
        })
      }
      case 'symbiont_update_memory': {
        const id = args?.id as string
        const updates: { content?: string; scene?: string; tags?: string[]; confidence?: number } = {}
        if (args?.content !== undefined) updates.content = args.content as string
        if (args?.scene !== undefined) updates.scene = args.scene as string
        if (args?.tags !== undefined) updates.tags = coerceTags(args.tags)
        if (args?.confidence !== undefined) updates.confidence = args.confidence as number
        return handler.updateMemoryCard(id, updates)
          .then(text => ({ content: [{ type: 'text' as const, text }] }))
      }
      case 'symbiont_recall':
        return handler.getMemoryCards(
          args?.keyword as string | undefined,
          args?.tags ? coerceTags(args.tags) : undefined,
          args?.scope as 'self' | 'shared' | 'all' | undefined,
          sessionKey,
        ).then(cards => {
            if (cards.length === 0) return { content: [{ type: 'text' as const, text: '未找到相关记忆' }] }
            const exactCards = cards.filter((c: any) => c.source === 'exact')
            const semanticCards = cards.filter((c: any) => c.source === 'semantic')
            const formatCard = (c: any) => `[${c.confidence.toFixed(2)}] [${c.id}] [${c.owner}] ${c.content} (场景: ${c.scene}, 标签: ${c.tags.join(',')})`
            const parts: string[] = []
            if (exactCards.length > 0) {
              parts.push(`📌 精确匹配 (${exactCards.length}):\n${exactCards.map(formatCard).join('\n')}`)
            }
            if (semanticCards.length > 0) {
              parts.push(`🔍 语义召回 (${semanticCards.length}):\n${semanticCards.map(formatCard).join('\n')}`)
            }
            return { content: [{ type: 'text' as const, text: parts.join('\n\n') }] }
          })
      case 'symbiont_scan_cognition':
        return handler.scanCognition()
          .then(tags => ({ content: [{ type: 'text' as const, text: tags.length > 0 ? `可聚合标签: ${tags.join(', ')}` : '暂无可聚合的认知' }] }))
      case 'symbiont_system_status':
        return Promise.resolve({ content: [{ type: 'text' as const, text: JSON.stringify(handler.getSystemStatus(), null, 2) }] })
      case 'symbiont_system_logs':
        return Promise.resolve({ content: [{ type: 'text' as const, text: handler.getSystemLogs((args?.lines as number) ?? 50) }] })
      case 'symbiont_reload': {
        const reason = args?.reason as string ?? 'manual reload'
        const full = args?.full as boolean ?? false
        if (full) {
          handler.scheduleRestart(reason)
          return Promise.resolve({ content: [{ type: 'text' as const, text: `收到，5 秒后重启 Symbiont Core。原因：${reason}。systemd 会自动恢复，届时你会短暂断连。` }] })
        }
        handler.reload('current', reason)
        return Promise.resolve({ content: [{ type: 'text' as const, text: `收到，3 秒后重启 CC 实例。原因：${reason}。对话上下文会保持。` }] })
      }
      case 'symbiont_cron_add': {
        const result = handler.cronAdd(
          args?.name as string,
          args?.schedule as string,
          args?.prompt as string,
          { timezone: args?.timezone as string | undefined, oneShot: args?.one_shot as boolean | undefined },
        )
        return Promise.resolve({ content: [{ type: 'text' as const, text: `定时任务已创建: ${result.id}（${args?.name}）` }] })
      }
      case 'symbiont_cron_list': {
        const jobs = handler.cronList()
        if (jobs.length === 0) return Promise.resolve({ content: [{ type: 'text' as const, text: '当前没有定时任务' }] })
        const text = jobs.map(j => `- [${j.enabled ? '✓' : '✗'}] ${j.name} (${j.schedule}) ID: ${j.id}`).join('\n')
        return Promise.resolve({ content: [{ type: 'text' as const, text }] })
      }
      case 'symbiont_cron_remove': {
        const ok = handler.cronRemove(args?.id as string)
        return Promise.resolve({ content: [{ type: 'text' as const, text: ok ? '已删除' : '任务不存在' }] })
      }
      case 'symbiont_persona_list': {
        const personas = handler.personaList()
        if (personas.length === 0) return Promise.resolve({ content: [{ type: 'text' as const, text: '没有可用的 persona pack' }] })
        const text = personas.map(p => `- **${p.name}**: ${p.description} [${Array.isArray(p.tags) ? p.tags.join(', ') : String(p.tags || '')}]`).join('\n')
        return Promise.resolve({ content: [{ type: 'text' as const, text }] })
      }
      case 'symbiont_persona_rescan': {
        const added = handler.personaRescan()
        return Promise.resolve({ content: [{ type: 'text' as const, text: added > 0 ? `扫描完成，新增 ${added} 个 persona pack` : '扫描完成，无新增' }] })
      }
      case 'symbiont_list_instances': {
        const instances = handler.listInstances()
        if (instances.length === 0) return Promise.resolve({ content: [{ type: 'text' as const, text: '当前没有运行中的实例' }] })
        const text = instances.map(i =>
          `- [${i.role}] ${i.id} | ${i.state} | ${Math.round(i.uptime / 1000)}s${i.description ? ` | ${i.description}` : ''}`
        ).join('\n')
        return Promise.resolve({ content: [{ type: 'text' as const, text }] })
      }
      case 'symbiont_kill_instance': {
        const instanceId = args?.instance_id as string
        const ok = handler.killInstance(instanceId)
        return Promise.resolve({ content: [{ type: 'text' as const, text: ok ? `已终止实例 ${instanceId}` : `实例 ${instanceId} 不存在或是主实例（不可终止）` }] })
      }
      case 'symbiont_compile': {
        const target = args?.target as string
        const content = args?.content as string
        const reason = args?.reason as string
        const personaName = args?.persona_name as string | undefined
        const sourceCards = args?.source_cards as string[] | undefined
        const filePath = handler.compile(target, content, reason, personaName, sourceCards)
        return Promise.resolve({ content: [{ type: 'text' as const, text: `已编译到: ${filePath}` }] })
      }
      case 'symbiont_settle': {
        const reason = args?.reason as string | undefined
        const result = handler.beginSettle(sessionKey ?? 'unknown', reason)
        return Promise.resolve({ content: [{ type: 'text' as const, text: result.prompt }] })
      }
      case 'symbiont_settle_done': {
        const summaryFile = args?.summary_file as string | undefined
        handler.completeSettle(sessionKey ?? 'unknown', summaryFile)
        return Promise.resolve({ content: [{ type: 'text' as const, text: '沉淀已完成，状态已重置。即将切换到新会话。' }] })
      }
      case 'symbiont_wish': {
        const wish = handler.addWish(
          args?.title as string,
          args?.reason as string | undefined,
          args?.priority as string | undefined,
        )
        return Promise.resolve({ content: [{ type: 'text' as const, text: `愿望已许下: ${wish.title} (${wish.id})` }] })
      }
      case 'symbiont_wish_list': {
        const wishes = handler.wishList(args?.status as string | undefined)
        if (wishes.length === 0) return Promise.resolve({ content: [{ type: 'text' as const, text: '许愿池为空' }] })
        const text = wishes.map(w => `- [${w.status}] ${w.title} (${w.priority}) | ID: ${w.id}`).join('\n')
        return Promise.resolve({ content: [{ type: 'text' as const, text }] })
      }
      case 'symbiont_update_wish': {
        const updated = handler.updateWish(args?.id as string, {
          status: args?.status as string | undefined,
          comment: args?.comment as string | undefined,
        })
        if (!updated) return Promise.resolve({ content: [{ type: 'text' as const, text: '愿望不存在' }], isError: true as const })
        return Promise.resolve({ content: [{ type: 'text' as const, text: `愿望已更新: ${updated.title} [${updated.status}]` }] })
      }
      case 'symbiont_task_add': {
        const task = handler.taskAdd(
          args?.title as string,
          args?.description as string | undefined,
          args?.assignee as string | undefined,
          args?.priority as string | undefined,
          args?.due_date as string | undefined,
        )
        return Promise.resolve({ content: [{ type: 'text' as const, text: `任务已创建: ${task.title} (${task.id})` }] })
      }
      case 'symbiont_task_update': {
        const updated = handler.taskUpdate(
          args?.id as string,
          {
            status: args?.status as string | undefined,
            title: args?.title as string | undefined,
            description: args?.description as string | undefined,
            priority: args?.priority as string | undefined,
            due_date: args?.due_date as string | undefined,
          },
        )
        if (!updated) return Promise.resolve({ content: [{ type: 'text' as const, text: '任务不存在' }], isError: true as const })
        return Promise.resolve({ content: [{ type: 'text' as const, text: `任务已更新: ${updated.title} [${updated.status}]` }] })
      }
      case 'symbiont_task_list': {
        const tasks = handler.taskList(
          args?.status as string | undefined,
          args?.assignee as string | undefined,
        )
        if (tasks.length === 0) return Promise.resolve({ content: [{ type: 'text' as const, text: '当前没有任务' }] })
        const text = tasks.map((t) => {
          const priority = t.priority === 'urgent' ? '[!!!]' : t.priority === 'high' ? '[!!]' : t.priority === 'low' ? '[.]' : ''
          const due = t.due_date ? ` (截止: ${t.due_date})` : ''
          return `- [${t.status}] ${priority} ${t.title}${due} → ${t.assignee} | ID: ${t.id}`
        }).join('\n')
        return Promise.resolve({ content: [{ type: 'text' as const, text }] })
      }
      case 'symbiont_report_issue': {
        const issue = handler.reportIssue(
          args?.title as string,
          args?.description as string | undefined,
          args?.severity as string | undefined,
        )
        return Promise.resolve({ content: [{ type: 'text' as const, text: `问题已报告: ${issue.title} (${issue.id})` }] })
      }
      case 'symbiont_issue_list': {
        const issues = handler.issueList(args?.status as string | undefined)
        if (issues.length === 0) return Promise.resolve({ content: [{ type: 'text' as const, text: '当前没有 issue' }] })
        const text = issues.map(i => `- [${i.status}] [${i.severity}] ${i.title} | ID: ${i.id}`).join('\n')
        return Promise.resolve({ content: [{ type: 'text' as const, text }] })
      }
      case 'symbiont_issue_get': {
        const issue = handler.issueGet(args?.id as string)
        if (!issue) return Promise.resolve({ content: [{ type: 'text' as const, text: 'Issue 不存在' }], isError: true as const })
        let text = `## ${issue.title}\n\n`
        text += `**状态**: ${issue.status} | **严重度**: ${issue.severity} | **创建者**: ${issue.created_by}\n`
        text += `**创建时间**: ${issue.created_at}\n\n`
        if (issue.description) text += `**描述**:\n${issue.description}\n\n`
        if (issue.resolution) text += `**解决方案**: ${issue.resolution}\n\n`
        let comments: any[] = []
        try { comments = JSON.parse(issue.comments || '[]') } catch {}
        if (comments.length > 0) {
          text += `**评论 (${comments.length})**:\n`
          for (const c of comments) {
            text += `- [${c.author}] ${c.content}\n`
          }
        }
        return Promise.resolve({ content: [{ type: 'text' as const, text }] })
      }
      case 'symbiont_update_issue': {
        const commentText = args?.comment as string | undefined
        const updated = handler.updateIssue(
          args?.id as string,
          {
            description: args?.description as string | undefined,
            severity: args?.severity as string | undefined,
            status: args?.status as string | undefined,
            comment: commentText ? { author: 'xiaoxi', content: commentText } : undefined,
          },
        )
        if (!updated) return Promise.resolve({ content: [{ type: 'text' as const, text: '问题不存在' }], isError: true as const })
        const reply = commentText ? `评论已添加: "${commentText}"` : `问题已更新: ${updated.title} [${updated.status}]`
        return Promise.resolve({ content: [{ type: 'text' as const, text: reply }] })
      }
      case 'symbiont_close_issue': {
        const closed = handler.closeIssue(
          args?.id as string,
          args?.resolution as string | undefined,
          args?.status as string | undefined,
        )
        if (!closed) return Promise.resolve({ content: [{ type: 'text' as const, text: '问题不存在' }], isError: true as const })
        return Promise.resolve({ content: [{ type: 'text' as const, text: `问题已关闭: ${closed.title} [${closed.status}]` }] })
      }
      case 'symbiont_changelog': {
        const releases = handler.changelog((args?.limit as number) ?? 10)
        if (releases.length === 0) return Promise.resolve({ content: [{ type: 'text' as const, text: '暂无更新记录' }] })
        const text = releases.map(r => {
          const commits = r.commits.map(c => `  - ${c}`).join('\n')
          return `## ${r.version} (${r.deployed_at.slice(0, 10)})${r.git_hash ? ` [${r.git_hash.slice(0, 8)}]` : ''}\n${commits}`
        }).join('\n\n')
        return Promise.resolve({ content: [{ type: 'text' as const, text }] })
      }
      case 'symbiont_config_persona': {
        const text = handler.configPersona(
          args?.persona_name as string,
          args?.field as 'mcp.tools' | 'skills.include',
          args?.values as string[],
        )
        return Promise.resolve({ content: [{ type: 'text' as const, text }] })
      }
      case 'symbiont_config_shared': {
        const text = handler.configShared(
          args?.field as 'mcp.always_available' | 'skills.always_available',
          args?.values as string[],
        )
        return Promise.resolve({ content: [{ type: 'text' as const, text }] })
      }
      case 'symbiont_list_capabilities': {
        const caps = handler.listCapabilities(args?.persona_name as string | undefined)
        return Promise.resolve({ content: [{ type: 'text' as const, text: JSON.stringify(caps, null, 2) }] })
      }
      case 'symbiont_grant_tool': {
        const text = handler.grantTool(
          args?.session_key as string,
          args?.tool_name as string,
          args?.duration_minutes as number | undefined,
        )
        return Promise.resolve({ content: [{ type: 'text' as const, text }] })
      }
      case 'symbiont_revoke_tool': {
        const text = handler.revokeTool(
          args?.session_key as string,
          args?.tool_name as string,
        )
        return Promise.resolve({ content: [{ type: 'text' as const, text }] })
      }
      case 'symbiont_request_tool': {
        const result = handler.requestTool(
          args?.tool_name as string,
          args?.reason as string,
        )
        return Promise.resolve({ content: [{ type: 'text' as const, text: `已提交工具申请: ${result.title} (ID: ${result.id})。等待小希审批。` }] })
      }
      case 'symbiont_request_skill': {
        const result = handler.requestSkill(
          args?.skill_name as string,
          args?.reason as string,
        )
        return Promise.resolve({ content: [{ type: 'text' as const, text: `已提交 Skill 申请: ${result.title} (ID: ${result.id})。等待小希审批。` }] })
      }
      case 'symbiont_gateway_backends': {
        const backends = handler.listGatewayBackends()
        const lines = backends.map(b => `**${b.name}** (${b.url})\n  ${b.tools.length} 个工具: ${b.tools.join(', ')}`)
        const text = lines.length > 0 ? lines.join('\n\n') : '无已注册后端'
        return Promise.resolve({ content: [{ type: 'text' as const, text }] })
      }
      case 'symbiont_mcp_add_backend': {
        const bName = args?.name as string
        const bUrl = args?.url as string
        const bDesc = args?.description as string | undefined
        if (!bName || !bUrl) {
          return Promise.resolve({ content: [{ type: 'text' as const, text: '❌ name 和 url 为必填参数' }], isError: true as const })
        }
        const result = await handler.addBackend(bName, bUrl, bDesc)
        const toolList = result.tools.length > 0 ? result.tools.join(', ') : '（无工具）'
        return Promise.resolve({ content: [{ type: 'text' as const, text: `✅ 已添加后端 **${bName}** (${bUrl})\n发现 ${result.tools.length} 个工具: ${toolList}\n\n提示：用 symbiont_config_persona 授权角色使用此后端的工具（格式: "${bName}:*"）` }] })
      }
      case 'symbiont_mcp_remove_backend': {
        const bName = args?.name as string
        if (!bName) {
          return Promise.resolve({ content: [{ type: 'text' as const, text: '❌ name 为必填参数' }], isError: true as const })
        }
        const removed = handler.removeBackend(bName)
        if (removed) {
          return Promise.resolve({ content: [{ type: 'text' as const, text: `✅ 已移除后端 **${bName}**` }] })
        }
        return Promise.resolve({ content: [{ type: 'text' as const, text: `❌ 无法移除 "${bName}"（不存在或为内置后端）` }], isError: true as const })
      }
      default:
        return Promise.resolve({ content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true as const })
    }
  }

  const handle = await createMcpHttpServer({
    name: 'symbiont-core',
    version: '1.0.0',
    setupHandlers: (server, sessionKey) => {
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }))
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params
        try {
          return await handleToolCall(name, args, sessionKey)
        } catch (err) {
          logger.error('mcp', 'tool-error', { name, error: (err as Error).message })
          return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true }
        }
      })
    },
  })

  logger.info('mcp', 'server-started', { port: handle.port, url: handle.url })
  return handle
}
