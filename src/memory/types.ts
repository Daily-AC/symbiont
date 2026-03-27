export interface ExperienceCard {
  id: string
  content: string
  scene: string
  tags: string[]
  confidence: number
  createdAt: string
  lastUsed: string
  source: string[]
  connections: string[]  // kept for backward compat, graph lives in connections table
  archived?: boolean
  essence?: string       // distilled knowledge when archived
  owner: string          // persona name, default 'xiaoxi'; 'shared' for shared knowledge base
}

export interface Connection {
  id: string
  fromId: string
  toId: string
  type: 'causal' | 'similar' | 'contradicts' | 'supplements' | 'evolves'
  strength: number
  reason?: string
  createdAt: string
}

export interface Cognition {
  id: string
  tag: string
  summary: string
  status: 'pending' | 'approved' | 'rejected'
  sourceCards: string[]
  createdAt: string
}

export interface Feedback {
  id: string
  cardId: string
  verdict: 'correct' | 'wrong' | 'important' | 'outdated'
  comment?: string
  createdAt: string
}

export interface ActivityEntry {
  id: string
  type: 'extract' | 'connect' | 'decay' | 'archive' | 'revive' | 'aggregate' | 'feedback' | 'compile' | 'settle'
  cardId?: string
  sessionId?: string
  detail: string
  createdAt: string
}

export interface Task {
  id: string
  title: string
  description?: string
  assignee: string
  status: 'todo' | 'doing' | 'done' | 'cancelled'
  priority: 'low' | 'normal' | 'high' | 'urgent'
  due_date?: string
  created_by?: string
  completed_at?: string
  created_at: string
}

export interface Wish {
  id: string
  title: string
  reason?: string
  priority: 'low' | 'normal' | 'high'
  status: 'pending' | 'accepted' | 'rejected' | 'done'
  comment?: string
  createdAt: string
}

export interface Issue {
  id: string
  title: string
  description?: string
  severity: 'low' | 'normal' | 'high' | 'critical'
  status: 'open' | 'investigating' | 'resolved' | 'wontfix'
  resolution?: string
  created_by: string
  created_at: string
  comments?: string  // JSON array of { author, content, created_at }
}

export interface Release {
  id: string
  version: string
  commits: string       // JSON array of commit summary strings
  deployed_at: string
  git_hash?: string
}
