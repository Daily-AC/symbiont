import { CardStore } from './card-store.ts'
import type { ExperienceCard } from './types.ts'

/**
 * 记忆桥接器 — 合并共享记忆 + Persona 私有记忆。
 *
 * 查询时合并两个来源，写入时根据 scope 决定存哪里。
 * 默认写入私有记忆，显式指定 shared 才写到共享区。
 */
export class MemoryBridge {
  private shared: CardStore
  private personal: CardStore

  constructor(sharedDir: string, personalDir: string) {
    this.shared = new CardStore(sharedDir)
    this.personal = new CardStore(personalDir)
  }

  /** 添加卡片，scope 决定存到共享还是私有 */
  add(card: Omit<ExperienceCard, 'id' | 'createdAt' | 'lastUsed'>, scope: 'shared' | 'personal' = 'personal'): ExperienceCard {
    return scope === 'shared'
      ? this.shared.add(card)
      : this.personal.add(card)
  }

  /** 搜索：合并两个来源的结果 */
  search(query: { tags?: string[]; keyword?: string }): ExperienceCard[] {
    const sharedResults = this.shared.search(query)
    const personalResults = this.personal.search(query)
    return [...personalResults, ...sharedResults]
  }

  /** 获取所有卡片（合并，不含 archived） */
  all(): ExperienceCard[] {
    const shared = this.shared.all().filter(c => !c.archived)
    const personal = this.personal.all().filter(c => !c.archived)
    return [...personal, ...shared]
  }

  /** 按 ID 查找（先查私有再查共享） */
  get(id: string): ExperienceCard | undefined {
    return this.personal.get(id) ?? this.shared.get(id)
  }

  /** touch — 先查私有再查共享 */
  touch(id: string): void {
    if (this.personal.get(id)) {
      this.personal.touch(id)
    } else {
      this.shared.touch(id)
    }
  }

  /** 衰减：两个存储都执行 */
  decay(): { decayed: number; archived: string[] } {
    const r1 = this.shared.decay()
    const r2 = this.personal.decay()
    return {
      decayed: r1.decayed + r2.decayed,
      archived: [...r1.archived, ...r2.archived],
    }
  }

  /** 获取底层 CardStore（用于 CognitionEngine 等需要直接访问的场景） */
  getPersonalStore(): CardStore { return this.personal }
  getSharedStore(): CardStore { return this.shared }
}
