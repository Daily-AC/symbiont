/**
 * Suite 1 — Feishu Message Pipeline E2E Tests
 *
 * Tests the message handler pipeline: dedup, whitelist, mention check,
 * session key construction, session map updates, and routing.
 *
 * Run: node --experimental-strip-types --test tests/e2e-feishu-pipeline.test.ts
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// Mock feishu client must be set BEFORE importing feishu modules
import { createMockFeishuClient } from './mocks/feishu.ts'
import { setTestClient } from '../src/interface/feishu/client.ts'

// Feishu pipeline modules
import { handleFeishuMessage, type MessageHandlerDeps } from '../src/interface/feishu/message-handler.ts'
import { SessionMap } from '../src/interface/feishu/session-map.ts'
import { Whitelist } from '../src/interface/feishu/whitelist.ts'
import { MessageDedup } from '../src/interface/feishu/dedup.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_DATA = mkdtempSync(join(tmpdir(), 'symbiont-feishu-pipeline-'))

const BOT_ID = 'bot_open_id_123'
const BOT_NAME = 'TestBot'

/** Build a minimal Feishu message event for testing. */
function makeEvent(overrides: {
  messageId?: string
  chatId?: string
  chatType?: 'p2p' | 'group'
  text?: string
  mentions?: Array<{ id: { open_id: string }; name: string }>
  threadId?: string
  rootId?: string
  senderId?: string
}) {
  const {
    messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    chatId = 'chat_abc',
    chatType = 'p2p',
    text = 'hello',
    mentions,
    threadId,
    rootId,
    senderId = 'user_open_id_1',
  } = overrides
  return {
    message: {
      message_id: messageId,
      chat_id: chatId,
      chat_type: chatType,
      message_type: 'text',
      content: JSON.stringify({ text }),
      thread_id: threadId,
      root_id: rootId,
      mentions,
    },
    sender: {
      sender_id: { open_id: senderId },
    },
  }
}

