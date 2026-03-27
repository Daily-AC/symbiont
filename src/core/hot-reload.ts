import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { SymbiontCore } from './symbiont-core.ts'
import { loadPersona } from '../persona/loader.ts'
import { loadUser } from '../user/loader.ts'

/**
 * 配置热重载。
 *
 * 监听 persona pack 和 user 目录的文件变化：
 * - soul/voice 变化 → 重新生成 CLAUDE.md（下次 CC 启动/resume 时生效）
 * - manifest 变化 → 重新加载权限配置
 * - user profile 变化 → 重新生成 CLAUDE.md
 *
 * 热重载（不重启 CC）：soul、voice、user、manifest
 * 冷重载（需重启 CC）：MCP 配置变化（暂不实现）
 */
export class HotReloader {
  private watchers: FSWatcher[] = []
  private core: SymbiontCore
  private debounceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(core: SymbiontCore) {
    this.core = core
  }

  start(): void {
    const personaDir = this.core.persona.packDir
    const userDir = this.core.user.dir

    // 监听 persona 目录
    this.watchDir(personaDir, 'persona')
    // 监听 user 目录
    this.watchDir(userDir, 'user')

    this.core.logger.info('hot-reload', 'started', { personaDir, userDir })
  }

  stop(): void {
    for (const w of this.watchers) w.close()
    this.watchers = []
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
  }

  private watchDir(dir: string, label: string): void {
    try {
      const watcher = watch(dir, { recursive: true }, (event, filename) => {
        if (!filename || filename.startsWith('.')) return
        this.core.logger.debug('hot-reload', 'file-changed', { label, event, filename })
        this.debouncedReload()
      })
      this.watchers.push(watcher)
    } catch {
      this.core.logger.warn('hot-reload', 'watch-failed', { dir })
    }
  }

  private debouncedReload(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.reload()
    }, 1000)  // 1 秒 debounce
  }

  private reload(): void {
    this.core.logger.info('hot-reload', 'reloading')

    // 重新加载 persona + user
    const persona = loadPersona(this.core.config.personaPackDir)
    const user = loadUser(this.core.config.userDir)

    // 更新 SymbiontCore 的引用（需要 SymbiontCore 支持可变更新）
    ;(this.core as any).persona = persona
    ;(this.core as any).user = user

    // 重新生成 CLAUDE.md（下次 CC 启动/resume 时生效）
    this.core.workspaceManager.ensure('main', persona, user)

    this.core.logger.info('hot-reload', 'reload-complete')
  }
}
