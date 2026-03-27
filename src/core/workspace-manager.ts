import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, readlinkSync, readdirSync, unlinkSync, lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { PersonaConfig } from '../persona/loader.ts'
import type { UserProfile } from '../user/loader.ts'
import type { Logger } from './logger.ts'
import { loadSharedCapabilities } from './capability-config.ts'

export interface WorkspaceInfo {
  id: string
  dir: string
  createdAt: number
}

/**
 * Workspace 管理器（借鉴 Team Anya 的 ensureLoidWorkspace）。
 *
 * 每个 session 有独立的隔离工作区：
 * - CLAUDE.md：每次启动强制覆盖（从 persona + user 生成）
 * - .mcp.json：补缺不覆盖（运行时动态维护）
 * - 共享目录通过 symlink（memory、data）
 */
export class WorkspaceManager {
  private siaRoot: string
  private workspaceDir: string
  private workspaces: Map<string, WorkspaceInfo> = new Map()
  private logger: Logger
  private mcpBaseUrls: Record<string, string> = {}  // name → baseUrl (without query params)

  constructor(siaRoot: string, logger: Logger) {
    this.siaRoot = siaRoot
    this.workspaceDir = join(siaRoot, 'workspace')
    mkdirSync(this.workspaceDir, { recursive: true })
    this.logger = logger
  }

  /**
   * 注册 MCP Server base URL（不含 query params）。
   * ensureMcpJson 时会根据 sessionKey 拼接 ?sk= 参数。
   */
  registerMcp(name: string, baseUrl: string): void {
    this.mcpBaseUrls[name] = baseUrl
  }

  /**
   * 创建或更新工作区。
   *
   * - CLAUDE.md：每次强制覆盖
   * - .mcp.json：补缺不覆盖（但会合并新注册的 MCP）
   * - 共享目录 symlink
   */
  ensure(sessionKey: string, persona: PersonaConfig, user: UserProfile, taskDescription?: string): WorkspaceInfo {
    const safeName = sessionKey.replace(/[/:]/g, '_')
    const dir = join(this.workspaceDir, safeName)
    mkdirSync(dir, { recursive: true })

    // 1. CLAUDE.md — 每次强制覆盖
    const claudeMd = this.generateClaudeMd(persona, user, taskDescription)
    writeFileSync(join(dir, 'CLAUDE.md'), claudeMd)

    // 2. .mcp.json — 合并 MCP URLs（带 sessionKey 参数）
    this.ensureMcpJson(dir, sessionKey)

    // 3. 共享目录 symlink
    this.ensureSymlink(dir, 'memory', resolve(persona.memoryDir))
    this.ensureSymlink(dir, 'shared-memory', resolve(this.siaRoot, 'data', 'shared-memory'))
    this.ensureSymlink(dir, 'data', resolve(this.siaRoot, 'data'))
    this.ensureSymlink(dir, 'user', resolve(this.siaRoot, 'user'))

    // 4. .claude 目录
    mkdirSync(join(dir, '.claude'), { recursive: true })

    // 5. Skills symlink 路由
    this.ensureSkillLinks(dir, persona)

    const info: WorkspaceInfo = { id: safeName, dir, createdAt: Date.now() }
    this.workspaces.set(sessionKey, info)
    this.logger.debug('workspace', 'ensured', { sessionKey, dir })
    return info
  }

  /**
   * 获取所有注册的 MCP URLs（用于 --mcp-config 注入）。
   */
  getMcpServers(): Record<string, { url: string }> {
    const servers: Record<string, { url: string }> = {}
    for (const [name, url] of Object.entries(this.mcpBaseUrls)) {
      servers[name] = { url }
    }
    return servers
  }

  /**
   * 获取工作区。
   */
  get(sessionKey: string): WorkspaceInfo | undefined {
    return this.workspaces.get(sessionKey)
  }

  /**
   * 清理工作区。
   */
  cleanup(sessionKey: string): void {
    const info = this.workspaces.get(sessionKey)
    if (!info) return
    if (existsSync(info.dir)) {
      rmSync(info.dir, { recursive: true })
    }
    this.workspaces.delete(sessionKey)
    this.logger.info('workspace', 'cleaned', { sessionKey })
  }

  // ---- 内部方法 ----

