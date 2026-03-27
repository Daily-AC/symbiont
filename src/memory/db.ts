import Database from 'better-sqlite3'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { ExperienceCard, Connection, Cognition, Feedback, ActivityEntry, Wish, Task, Issue, Release } from './types.ts'

export class MemoryDB {
  private db: Database.Database
  private _embeddingCache: Map<string, Float32Array> | null = null
  onActivity?: (type: string, detail: string) => void

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.db = new Database(join(dataDir, 'memory.db'))
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.initSchema()
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        scene TEXT,
        confidence REAL DEFAULT 0.7,
        source TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        last_used TEXT NOT NULL,
        archived INTEGER DEFAULT 0,
        essence TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cards_confidence ON cards(confidence);
      CREATE INDEX IF NOT EXISTS idx_cards_archived ON cards(archived);

      CREATE TABLE IF NOT EXISTS card_tags (
        card_id TEXT REFERENCES cards(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (card_id, tag)
      );
      CREATE INDEX IF NOT EXISTS idx_card_tags_tag ON card_tags(tag);

      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        from_id TEXT REFERENCES cards(id) ON DELETE CASCADE,
        to_id TEXT REFERENCES cards(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        strength REAL DEFAULT 0.5,
        reason TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conn_from ON connections(from_id);
      CREATE INDEX IF NOT EXISTS idx_conn_to ON connections(to_id);

      CREATE TABLE IF NOT EXISTS cognitions (
        id TEXT PRIMARY KEY,
        tag TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        source_cards TEXT DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY,
        card_id TEXT REFERENCES cards(id) ON DELETE CASCADE,
        verdict TEXT NOT NULL,
        comment TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activity (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        card_id TEXT,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at);
    `)

    // Add embedding column if not exists (idempotent)
    const columns = this.db.pragma('table_info(cards)') as Array<{ name: string }>
    if (!columns.some(c => c.name === 'embedding')) {
      this.db.exec('ALTER TABLE cards ADD COLUMN embedding BLOB')
    }

    // Add owner column if not exists (persona memory isolation)
    if (!columns.some(c => c.name === 'owner')) {
      this.db.exec("ALTER TABLE cards ADD COLUMN owner TEXT DEFAULT 'xiaoxi'")
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_cards_owner ON cards(owner)')
    }

    // Add comments column to issues if not exists
    const issueCols = this.db.pragma('table_info(issues)') as Array<{ name: string }>
    if (issueCols.length > 0 && !issueCols.some(c => c.name === 'comments')) {
      this.db.exec("ALTER TABLE issues ADD COLUMN comments TEXT DEFAULT '[]'")
    }

    // Add session_id column to activity if not exists
    const actCols = this.db.pragma('table_info(activity)') as Array<{ name: string }>
    if (actCols.length > 0 && !actCols.some(c => c.name === 'session_id')) {
      this.db.exec('ALTER TABLE activity ADD COLUMN session_id TEXT')
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        role TEXT,
        content TEXT,
        cc_session_id TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        assignee TEXT DEFAULT 'xiaoxi',
        status TEXT DEFAULT 'todo',
        priority TEXT DEFAULT 'normal',
        due_date TEXT,
        created_by TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);

      CREATE TABLE IF NOT EXISTS wishes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        reason TEXT,
        priority TEXT DEFAULT 'normal',
        status TEXT DEFAULT 'pending',
        comment TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        severity TEXT DEFAULT 'normal',
        status TEXT DEFAULT 'open',
        resolution TEXT,
        created_by TEXT DEFAULT 'xiaoxi',
        created_at TEXT NOT NULL,
        comments TEXT DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);

      CREATE TABLE IF NOT EXISTS releases (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        commits TEXT NOT NULL DEFAULT '[]',
        deployed_at TEXT NOT NULL,
        git_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_releases_deployed ON releases(deployed_at);

      CREATE TABLE IF NOT EXISTS active_tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        description TEXT NOT NULL,
        persona TEXT,
        parent_session_key TEXT,
        status TEXT DEFAULT 'running',
        created_at TEXT DEFAULT (datetime('now')),
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS sent_cards (
        feishu_message_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
  }

  // ---- Cards ----

  addCard(card: Omit<ExperienceCard, 'id' | 'createdAt' | 'lastUsed'>, owner?: string, sessionId?: string): ExperienceCard {
    const now = new Date().toISOString()
    const id = `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const cardOwner = owner ?? card.owner ?? 'xiaoxi'
    const full: ExperienceCard = {
      ...card,
      id,
      owner: cardOwner,
      createdAt: now,
      lastUsed: now,
    }

    const doInsert = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO cards (id, content, scene, confidence, source, created_at, last_used, archived, essence, owner)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, full.content, full.scene, full.confidence,
        JSON.stringify(full.source), now, now, full.archived ? 1 : 0, full.essence ?? null, cardOwner)

      for (const tag of full.tags) {
        this.db.prepare('INSERT OR IGNORE INTO card_tags (card_id, tag) VALUES (?, ?)').run(id, tag)
      }

      this.logActivity('extract', id, `New card: ${full.content.slice(0, 80)}`, sessionId)
    })
    doInsert()
    return full
  }

  getCard(id: string): ExperienceCard | undefined {
    const row = this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as any
    if (!row) return undefined
    return this.rowToCard(row)
  }

  searchCards(query: { keyword?: string; tags?: string[]; archived?: boolean; limit?: number; owner?: string; scope?: 'self' | 'shared' | 'all' }): ExperienceCard[] {
    let sql = 'SELECT DISTINCT c.* FROM cards c'
    const params: unknown[] = []
    const conditions: string[] = []

    if (query.tags?.length) {
      sql += ' JOIN card_tags ct ON c.id = ct.card_id'
      conditions.push(`ct.tag IN (${query.tags.map(() => '?').join(',')})`)
      params.push(...query.tags)
    }

    if (query.keyword) {
      // 按空格分词，每个词都要在 content 或 scene 中出现（AND）
      const words = query.keyword.toLowerCase().split(/\s+/).filter(w => w.length > 0)
      for (const word of words) {
        conditions.push('(LOWER(c.content) LIKE ? OR LOWER(c.scene) LIKE ?)')
        const kw = `%${word}%`
        params.push(kw, kw)
      }
    }

    if (query.archived !== undefined) {
      conditions.push('c.archived = ?')
      params.push(query.archived ? 1 : 0)
    }

    // Persona memory isolation: scope takes priority over owner
    if (query.scope === 'self') {
      conditions.push('c.owner = ?')
      params.push(query.owner ?? 'xiaoxi')
    } else if (query.scope === 'shared') {
      conditions.push("c.owner = 'shared'")
    } else if (query.scope === 'all') {
      // no owner filter — search everything
    } else if (query.owner) {
      // no scope specified but owner given → filter by owner
      conditions.push('c.owner = ?')
      params.push(query.owner)
    }

    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ')
    sql += ' ORDER BY c.confidence DESC'
    if (query.limit) { sql += ' LIMIT ?'; params.push(query.limit) }

    const rows = this.db.prepare(sql).all(...params) as any[]
    return rows.map(r => this.rowToCard(r))
  }

  updateCard(id: string, updates: { content?: string; scene?: string; confidence?: number; tags?: string[]; owner?: string }): ExperienceCard | undefined {
    const doUpdate = this.db.transaction(() => {
      if (updates.content !== undefined) {
        this.db.prepare('UPDATE cards SET content = ? WHERE id = ?').run(updates.content, id)
      }
      if (updates.scene !== undefined) {
        this.db.prepare('UPDATE cards SET scene = ? WHERE id = ?').run(updates.scene, id)
      }
      if (updates.confidence !== undefined) {
        this.db.prepare('UPDATE cards SET confidence = ? WHERE id = ?').run(updates.confidence, id)
      }
      if (updates.owner !== undefined) {
        this.db.prepare('UPDATE cards SET owner = ? WHERE id = ?').run(updates.owner, id)
      }
      if (updates.tags !== undefined) {
        this.db.prepare('DELETE FROM card_tags WHERE card_id = ?').run(id)
        const ins = this.db.prepare('INSERT INTO card_tags (card_id, tag) VALUES (?, ?)')
        for (const tag of updates.tags) ins.run(id, tag)
      }
    })
    doUpdate()
    return this.getCard(id)
  }

  deleteCard(id: string): void {
    const doDelete = this.db.transaction(() => {
      this.db.prepare('DELETE FROM card_tags WHERE card_id = ?').run(id)
      this.db.prepare('DELETE FROM connections WHERE from_id = ? OR to_id = ?').run(id, id)
      this.db.prepare('DELETE FROM feedback WHERE card_id = ?').run(id)
      this.db.prepare('DELETE FROM cards WHERE id = ?').run(id)
    })
    doDelete()
    this._embeddingCache?.delete(id)
  }

  updateCreatedAt(id: string, createdAt: string): void {
    this.db.prepare('UPDATE cards SET created_at = ? WHERE id = ?').run(createdAt, id)
  }

  touchCard(id: string): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      UPDATE cards SET last_used = ?, confidence = MIN(0.95, confidence + 0.1) WHERE id = ?
    `).run(now, id)
  }

  updateConfidence(id: string, delta: number, reason?: string): void {
    this.db.prepare(`
      UPDATE cards SET confidence = MAX(0, MIN(1.0, confidence + ?)) WHERE id = ?
    `).run(delta, id)
    if (reason) this.logActivity('decay', id, reason)
  }

  archiveCard(id: string, essence?: string): void {
    this.db.prepare(`
      UPDATE cards SET archived = 1, essence = ? WHERE id = ?
    `).run(essence ?? null, id)
    this._embeddingCache?.delete(id)
    this.logActivity('archive', id, `Archived${essence ? ': ' + essence.slice(0, 80) : ''}`)
  }

  reviveCard(id: string): void {
    this.db.prepare(`
      UPDATE cards SET archived = 0, confidence = 0.3, last_used = ? WHERE id = ?
    `).run(new Date().toISOString(), id)
    this.logActivity('revive', id, 'Revived from archive')
  }

  getAllCards(includeArchived = false): ExperienceCard[] {
    const sql = includeArchived
      ? 'SELECT * FROM cards ORDER BY confidence DESC'
      : 'SELECT * FROM cards WHERE archived = 0 ORDER BY confidence DESC'
    return (this.db.prepare(sql).all() as any[]).map(r => this.rowToCard(r))
  }

  getCardTags(cardId: string): string[] {
    return (this.db.prepare('SELECT tag FROM card_tags WHERE card_id = ?').all(cardId) as any[]).map(r => r.tag)
  }

  // ---- Connections ----

  addConnection(conn: Omit<Connection, 'id' | 'createdAt'>): Connection {
    const id = `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO connections (id, from_id, to_id, type, strength, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, conn.fromId, conn.toId, conn.type, conn.strength, conn.reason ?? null, now)
    this.logActivity('connect', conn.fromId, `${conn.type} → ${conn.toId}`)
    return { ...conn, id, createdAt: now }
  }

  getConnections(cardId: string): Connection[] {
    const rows = this.db.prepare(`
      SELECT * FROM connections WHERE from_id = ? OR to_id = ?
    `).all(cardId, cardId) as any[]
    return rows.map(r => ({
      id: r.id, fromId: r.from_id, toId: r.to_id,
      type: r.type, strength: r.strength, reason: r.reason, createdAt: r.created_at,
    }))
  }

  hasConnections(cardId: string): boolean {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM connections WHERE from_id = ? OR to_id = ?').get(cardId, cardId) as any
    return row.cnt > 0
  }

  getAllConnections(limit = 100): Array<Connection & { fromContent: string; toContent: string }> {
    const rows = this.db.prepare(`
      SELECT c.*,
        SUBSTR(cf.content, 1, 60) as from_content,
        SUBSTR(ct.content, 1, 60) as to_content
      FROM connections c
      LEFT JOIN cards cf ON cf.id = c.from_id
      LEFT JOIN cards ct ON ct.id = c.to_id
      ORDER BY c.created_at DESC
      LIMIT ?
    `).all(limit) as any[]
    return rows.map(r => ({
      id: r.id, fromId: r.from_id, toId: r.to_id,
      type: r.type, strength: r.strength, reason: r.reason,
      createdAt: r.created_at,
      fromContent: r.from_content ?? '(deleted)',
      toContent: r.to_content ?? '(deleted)',
    }))
  }

  // ---- Cognitions ----

  addCognition(tag: string, summary: string, sourceCards: string[]): Cognition {
    const id = `cog-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO cognitions (id, tag, summary, status, source_cards, created_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `).run(id, tag, summary, JSON.stringify(sourceCards), now)
    this.logActivity('aggregate', undefined, `Cognition candidate: ${tag}`)
    return { id, tag, summary, status: 'pending', sourceCards, createdAt: now }
  }

  getCognitions(status?: string): Cognition[] {
    const sql = status
      ? 'SELECT * FROM cognitions WHERE status = ? ORDER BY created_at DESC'
      : 'SELECT * FROM cognitions ORDER BY created_at DESC'
    const rows = (status ? this.db.prepare(sql).all(status) : this.db.prepare(sql).all()) as any[]
    return rows.map(r => ({
      id: r.id, tag: r.tag, summary: r.summary, status: r.status,
      sourceCards: JSON.parse(r.source_cards), createdAt: r.created_at,
    }))
  }

  updateCognitionStatus(id: string, status: 'approved' | 'rejected'): void {
    this.db.prepare('UPDATE cognitions SET status = ? WHERE id = ?').run(status, id)
  }

  // ---- Feedback ----

  addFeedback(cardId: string, verdict: Feedback['verdict'], comment?: string): Feedback {
    const id = `fb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO feedback (id, card_id, verdict, comment, created_at) VALUES (?, ?, ?, ?, ?)
    `).run(id, cardId, verdict, comment ?? null, now)

    // Apply verdict effects
    if (verdict === 'wrong') {
      this.archiveCard(cardId, 'Marked wrong by user')
    } else if (verdict === 'important') {
      this.db.prepare('UPDATE cards SET confidence = 1.0 WHERE id = ?').run(cardId)
    }

    this.logActivity('feedback', cardId, `${verdict}${comment ? ': ' + comment : ''}`)
    return { id, cardId, verdict, comment, createdAt: now }
  }

  // ---- Activity ----

  logActivity(type: ActivityEntry['type'], cardId: string | undefined, detail: string, sessionId?: string): void {
    const id = `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    this.db.prepare(`
      INSERT INTO activity (id, type, card_id, detail, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, type, cardId ?? null, detail, sessionId ?? null, new Date().toISOString())
    if (this.onActivity) this.onActivity(type, detail)
  }

  getActivity(limit = 50): ActivityEntry[] {
    return (this.db.prepare('SELECT * FROM activity ORDER BY created_at DESC LIMIT ?').all(limit) as any[]).map(r => ({
      id: r.id, type: r.type, cardId: r.card_id, sessionId: r.session_id, detail: r.detail, createdAt: r.created_at,
    }))
  }

  // ---- Events (replaces JSONL EventStore) ----

  appendEvent(event: { sessionId: string; type: string; role?: string; content?: string; ccSessionId?: string; metadata?: unknown }): string {
    const id = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.db.prepare(`
      INSERT INTO events (id, session_id, type, role, content, cc_session_id, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, event.sessionId, event.type, event.role ?? null, event.content ?? null,
      event.ccSessionId ?? null, event.metadata ? JSON.stringify(event.metadata) : null,
      new Date().toISOString())
    return id
  }

  getEvents(sessionId: string): Array<{ id: string; type: string; role?: string; content?: string; createdAt: string }> {
    return (this.db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY created_at').all(sessionId) as any[]).map(r => ({
      id: r.id, type: r.type, role: r.role, content: r.content, createdAt: r.created_at,
    }))
  }

  /**
   * 返回完整的 SiaEvent 格式（含 data 字段），供 EventStore 使用。
   */
  getEventsFull(sessionId: string): Array<{ id: string; timestamp: string; type: any; sessionId: string; data: Record<string, unknown> }> {
    return (this.db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY created_at').all(sessionId) as any[]).map(r => {
      // metadata 里存的是完整 data，优先用；否则从 role/content 重建
      let data: Record<string, unknown> = {}
      if (r.metadata) {
        try { data = JSON.parse(r.metadata) } catch { /* ignore */ }
      }
      if (!data.role && r.role) data.role = r.role
      if (!data.content && r.content) data.content = r.content
      if (!data.ccSessionId && r.cc_session_id) data.ccSessionId = r.cc_session_id
      return { id: r.id, timestamp: r.created_at, type: r.type, sessionId: r.session_id, data }
    })
  }

  // ---- Graph data (for dashboard) ----

  getGraphData(): { nodes: Array<{ id: string; content: string; confidence: number; archived: boolean; tags: string[] }>; edges: Connection[] } {
    const cards = this.getAllCards(true)
    const nodes = cards.map(c => ({ id: c.id, content: c.content.slice(0, 60), confidence: c.confidence, archived: !!c.archived, tags: c.tags }))
    const edges = (this.db.prepare('SELECT * FROM connections').all() as any[]).map(r => ({
      id: r.id, fromId: r.from_id, toId: r.to_id,
      type: r.type, strength: r.strength, reason: r.reason, createdAt: r.created_at,
    }))
    return { nodes, edges }
  }

  // ---- Stats ----

  getStats(): { total: number; active: number; archived: number; locked: number; connections: number; cognitions: number } {
    const total = (this.db.prepare('SELECT COUNT(*) as n FROM cards').get() as any).n
    const active = (this.db.prepare('SELECT COUNT(*) as n FROM cards WHERE archived = 0').get() as any).n
    const archived = total - active
    const locked = (this.db.prepare('SELECT COUNT(*) as n FROM cards WHERE confidence >= 1.0').get() as any).n
    const connections = (this.db.prepare('SELECT COUNT(*) as n FROM connections').get() as any).n
    const cognitions = (this.db.prepare('SELECT COUNT(*) as n FROM cognitions').get() as any).n
    return { total, active, archived, locked, connections, cognitions }
  }

  // ---- Helpers ----

  private rowToCard(row: any): ExperienceCard {
    const tags = this.getCardTags(row.id)
    return {
      id: row.id, content: row.content, scene: row.scene,
      confidence: row.confidence, source: JSON.parse(row.source || '[]'),
      createdAt: row.created_at, lastUsed: row.last_used,
      tags, connections: [], archived: !!row.archived, essence: row.essence,
      owner: row.owner ?? 'xiaoxi',
    }
  }

  // ---- Embeddings ----

  updateEmbedding(id: string, embedding: Float32Array): void {
    this.db.prepare('UPDATE cards SET embedding = ? WHERE id = ?')
      .run(Buffer.from(embedding.buffer), id)
    if (this._embeddingCache) {
      this._embeddingCache.set(id, embedding)
    }
  }

  getAllEmbeddings(owner?: string): Array<{ id: string; embedding: Float32Array | null }> {
    const sql = owner
      ? 'SELECT id, embedding FROM cards WHERE archived = 0 AND owner = ?'
      : 'SELECT id, embedding FROM cards WHERE archived = 0'
    const rows = (owner
      ? this.db.prepare(sql).all(owner)
      : this.db.prepare(sql).all()
    ) as Array<{ id: string; embedding: Buffer | null }>
    return rows.map(r => ({
      id: r.id,
      embedding: r.embedding
        ? new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4)
        : null,
    }))
  }

  /**
   * Get in-memory embedding cache. Loads from SQLite on first call,
   * subsequent calls return cached Map. Mutations auto-update cache.
   */
  getCachedEmbeddings(): Map<string, Float32Array> {
    if (!this._embeddingCache) {
      this._embeddingCache = new Map()
      const rows = this.db.prepare(
        'SELECT id, embedding FROM cards WHERE archived = 0 AND embedding IS NOT NULL'
      ).all() as Array<{ id: string; embedding: Buffer }>
      for (const row of rows) {
        this._embeddingCache.set(
          row.id,
          new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)
        )
      }
    }
    return this._embeddingCache
  }

  invalidateEmbeddingCache(): void {
    this._embeddingCache = null
  }

  // ---- Wishes ----

  addWish(title: string, reason?: string, priority: string = 'normal'): Wish {
    const id = `wish-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO wishes (id, title, reason, priority, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(id, title, reason ?? null, priority, now)
    this.logActivity('extract', undefined, `New wish: ${title}`)
    return { id, title, reason, priority: priority as Wish['priority'], status: 'pending', createdAt: now }
  }

  getWishes(status?: string): Wish[] {
    const sql = status
      ? 'SELECT * FROM wishes WHERE status = ? ORDER BY created_at DESC'
      : 'SELECT * FROM wishes ORDER BY created_at DESC'
    const rows = (status ? this.db.prepare(sql).all(status) : this.db.prepare(sql).all()) as any[]
    return rows.map(r => ({
      id: r.id, title: r.title, reason: r.reason,
      priority: r.priority, status: r.status, comment: r.comment, createdAt: r.created_at,
    }))
  }

  updateWish(id: string, updates: { status?: string; comment?: string }): Wish | undefined {
    const doUpdate = this.db.transaction(() => {
      if (updates.status !== undefined) {
        this.db.prepare('UPDATE wishes SET status = ? WHERE id = ?').run(updates.status, id)
      }
      if (updates.comment !== undefined) {
        this.db.prepare('UPDATE wishes SET comment = ? WHERE id = ?').run(updates.comment, id)
      }
    })
    doUpdate()
    const row = this.db.prepare('SELECT * FROM wishes WHERE id = ?').get(id) as any
    if (!row) return undefined
    return {
      id: row.id, title: row.title, reason: row.reason,
      priority: row.priority, status: row.status, comment: row.comment, createdAt: row.created_at,
    }
  }

  // ---- Tasks ----

  addTask(task: { title: string; description?: string; assignee?: string; priority?: string; due_date?: string; created_by?: string }): Task {
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    const assignee = task.assignee ?? 'xiaoxi'
    const priority = (task.priority ?? 'normal') as Task['priority']
    this.db.prepare(`
      INSERT INTO tasks (id, title, description, assignee, status, priority, due_date, created_by, created_at)
      VALUES (?, ?, ?, ?, 'todo', ?, ?, ?, ?)
    `).run(id, task.title, task.description ?? null, assignee, priority, task.due_date ?? null, task.created_by ?? null, now)
    return { id, title: task.title, description: task.description, assignee, status: 'todo', priority, due_date: task.due_date, created_by: task.created_by, completed_at: undefined, created_at: now }
  }

  updateTask(id: string, updates: { status?: string; title?: string; description?: string; priority?: string; due_date?: string }): Task | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) return undefined

    const doUpdate = this.db.transaction(() => {
      if (updates.title !== undefined) {
        this.db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run(updates.title, id)
      }
      if (updates.description !== undefined) {
        this.db.prepare('UPDATE tasks SET description = ? WHERE id = ?').run(updates.description, id)
      }
      if (updates.priority !== undefined) {
        this.db.prepare('UPDATE tasks SET priority = ? WHERE id = ?').run(updates.priority, id)
      }
      if (updates.due_date !== undefined) {
        this.db.prepare('UPDATE tasks SET due_date = ? WHERE id = ?').run(updates.due_date, id)
      }
      if (updates.status !== undefined) {
        this.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(updates.status, id)
        if (updates.status === 'done') {
          this.db.prepare('UPDATE tasks SET completed_at = ? WHERE id = ?').run(new Date().toISOString(), id)
        } else {
          this.db.prepare('UPDATE tasks SET completed_at = NULL WHERE id = ?').run(id)
        }
      }
    })
    doUpdate()

    const updated = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown>
    return {
      id: updated.id as string, title: updated.title as string, description: updated.description as string | undefined,
      assignee: updated.assignee as string, status: updated.status as Task['status'], priority: updated.priority as Task['priority'],
      due_date: updated.due_date as string | undefined, created_by: updated.created_by as string | undefined,
      completed_at: updated.completed_at as string | undefined, created_at: updated.created_at as string,
    }
  }

  listTasks(filter?: { status?: string; assignee?: string }): Task[] {
    let sql = 'SELECT * FROM tasks'
    const conditions: string[] = []
    const params: unknown[] = []

    if (filter?.status) {
      conditions.push('status = ?')
      params.push(filter.status)
    }
    if (filter?.assignee) {
      conditions.push('assignee = ?')
      params.push(filter.assignee)
    }

    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ')
    sql += ' ORDER BY CASE priority WHEN \'urgent\' THEN 0 WHEN \'high\' THEN 1 WHEN \'normal\' THEN 2 WHEN \'low\' THEN 3 END, created_at DESC'

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[]
    return rows.map(r => ({
      id: r.id as string, title: r.title as string, description: r.description as string | undefined,
      assignee: r.assignee as string, status: r.status as Task['status'], priority: r.priority as Task['priority'],
      due_date: r.due_date as string | undefined, created_by: r.created_by as string | undefined,
      completed_at: r.completed_at as string | undefined, created_at: r.created_at as string,
    }))
  }

  deleteTask(id: string): boolean {
    const result = this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ---- Issues ----

  addIssue(title: string, description?: string, severity: string = 'normal', created_by: string = 'xiaoxi'): Issue {
    const id = `issue-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO issues (id, title, description, severity, status, created_by, created_at)
      VALUES (?, ?, ?, ?, 'open', ?, ?)
    `).run(id, title, description ?? null, severity, created_by, now)
    this.logActivity('extract', undefined, `New issue: ${title}`)
    return { id, title, description, severity: severity as Issue['severity'], status: 'open', created_by, created_at: now }
  }

  getIssues(status?: string): Issue[] {
    const sql = status
      ? 'SELECT * FROM issues WHERE status = ? ORDER BY created_at DESC'
      : 'SELECT * FROM issues ORDER BY created_at DESC'
    const rows = (status ? this.db.prepare(sql).all(status) : this.db.prepare(sql).all()) as any[]
    return rows.map(r => ({
      id: r.id, title: r.title, description: r.description,
      severity: r.severity, status: r.status, resolution: r.resolution,
      created_by: r.created_by, created_at: r.created_at, comments: r.comments ?? '[]',
    }))
  }

  updateIssue(id: string, updates: { status?: string; resolution?: string; severity?: string; description?: string; comment?: { author: string; content: string } }): Issue | undefined {
    const doUpdate = this.db.transaction(() => {
      if (updates.status !== undefined) {
        this.db.prepare('UPDATE issues SET status = ? WHERE id = ?').run(updates.status, id)
      }
      if (updates.resolution !== undefined) {
        this.db.prepare('UPDATE issues SET resolution = ? WHERE id = ?').run(updates.resolution, id)
      }
      if (updates.severity !== undefined) {
        this.db.prepare('UPDATE issues SET severity = ? WHERE id = ?').run(updates.severity, id)
      }
      if (updates.description !== undefined) {
        this.db.prepare('UPDATE issues SET description = ? WHERE id = ?').run(updates.description, id)
      }
      if (updates.comment) {
        // 追加评论到 comments JSON 数组
        const row = this.db.prepare('SELECT comments FROM issues WHERE id = ?').get(id) as any
        if (row) {
          let comments: Array<{ author: string; content: string; created_at: string }> = []
          try { comments = JSON.parse(row.comments || '[]') } catch { comments = [] }
          comments.push({ ...updates.comment, created_at: new Date().toISOString() })
          this.db.prepare('UPDATE issues SET comments = ? WHERE id = ?').run(JSON.stringify(comments), id)
        }
      }
    })
    doUpdate()
    const row = this.db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as any
    if (!row) return undefined
    return {
      id: row.id, title: row.title, description: row.description,
      severity: row.severity, status: row.status, resolution: row.resolution,
      created_by: row.created_by, created_at: row.created_at,
      comments: row.comments ?? '[]',
    }
  }

  // ---- Releases ----

  addRelease(version: string, commits: string[], gitHash?: string): Release {
    const id = `rel-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO releases (id, version, commits, deployed_at, git_hash)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, version, JSON.stringify(commits), now, gitHash ?? null)
    this.logActivity('extract', undefined, `Release ${version} deployed`)
    return { id, version, commits: JSON.stringify(commits), deployed_at: now, git_hash: gitHash }
  }

  getLatestRelease(): Release | undefined {
    const row = this.db.prepare('SELECT * FROM releases ORDER BY deployed_at DESC LIMIT 1').get() as any
    if (!row) return undefined
    return { id: row.id, version: row.version, commits: row.commits, deployed_at: row.deployed_at, git_hash: row.git_hash }
  }

  getReleases(limit = 20): Release[] {
    const rows = this.db.prepare('SELECT * FROM releases ORDER BY deployed_at DESC LIMIT ?').all(limit) as any[]
    return rows.map(r => ({
      id: r.id, version: r.version, commits: r.commits, deployed_at: r.deployed_at, git_hash: r.git_hash,
    }))
  }

  // ---- Active Tasks (restart recovery) ----

  addActiveTask(id: string, type: string, description: string, persona?: string, parentSessionKey?: string, metadata?: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO active_tasks (id, type, description, persona, parent_session_key, status, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, 'running', datetime('now'), ?)
    `).run(id, type, description, persona ?? null, parentSessionKey ?? null, metadata ? JSON.stringify(metadata) : null)
  }

  removeActiveTask(id: string): void {
    this.db.prepare('DELETE FROM active_tasks WHERE id = ?').run(id)
  }

  getActiveTasks(status?: string): Array<{ id: string; type: string; description: string; persona?: string; parent_session_key?: string; status: string; created_at: string; metadata?: string }> {
    const sql = status
      ? 'SELECT * FROM active_tasks WHERE status = ? ORDER BY created_at'
      : 'SELECT * FROM active_tasks ORDER BY created_at'
    const rows = (status ? this.db.prepare(sql).all(status) : this.db.prepare(sql).all()) as any[]
    return rows.map(r => ({
      id: r.id, type: r.type, description: r.description,
      persona: r.persona ?? undefined, parent_session_key: r.parent_session_key ?? undefined,
      status: r.status, created_at: r.created_at, metadata: r.metadata ?? undefined,
    }))
  }

  markTaskInterrupted(id: string): void {
    this.db.prepare("UPDATE active_tasks SET status = 'interrupted' WHERE id = ?").run(id)
  }

  // ---- Sent Cards (feishu v2 卡片引用解析) ----

  saveSentCard(feishuMessageId: string, content: string): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO sent_cards (feishu_message_id, content, created_at) VALUES (?, ?, ?)'
    ).run(feishuMessageId, content, new Date().toISOString())
  }

  lookupSentCard(feishuMessageId: string): string | undefined {
    const row = this.db.prepare(
      'SELECT content FROM sent_cards WHERE feishu_message_id = ?'
    ).get(feishuMessageId) as { content: string } | undefined
    return row?.content
  }

  cleanOldSentCards(maxAgeDays = 30): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString()
    const result = this.db.prepare('DELETE FROM sent_cards WHERE created_at < ?').run(cutoff)
    return result.changes
  }

  close(): void { this.db.close() }
}
