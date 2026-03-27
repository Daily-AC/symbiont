// tests/issue-comments.test.ts — Issue 评论追加 + Activity session_id 关联
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryDB } from '../src/memory/db.ts'

// ── Issue Comments ──────────────────────────────────────────────────────────

describe('Issue Comments', () => {
  let db: MemoryDB
  let dir: string

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'symbiont-issue-comments-'))
    db = new MemoryDB(dir)
  })
  after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  test('addIssue creates issue with empty comments array', () => {
    const issue = db.addIssue('飞书消息发送失败')
    // comments 是 JSON 字符串，默认应为 '[]'
    // getIssues 返回的 comments 字段是 JSON string
    const fetched = db.getIssues().find(i => i.id === issue.id)
    assert.ok(fetched)
    const comments = JSON.parse(fetched!.comments as unknown as string || '[]')
    assert.ok(Array.isArray(comments))
    assert.equal(comments.length, 0)
  })

  test('updateIssue with comment appends to comments array', () => {
    const issue = db.addIssue('内存泄漏问题')
    const updated = db.updateIssue(issue.id, {
      comment: { author: 'xiaoxi', content: '已重现该问题' },
    })
    assert.ok(updated)
    const comments = JSON.parse(updated!.comments as unknown as string || '[]')
    assert.equal(comments.length, 1)
    assert.equal(comments[0].author, 'xiaoxi')
    assert.equal(comments[0].content, '已重现该问题')
    assert.ok(comments[0].created_at, 'comment should have created_at')
  })

  test('multiple comments append incrementally', () => {
    const issue = db.addIssue('多评论测试')

    db.updateIssue(issue.id, {
      comment: { author: 'xiaoxi', content: '第一条评论' },
    })
    db.updateIssue(issue.id, {
      comment: { author: 'cc', content: '第二条评论' },
    })
    db.updateIssue(issue.id, {
      comment: { author: 'xiaoxi', content: '第三条评论' },
    })

    const fetched = db.getIssues().find(i => i.id === issue.id)
    assert.ok(fetched)
    const comments = JSON.parse(fetched!.comments as unknown as string || '[]')
    assert.equal(comments.length, 3)
    assert.equal(comments[0].content, '第一条评论')
    assert.equal(comments[1].author, 'cc')
    assert.equal(comments[2].content, '第三条评论')
  })

  test('getIssues returns data with comments field', () => {
    const all = db.getIssues()
    assert.ok(all.length >= 1)
    for (const issue of all) {
      assert.ok('comments' in issue, `issue ${issue.id} should have comments field`)
      // comments 应是合法 JSON 字符串
      const parsed = JSON.parse(issue.comments as unknown as string || '[]')
      assert.ok(Array.isArray(parsed))
    }
  })

  test('issueGet returns correct issue details', () => {
    const issue = db.addIssue('详情查看测试', '这是描述', 'high')
    const rows = db.getIssues()
    const found = rows.find(i => i.id === issue.id)
    assert.ok(found)
    assert.equal(found!.title, '详情查看测试')
    assert.equal(found!.severity, 'high')
    assert.ok(found!.created_at)
  })

  test('issueGet returns comments field', () => {
    const issue = db.addIssue('评论详情测试')
    db.updateIssue(issue.id, {
      comment: { author: 'cc', content: '测试评论' },
    })
    const rows = db.getIssues()
    const found = rows.find(i => i.id === issue.id)
    assert.ok(found)
    assert.ok('comments' in found!)
    const comments = JSON.parse(found!.comments as unknown as string || '[]')
    assert.equal(comments.length, 1)
    assert.equal(comments[0].content, '测试评论')
  })

  test('issueGet with non-existent id returns undefined', () => {
    const rows = db.getIssues()
    const found = rows.find(i => i.id === 'non-existent-id-12345')
    assert.equal(found, undefined)
  })

  test('comment and status update in same call', () => {
    const issue = db.addIssue('同时更新状态和评论')
    const updated = db.updateIssue(issue.id, {
      status: 'investigating',
      comment: { author: 'cc', content: '开始排查' },
    })
    assert.ok(updated)
    assert.equal(updated!.status, 'investigating')
    const comments = JSON.parse(updated!.comments as unknown as string || '[]')
    assert.equal(comments.length, 1)
    assert.equal(comments[0].content, '开始排查')
  })
})

// ── Activity session_id 关联 ────────────────────────────────────────────────

describe('Activity session_id', () => {
  let db: MemoryDB
  let dir: string

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'symbiont-activity-session-'))
    db = new MemoryDB(dir)
  })
  after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  test('logActivity without sessionId → getActivity returns null/undefined sessionId', () => {
    db.logActivity('extract', undefined, '无 session 的活动')
    const activities = db.getActivity(1)
    assert.ok(activities.length >= 1)
    const latest = activities[0]
    assert.ok(latest.sessionId === null || latest.sessionId === undefined,
      `sessionId should be null/undefined, got: ${latest.sessionId}`)
  })

  test('logActivity with sessionId → getActivity returns correct sessionId', () => {
    const sid = 'session-test-123'
    db.logActivity('connect', undefined, '带 session 的活动', sid)
    const activities = db.getActivity(10)
    const found = activities.find(a => a.detail === '带 session 的活动')
    assert.ok(found)
    assert.equal(found!.sessionId, sid)
  })

  test('addCard with sessionId → activity record has that sessionId', () => {
    const sid = 'session-card-456'
    db.addCard(
      { content: 'session 关联卡片', scene: 'test', tags: ['session-test'], confidence: 0.7, source: [], connections: [] },
      undefined,  // owner
      sid,         // sessionId
    )
    const activities = db.getActivity(10)
    const found = activities.find(a => a.detail.includes('session 关联卡片'))
    assert.ok(found, 'should find activity for the new card')
    assert.equal(found!.sessionId, sid)
  })

  test('addCard without sessionId → activity has no sessionId', () => {
    db.addCard(
      { content: '无 session 卡片', scene: 'test', tags: ['no-session'], confidence: 0.7, source: [], connections: [] },
    )
    const activities = db.getActivity(10)
    const found = activities.find(a => a.detail.includes('无 session 卡片'))
    assert.ok(found)
    assert.ok(found!.sessionId === null || found!.sessionId === undefined)
  })
})
