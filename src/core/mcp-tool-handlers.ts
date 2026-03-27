/**
 * MCP Tool Handler 工厂 — 从 symbiont-core.ts 提取。
 *
 * 所有 MCP 工具回调的实现，原本在 SymbiontCore.startMcpServer() 内。
 */
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { SiaMcpToolHandler } from './symbiont-mcp-server.ts'
import type { SymbiontCore } from './symbiont-core.ts'
import { cosineSimilarity } from '../memory/embedding-client.ts'
import { updateManifestField } from '../persona/manifest.ts'
import { loadSharedCapabilities, updateSharedCapabilities } from './capability-config.ts'

export interface RouterLike {
  dispatchWorker: (desc: string, sp?: string, isAsync?: boolean, persona?: string, sessionKey?: string) => Promise<string>
  createForkFor: (sk: string, desc: string, opts?: { createTopic?: boolean; persona?: string }) => Promise<{ id: string }>
  completeForkFor: (sk: string, summary: string) => Promise<void>
}

export function createToolHandlers(core: SymbiontCore, router: RouterLike): SiaMcpToolHandler {
  return {
    dispatchWorker: (desc, sp, tools, isAsync, persona, sessionKey) => router.dispatchWorker(desc, sp, isAsync, persona, sessionKey),
    createFork: (desc, sk, createTopic, persona) => router.createForkFor(sk ?? 'terminal', desc, { createTopic, persona }),
    completeFork: (summary, sk) => router.completeForkFor(sk ?? 'terminal', summary),
    addMemoryCard: async (content, scene, tags, confidence, sessionKey) => {
      // Determine owner from sessionKey → persona
      let owner = core.persona.manifest?.name ?? 'default'
      if (sessionKey) {
        const session = core.sessionManager.getLatestBySessionKey(sessionKey)
        if (session && session.personaPack) {
          owner = session.personaPack
        }
      }

      // Dedup check: skip if content starts with "[force]"
      const isForced = content.startsWith('[force]')
      if (isForced) {
        content = content.slice('[force]'.length).trimStart()
      }

      if (!isForced && core.embeddingClient?.isAvailable) {
        try {
          const queryText = `${tags.join(' ')} ${scene}: ${content}`
          const queryEmb = await core.embeddingClient.embedOne(queryText)
          if (queryEmb) {
            // Dedup only within same owner's cards
            const allEmbeddings = core.memoryDB.getAllEmbeddings(owner)
            const duplicates: Array<{ id: string; content: string; scene: string; similarity: number }> = []
            for (const entry of allEmbeddings) {
              if (entry.embedding) {
                const sim = cosineSimilarity(queryEmb, entry.embedding)
                if (sim > 0.85) {
                  const card = core.memoryDB.getCard(entry.id)
                  if (card) {
                    duplicates.push({ id: card.id, content: card.content, scene: card.scene, similarity: sim })
                  }
                }
              }
            }
            if (duplicates.length > 0) {
              duplicates.sort((a, b) => b.similarity - a.similarity)
              core.logger.info('memory', 'dedup-hit', { count: duplicates.length, topSimilarity: duplicates[0].similarity })
              return { duplicates: duplicates.slice(0, 3) }
            }
          }
        } catch {
          // Dedup check failed, proceed with write
        }
      }

      const stored = core.memoryDB.addCard({
        content, scene, tags, confidence: confidence ?? 0.7,
        source: [], connections: [], owner,
      }, owner, sessionKey)
      // Also trigger connector
      if (core.connector) {
        core.connector.connect(stored).catch(err => { core.logger.warn('memory', 'connector-connect-failed', { error: String(err) }) })
      }
      // Also generate embedding
      if (core.embeddingClient) {
        const text = `${stored.tags.join(' ')} ${stored.scene}: ${stored.content}`
        core.embeddingClient.embedOne(text).then(emb => {
          if (emb) core.memoryDB.updateEmbedding(stored.id, emb)
        }).catch(err => { core.logger.warn('memory', 'embed-card-failed', { error: String(err) }) })
      }
      return stored.id
    },
    updateMemoryCard: async (id, updates) => {
      const existing = core.memoryDB.getCard(id)
      if (!existing) return `卡片 ${id} 不存在`
      const updated = core.memoryDB.updateCard(id, updates)
      if (!updated) return `更新失败: ${id}`
      // Re-generate embedding if content/scene/tags changed
      if (core.embeddingClient && (updates.content || updates.scene || updates.tags)) {
        const text = `${updated.tags.join(' ')} ${updated.scene}: ${updated.content}`
        core.embeddingClient.embedOne(text).then(emb => {
          if (emb) core.memoryDB.updateEmbedding(id, emb)
        }).catch(err => { core.logger.warn('memory', 'embed-update-failed', { error: String(err) }) })
      }
      core.logger.info('memory', 'card-updated', { id, fields: Object.keys(updates) })
      return `已更新卡片 ${id}`
    },
    getMemoryCards: async (keyword, tags, scope, sessionKey) => {
      // Determine caller's persona for owner filtering
      let callerOwner = core.persona.manifest?.name ?? 'default'
      if (sessionKey) {
        const session = core.sessionManager.getLatestBySessionKey(sessionKey)
        if (session && session.personaPack) {
          callerOwner = session.personaPack
        }
      }

      // scope=all permission check: only main persona can use
      const mainPersonaName = core.persona.manifest?.name ?? 'default'
      let effectiveScope = scope ?? 'self'
      if (effectiveScope === 'all' && callerOwner !== mainPersonaName) {
        effectiveScope = 'self'  // downgrade
      }

      const query: { keyword?: string; tags?: string[]; owner?: string; scope?: 'self' | 'shared' | 'all' } = {}
      if (keyword) query.keyword = keyword
      if (tags?.length) query.tags = tags
      query.owner = callerOwner
      query.scope = effectiveScope

      type RecallCard = { id: string; content: string; scene: string; tags: string[]; confidence: number; owner: string; source: 'exact' | 'semantic' }

      // 精确搜索（SQL LIKE 分词匹配）
      const exactResults: RecallCard[] = core.memoryDB.searchCards(query).map(c => ({
        id: c.id, content: c.content, scene: c.scene, tags: c.tags, confidence: c.confidence, owner: c.owner,
        source: 'exact' as const,
      }))

      // 语义召回（向量 + 关键词 + 图谱 RRF 融合）
      let semanticResults: RecallCard[] = []
      if (keyword && core.embeddingClient?.isAvailable) {
        const { recall } = await import('../memory/recall.ts')
        const recallResult = await recall(core.memoryDB, keyword, {
          limit: 5,
          embeddingClient: core.embeddingClient,
        })
        const exactIds = new Set(exactResults.map(c => c.id))
        semanticResults = recallResult.cards
          .filter(c => !exactIds.has(c.id))  // 去重：精确结果里已有的不重复
          .map(c => ({
            id: c.id, content: c.content, scene: c.scene, tags: c.tags, confidence: c.confidence, owner: c.owner,
            source: 'semantic' as const,
          }))
      }

      return [...exactResults, ...semanticResults]
    },
    decayMemory: async () => {
      const r = core.memoryLifecycle.run()
      return { decayed: r.decayed, archived: r.archived }
    },
    scanCognition: async () => core.cognitionEngine.scan(),
    getSystemStatus: () => core.getSystemStatus(),
    getSystemLogs: (lines) => core.getSystemLogs(lines),
    reload: (sessionKey, reason) => core.reloadInstance(sessionKey, reason),
    scheduleRestart: (reason) => core.scheduleRestart(reason),
    cronAdd: (name, schedule, prompt, options) => {
      const job = core.cronScheduler.addJob({
        name, schedule, executor: 'cc', prompt,
        enabled: true,
        timezone: options?.timezone,
        overlapPolicy: 'skip',
      })
      // One-shot: 在 cron trigger 处理后自动删除（通过 handleCronTrigger 检查）
      if (options?.oneShot) {
        (job as any)._oneShot = true
      }
      return { id: job.id }
    },
    cronList: () => {
      return core.cronScheduler.listJobs().map(j => ({
        id: j.id, name: j.name, schedule: j.schedule, enabled: j.enabled,
      }))
    },
    cronRemove: (id) => {
      const job = core.cronScheduler.getJob(id)
      if (!job) return false
      core.cronScheduler.removeJob(id)
      return true
    },
    personaList: () => {
      return core.personaRegistry.list().map(m => ({
        name: m.name, description: m.description, tags: m.tags,
      }))
    },
    personaGet: (name) => {
      return core.personaRegistry.get(name)?.persona.soulPrompt
    },
    personaRescan: () => {
      return core.personaRegistry.rescan()
    },
    listInstances: () => {
      const now = Date.now()
      return core.broker.status().map(i => ({
        id: i.id,
        role: i.role,
        state: i.state,
        description: i.description,
        uptime: now - i.createdAt,
      }))
    },
    killInstance: (id) => {
      const inst = core.broker.get(id)
      if (!inst) return false
      if (inst.role === 'main') return false  // 不能杀主实例
      core.broker.destroy(id).catch(err => { core.logger.warn('broker', 'destroy-instance-failed', { error: String(err) }) })
      return true
    },
    compile: (target, content, reason, personaName, sourceCards) => {
      if (target === 'shared') {
        // Write to shared knowledge base as an experience card with owner='shared'
        const stored = core.memoryDB.addCard({
          content, scene: `compiled: ${reason}`, tags: ['shared-knowledge', 'compiled'],
          confidence: 0.9, source: sourceCards ?? [], connections: [], owner: 'shared',
        }, 'shared')
        core.memoryDB.logActivity('compile', stored.id, JSON.stringify({
          target: 'shared', reason, sourceCards: sourceCards ?? [],
        }))
        core.logger.info('compiler', 'compiled-shared', { cardId: stored.id, reason })
        return `shared:${stored.id}`
      }
      return core.compiler.compile({ target: target as 'identity' | 'cc_memory' | 'persona', content, reason, personaName, sourceCards })
    },
    beginSettle: (sessionKey, reason) => {
      const prompt = core.settler.beginSettle(sessionKey)
      const usage = core.settler.getUsagePercent(sessionKey)
      core.logger.info('settler', 'mcp-triggered', { sessionKey, reason, usage })
      return { prompt, usage }
    },
    completeSettle: (sessionKey, summaryFile) => {
      core.settler.completeSettle(sessionKey)
      core.logger.info('settler', 'mcp-completed', { sessionKey, summaryFile })
      // 触发上下文轮换（异步，不阻塞 MCP 响应）
      if (core.router) {
        core.router.rotateSession(sessionKey, summaryFile).catch(err => {
          core.logger.error('settler', 'rotate-after-mcp-failed', { sessionKey, error: String(err) })
        })
      }
    },
    addWish: (title, reason, priority) => {
      const wish = core.memoryDB.addWish(title, reason, priority)
      return { id: wish.id, title: wish.title }
    },
    wishList: (status) => {
      return core.memoryDB.getWishes(status).map(w => ({ id: w.id, title: w.title, status: w.status, priority: w.priority }))
    },
    updateWish: (id, updates) => {
      const wish = core.memoryDB.updateWish(id, updates)
      if (!wish) return undefined
      return { id: wish.id, title: wish.title, status: wish.status }
    },
    reportIssue: (title, description, severity) => {
      const issue = core.memoryDB.addIssue(title, description, severity)
      return { id: issue.id, title: issue.title }
    },
    issueList: (status) => {
      return core.memoryDB.getIssues(status).map(i => ({
        id: i.id, title: i.title, severity: i.severity, status: i.status, created_at: i.created_at,
      }))
    },
    issueGet: (id) => {
      const rows = core.memoryDB.getIssues()
      return rows.find(i => i.id === id) as any
    },
    updateIssue: (id, updates) => {
      const updated = core.memoryDB.updateIssue(id, updates)
      if (!updated) return undefined
      return { id: updated.id, title: updated.title, status: updated.status }
    },
    closeIssue: (id, resolution, status) => {
      const closed = core.memoryDB.updateIssue(id, {
        status: status ?? 'resolved',
        resolution,
      })
      if (!closed) return undefined
      return { id: closed.id, title: closed.title, status: closed.status }
    },
    taskAdd: (title, description, assignee, priority, due_date) => {
      return core.memoryDB.addTask({ title, description, assignee, priority, due_date })
    },
    taskUpdate: (id, updates) => {
      return core.memoryDB.updateTask(id, updates)
    },
    taskList: (status, assignee) => {
      const filter: { status?: string; assignee?: string } = {}
      if (status) filter.status = status
      if (assignee) filter.assignee = assignee
      return core.memoryDB.listTasks(filter)
    },
    changelog: (limit) => {
      return core.memoryDB.getReleases(limit ?? 10).map(r => {
        let commits: string[] = []
        try { commits = JSON.parse(r.commits) } catch { commits = [r.commits] }
        return { id: r.id, version: r.version, commits, deployed_at: r.deployed_at, git_hash: r.git_hash }
      })
    },
    configPersona: (personaName, field, values) => {
      // 查找 persona pack 目录
      const packsDir = join(core.config.dataDir, '..', 'persona-packs')
      const packDir = join(packsDir, personaName)
      if (!existsSync(packDir)) return `❌ Persona "${personaName}" 不存在`
      try {
        updateManifestField(packDir, field, values)
        // 重新扫描让变更生效
        core.personaRegistry.rescan()
        // 通知 Gateway 刷新
        if (core.gateway) {
          core.gateway.notifyToolsChanged()
        }
        return `✅ 已更新 ${personaName} 的 ${field}: [${values.join(', ')}]`
      } catch (err) {
        return `❌ 更新失败: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    configShared: (field, values) => {
      try {
        const configDir = join(core.config.dataDir, '..', 'config')
        updateSharedCapabilities(configDir, field, values)
        // 通知 Gateway 刷新
        if (core.gateway) {
          core.gateway.notifyToolsChanged()
        }
        return `✅ 已更新公用白名单 ${field}: [${values.join(', ')}]`
      } catch (err) {
        return `❌ 更新失败: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    listCapabilities: (personaName) => {
      const configDir = join(core.config.dataDir, '..', 'config')
      const sharedCaps = loadSharedCapabilities(configDir)

      if (personaName) {
        // 查询特定 persona
        const pack = core.personaRegistry.get(personaName)
        const manifest = pack?.persona.manifest ?? core.persona.manifest
        const tools = [...(sharedCaps.mcp.always_available), ...(manifest?.mcp?.tools ?? [])]
        const skills = [...(sharedCaps.skills.always_available), ...(manifest?.skills?.include ?? [])]
        return { tools, skills }
      }

      // 列出所有
      const result: Record<string, { tools: string[]; skills: string[] }> = {}
      // 主 persona
      const mainTools = [...(sharedCaps.mcp.always_available), ...(core.persona.manifest?.mcp?.tools ?? [])]
      const mainSkills = [...(sharedCaps.skills.always_available), ...(core.persona.manifest?.skills?.include ?? [])]
      result[core.persona.manifest?.name ?? 'default'] = { tools: mainTools, skills: mainSkills }
      // 其他 persona
      for (const pack of core.personaRegistry.entries()) {
        const tools = [...(sharedCaps.mcp.always_available), ...(pack.persona.manifest?.mcp?.tools ?? [])]
        const skills = [...(sharedCaps.skills.always_available), ...(pack.persona.manifest?.skills?.include ?? [])]
        result[pack.name] = { tools, skills }
      }
      return result as any
    },
    grantTool: (sessionKey, toolName, durationMinutes) => {
      if (!core.gateway) return '❌ Gateway 未启动'
      const durationMs = (durationMinutes ?? 60) * 60 * 1000
      core.gateway.grantTool(sessionKey, toolName, durationMs)
      const expiresAt = new Date(Date.now() + durationMs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      return `✅ 已授权 ${sessionKey} 使用 ${toolName}，${durationMinutes ?? 60} 分钟后过期（${expiresAt}）`
    },
    revokeTool: (sessionKey, toolName) => {
      if (!core.gateway) return '❌ Gateway 未启动'
      const revoked = core.gateway.revokeTool(sessionKey, toolName)
      return revoked ? `✅ 已回收 ${sessionKey} 的 ${toolName} 权限` : `⚠️ 未找到该授权`
    },
    requestTool: (toolName, reason) => {
      return core.memoryDB.addWish(
        `[工具申请] ${toolName}`,
        `工人/专员申请使用工具 ${toolName}。原因：${reason}`,
        'normal',
      )
    },
    requestSkill: (skillName, reason) => {
      return core.memoryDB.addWish(
        `[Skill 申请] ${skillName}`,
        `工人/专员申请使用 Skill ${skillName}。原因：${reason}`,
        'normal',
      )
    },
    listGatewayBackends: () => {
      if (!core.gateway) return []
      return core.gateway.getBackendList()
    },
    addBackend: async (name, url, description) => {
      if (!core.gateway) throw new Error('Gateway 未启动')
      const result = await core.gateway.addBackend(name, url, description)
      core.logger.info('core', 'mcp-backend-added', { name, url, tools: result.tools.length })
      return result
    },
    removeBackend: (name) => {
      if (!core.gateway) return false
      const removed = core.gateway.removeBackend(name)
      if (removed) core.logger.info('core', 'mcp-backend-removed', { name })
      return removed
    },
  }
}