  /**
   * 根据 persona manifest 的 skills.include 白名单，在工作区 .claude/skills/ 下
   * 创建符号链接指向全局 skill 库（skills/ 目录）。
   *
   * 通配符匹配：`*` = 所有，`prefix_*` = 前缀匹配，精确名 = 完全匹配。
   * 合并 shared-capabilities.json 的 skills.always_available。
   */
  private ensureSkillLinks(workDir: string, persona: PersonaConfig): void {
    const globalSkillsDir = resolve(this.siaRoot, 'skills')
    if (!existsSync(globalSkillsDir)) return // 没有全局 skill 库

    const skillsTargetDir = join(workDir, '.claude', 'skills')
    mkdirSync(skillsTargetDir, { recursive: true })

    // 清理旧的 symlink（只清理 symlink，不删除真实文件）
    if (existsSync(skillsTargetDir)) {
      try {
        for (const entry of readdirSync(skillsTargetDir)) {
          const entryPath = join(skillsTargetDir, entry)
          try {
            const stat = lstatSync(entryPath)
            if (stat.isSymbolicLink()) unlinkSync(entryPath)
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }

    // 收集白名单：persona manifest + shared capabilities
    const includePatterns: string[] = []
    if (persona.manifest?.skills?.include) {
      includePatterns.push(...persona.manifest.skills.include)
    }
    const configDir = resolve(this.siaRoot, 'config')
    const sharedCaps = loadSharedCapabilities(configDir)
    if (sharedCaps.skills.always_available.length > 0) {
      includePatterns.push(...sharedCaps.skills.always_available)
    }

    if (includePatterns.length === 0) return

    // 列出全局 skill 库中的所有 skill
    let globalSkills: string[]
    try {
      globalSkills = readdirSync(globalSkillsDir)
    } catch { return }

    // 匹配 skill
    const matched = new Set<string>()
    for (const pattern of includePatterns) {
      if (pattern === '*') {
        // 所有 skill
        for (const s of globalSkills) matched.add(s)
      } else if (pattern.endsWith('_*') || pattern.endsWith('*')) {
        // 前缀匹配：prefix_* 或 prefix*
        const prefix = pattern.replace(/\*$/, '')
        for (const s of globalSkills) {
          if (s.startsWith(prefix)) matched.add(s)
        }
      } else {
        // 精确匹配
        if (globalSkills.includes(pattern)) matched.add(pattern)
      }
    }

    // 创建 symlink
    for (const skillName of matched) {
      const target = resolve(globalSkillsDir, skillName)
      const linkPath = join(skillsTargetDir, skillName)
      if (existsSync(linkPath)) continue

      try {
        // 判断目标是文件还是目录
        const targetStat = lstatSync(target)
        symlinkSync(target, linkPath, targetStat.isDirectory() ? 'dir' : 'file')
      } catch (err) {
        this.logger.warn('workspace', 'skill-link-failed', { skillName, error: String(err) })
      }
    }

    if (matched.size > 0) {
      this.logger.debug('workspace', 'skills-linked', { count: matched.size, skills: [...matched] })
    }
  }

  private ensureMcpJson(dir: string, sessionKey?: string): void {
    const mcpPath = join(dir, '.mcp.json')
    let existing: any = {}
    if (existsSync(mcpPath)) {
      try { existing = JSON.parse(readFileSync(mcpPath, 'utf-8')) } catch {}
    }

    // 重建 MCP servers（清理旧入口，只保留当前注册的）
    const servers: Record<string, { type: string; url: string }> = {}
    for (const [name, baseUrl] of Object.entries(this.mcpBaseUrls)) {
      const url = sessionKey
        ? `${baseUrl}?sk=${encodeURIComponent(sessionKey)}`
        : baseUrl
      servers[name] = { type: 'http', url }
    }
    existing.mcpServers = servers

    writeFileSync(mcpPath, JSON.stringify(existing, null, 2))
  }

  private ensureSymlink(workDir: string, linkName: string, target: string): void {
    const linkPath = join(workDir, linkName)

    // 确保目标存在
    mkdirSync(target, { recursive: true })

    // 已经是正确的 symlink，跳过
    try {
      const current = readlinkSync(linkPath)
      if (resolve(current) === resolve(target)) return
    } catch { /* 不是 symlink 或不存在 */ }

    // 如果是普通目录/文件，不覆盖
    if (existsSync(linkPath)) return

    symlinkSync(target, linkPath, 'dir')
  }

  private generateClaudeMd(persona: PersonaConfig, user: UserProfile, taskDescription?: string): string {
    const parts: string[] = []

    if (persona.soulPrompt) {
      parts.push(persona.soulPrompt)
    }

    if (user.content) {
      parts.push('---\n\n## 关于用户\n\n' + user.content)
    }

    if (persona.manifest) {
      const m = persona.manifest
      parts.push(`---\n\n## 工作边界\n\n` +
        `可自由修改：${m.permissions.writable.join(', ')}\n\n` +
        `受保护（confirm before modifying）：${m.permissions.protected.join(', ')}`)
    }

    if (taskDescription) {
      parts.push(`---\n\n## 当前任务\n\n${taskDescription}`)
    }

    return parts.join('\n\n')
  }
}