describe('Feishu Message Pipeline', { timeout: 120_000 }, () => {
  let mock: ReturnType<typeof createMockFeishuClient>
  let sessionMap: SessionMap
  let whitelist: Whitelist
  let dedup: MessageDedup

  // Track router.sendTo calls instead of using real CC
  let routerCalls: Array<{ sessionKey: string; text: string }>
  let mockRouter: any

  before(() => {
    mock = createMockFeishuClient()
    setTestClient(mock.client)
  })

  beforeEach(() => {
    // Fresh state for each test
    const dataDir = mkdtempSync(join(TEST_DATA, 'test-'))
    sessionMap = new SessionMap(dataDir)
    whitelist = new Whitelist(dataDir)
    dedup = new MessageDedup()
    routerCalls = []
    mock.reset()

    // Mock router that captures calls instead of spawning CC
    mockRouter = {
      sendTo: async (sessionKey: string, text: string, _options?: any) => {
        routerCalls.push({ sessionKey, text })
        return 'mock reply'
      },
      setPushHandlerFor: (_key: string, _handler: any) => {},
    }
  })

  function makeDeps(): MessageHandlerDeps {
    return {
      router: mockRouter,
      sessionMap,
      whitelist,
      dedup,
      botId: BOT_ID,
      botName: BOT_NAME,
    }
  }

  // ---- Test 1: p2p text message routes correctly ----
  test('p2p text message → sessionKey = dm:{chatId}, reply triggers send', async () => {
    const chatId = 'chat_dm_001'
    const event = makeEvent({ chatId, chatType: 'p2p', text: 'hey there' })
    await handleFeishuMessage(event, makeDeps())

    // router.sendTo should have been called
    assert.equal(routerCalls.length, 1)
    assert.equal(routerCalls[0].sessionKey, `dm:${chatId}`)
    assert.ok(routerCalls[0].text.includes('hey there'))

    // Session map should be updated
    const mapping = sessionMap.get(`dm:${chatId}`)
    assert.ok(mapping)
    assert.equal(mapping!.chatId, chatId)
    assert.equal(mapping!.chatType, 'p2p')

    // Mock feishu client should have typing indicator calls
    const reactionCreates = mock.getCalls('im.messageReaction.create')
    assert.ok(reactionCreates.length >= 1, 'should add typing indicator')

    // Should have sent a reply (sendMarkdownCard → im.message.create or im.message.reply)
    const creates = mock.getCalls('im.message.create')
    const replies = mock.getCalls('im.message.reply')
    assert.ok(creates.length + replies.length >= 1, 'should send reply via create or reply')
  })

  // ---- Test 2: duplicate message_id is ignored ----
  test('duplicate message_id → second call ignored', async () => {
    const messageId = 'msg_dup_test_001'
    const event = makeEvent({ messageId, chatType: 'p2p', text: 'first' })

    await handleFeishuMessage(event, makeDeps())
    assert.equal(routerCalls.length, 1)

    // Second call with same messageId
    await handleFeishuMessage(event, makeDeps())
    assert.equal(routerCalls.length, 1, 'duplicate message should not route again')
  })

  // ---- Test 3: group message without @bot is ignored ----
  test('group without @bot → ignored (no reply)', async () => {
    const chatId = 'chat_group_001'
    whitelist.add(chatId)

    const event = makeEvent({
      chatId,
      chatType: 'group',
      text: 'random group message',
      // no mentions
    })

    await handleFeishuMessage(event, makeDeps())
    assert.equal(routerCalls.length, 0, 'group message without @bot should be ignored')
  })

  // ---- Test 4: group with @bot → routes correctly ----
  test('group with @bot → routes correctly, gets reply', async () => {
    const chatId = 'chat_group_002'
    whitelist.add(chatId)

    const event = makeEvent({
      chatId,
      chatType: 'group',
      text: `@${BOT_NAME} what's up`,
      mentions: [{ id: { open_id: BOT_ID }, name: BOT_NAME }],
    })

    await handleFeishuMessage(event, makeDeps())
    assert.equal(routerCalls.length, 1)
    assert.equal(routerCalls[0].sessionKey, `group:${chatId}`)
    // Bot mention should be removed from text
    assert.ok(!routerCalls[0].text.includes(`@${BOT_NAME}`))
  })

  // ---- Test 5: group NOT in whitelist → ignored ----
  test('group not in whitelist → ignored even with @bot', async () => {
    const chatId = 'chat_group_not_whitelisted'
    // Do NOT add to whitelist

    const event = makeEvent({
      chatId,
      chatType: 'group',
      text: `@${BOT_NAME} hello`,
      mentions: [{ id: { open_id: BOT_ID }, name: BOT_NAME }],
    })

    await handleFeishuMessage(event, makeDeps())
    assert.equal(routerCalls.length, 0, 'non-whitelisted group should be ignored')
  })

  // ---- Test 6: sessionKey correctness — dm: prefix for p2p ----
  test('sessionKey correctness — dm: for p2p, group: for group', async () => {
    const dmChatId = 'chat_p2p_key'
    const groupChatId = 'chat_group_key'
    whitelist.add(groupChatId)

    // p2p
    const p2pEvent = makeEvent({ chatId: dmChatId, chatType: 'p2p', text: 'hi' })
    await handleFeishuMessage(p2pEvent, makeDeps())
    assert.equal(routerCalls[0].sessionKey, `dm:${dmChatId}`)

    // group with @bot
    const groupEvent = makeEvent({
      chatId: groupChatId,
      chatType: 'group',
      text: `@${BOT_NAME} hi`,
      mentions: [{ id: { open_id: BOT_ID }, name: BOT_NAME }],
    })
    await handleFeishuMessage(groupEvent, makeDeps())
    assert.equal(routerCalls[1].sessionKey, `group:${groupChatId}`)

    // Verify session map has both
    assert.ok(sessionMap.get(`dm:${dmChatId}`))
    assert.ok(sessionMap.get(`group:${groupChatId}`))
  })

  // ---- Test 7: thread message → sessionKey = topic:{chatId}:{threadId} ----
  test('thread message → sessionKey = topic:{chatId}:{threadId}', async () => {
    const chatId = 'chat_thread_test'
    const rootId = 'root_msg_001'

    // p2p message with root_id (thread reply)
    const event = makeEvent({
      chatId,
      chatType: 'p2p',
      text: 'thread reply',
      rootId,
    })

    await handleFeishuMessage(event, makeDeps())
    assert.equal(routerCalls.length, 1)
    assert.equal(routerCalls[0].sessionKey, `topic:${chatId}:${rootId}`)

    // Session map should record the thread
    const mapping = sessionMap.get(`topic:${chatId}:${rootId}`)
    assert.ok(mapping)
    assert.equal(mapping!.threadId, rootId)
  })

  // ---- Test 8: thread_id takes precedence over root_id ----
  test('thread_id takes precedence over root_id for sessionKey', async () => {
    const chatId = 'chat_thread_prio'
    const threadId = 'thread_explicit_001'
    const rootId = 'root_fallback_001'

    const event = makeEvent({ chatId, chatType: 'p2p', text: 'hi' })
    // Manually set both thread_id and root_id
    event.message.thread_id = threadId
    event.message.root_id = rootId

    await handleFeishuMessage(event, makeDeps())
    assert.equal(routerCalls[0].sessionKey, `topic:${chatId}:${threadId}`)
  })

  // ---- Test 9: empty text is ignored ----
  test('empty text message → ignored', async () => {
    const event = makeEvent({ chatType: 'p2p', text: '   ' })
    await handleFeishuMessage(event, makeDeps())
    assert.equal(routerCalls.length, 0, 'empty text should be ignored')
  })

  // ---- Test 10: typing indicator lifecycle ----
  test('typing indicator is added and removed', async () => {
    const event = makeEvent({ chatType: 'p2p', text: 'trigger typing' })
    await handleFeishuMessage(event, makeDeps())

    const creates = mock.getCalls('im.messageReaction.create')
    const deletes = mock.getCalls('im.messageReaction.delete')
    assert.ok(creates.length >= 1, 'should add typing reaction')
    assert.ok(deletes.length >= 1, 'should remove typing reaction')
  })

  after(() => {
    setTestClient(null as any)
    if (existsSync(TEST_DATA)) {
      rmSync(TEST_DATA, { recursive: true })
    }
    setTimeout(() => process.exit(0), 500).unref()
  })
})
