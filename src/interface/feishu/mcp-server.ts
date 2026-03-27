import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createMcpHttpServer, type McpHttpServerHandle } from '../../core/mcp-transport.ts'
import type { SessionMap } from './session-map.ts'
import type { Whitelist } from './whitelist.ts'

export type FeishuMcpServerHandle = McpHttpServerHandle

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

function errorResult(err: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  }
}

/**
 * Resolve chatId from session_key using SessionMap.
 * Falls back to using session_key directly as chatId if not found.
 */
function resolveChatId(sessionMap: SessionMap, sessionKey: string): string {
  const mapping = sessionMap.get(sessionKey)
  if (mapping) return mapping.chatId
  // Allow direct chatId usage for convenience
  return sessionKey
}

/**
 * Create a Feishu MCP Server that exposes all feishu tools to CC.
 */
export async function createFeishuMcpServer(
  sessionMap: SessionMap,
  whitelist: Whitelist,
  db?: import('../../memory/db.ts').MemoryDB,
): Promise<FeishuMcpServerHandle> {

  // ============ Tool Definitions ============

  const toolDefinitions = [
      // --- Messaging ---
      {
        name: 'feishu_send_message',
        description: 'Send a markdown card message to a feishu chat.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            session_key: { type: 'string', description: 'Session key or chat_id' },
            content: { type: 'string', description: 'Markdown content' },
            title: { type: 'string', description: 'Card title (optional)' },
          },
          required: ['session_key', 'content'],
        },
      },
      // --- Docx ---
      {
        name: 'feishu_create_doc',
        description: 'Create a new Feishu document. Returns documentId and URL.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            title: { type: 'string', description: 'Document title' },
            folder_token: { type: 'string', description: 'Folder to place doc in (optional)' },
          },
          required: ['title'],
        },
      },
      {
        name: 'feishu_read_doc',
        description: 'Read a Feishu document. Returns plain text content and block info.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            document_id: { type: 'string', description: 'Document ID' },
          },
          required: ['document_id'],
        },
      },
      {
        name: 'feishu_insert_blocks',
        description: 'Insert markdown content as blocks into a Feishu document.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            document_id: { type: 'string', description: 'Document ID' },
            markdown: { type: 'string', description: 'Markdown content to insert' },
            parent_block_id: { type: 'string', description: 'Parent block ID (optional, defaults to doc root)' },
          },
          required: ['document_id', 'markdown'],
        },
      },
      // --- Wiki ---
      {
        name: 'feishu_wiki_list_spaces',
        description: 'List all accessible wiki spaces.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      {
        name: 'feishu_wiki_list_nodes',
        description: 'List nodes in a wiki space.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            space_id: { type: 'string', description: 'Wiki space ID' },
            parent_node_token: { type: 'string', description: 'Parent node token (optional, root if omitted)' },
          },
          required: ['space_id'],
        },
      },
      {
        name: 'feishu_wiki_create',
        description: 'Create a new wiki node (docx).',
        inputSchema: {
          type: 'object' as const,
          properties: {
            space_id: { type: 'string', description: 'Wiki space ID' },
            title: { type: 'string', description: 'Node title' },
            parent_node_token: { type: 'string', description: 'Parent node token (optional)' },
          },
          required: ['space_id', 'title'],
        },
      },
      // --- Bitable ---
      {
        name: 'feishu_bitable_list_fields',
        description: 'List all fields (columns) in a Bitable table.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            app_token: { type: 'string', description: 'Bitable app token' },
            table_id: { type: 'string', description: 'Table ID' },
          },
          required: ['app_token', 'table_id'],
        },
      },
      {
        name: 'feishu_bitable_list_records',
        description: 'List records (rows) from a Bitable table.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            app_token: { type: 'string', description: 'Bitable app token' },
            table_id: { type: 'string', description: 'Table ID' },
            page_size: { type: 'number', description: 'Records per page (1-500, default 100)' },
            page_token: { type: 'string', description: 'Pagination token from previous response' },
          },
          required: ['app_token', 'table_id'],
        },
      },
      {
        name: 'feishu_bitable_create_record',
        description: 'Create a new record (row) in a Bitable table.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            app_token: { type: 'string', description: 'Bitable app token' },
            table_id: { type: 'string', description: 'Table ID' },
            fields: { type: 'object', description: 'Field values keyed by field name' },
          },
          required: ['app_token', 'table_id', 'fields'],
        },
      },
      {
        name: 'feishu_bitable_create',
        description: 'Create a new Bitable application (multi-dimensional spreadsheet). Returns app_token and URL.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            name: { type: 'string', description: 'Bitable name' },
            folder_token: { type: 'string', description: 'Folder token to place the bitable in (optional, root if omitted)' },
          },
          required: ['name'],
        },
      },
      {
        name: 'feishu_bitable_add_table',
        description: 'Add a new data table to an existing Bitable application.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            app_token: { type: 'string', description: 'Bitable app token' },
            name: { type: 'string', description: 'Table name' },
            fields: {
              type: 'array',
              description: 'Field definitions. Type values: 1=Text, 2=Number, 3=SingleSelect, 4=MultiSelect, 5=DateTime, 7=Checkbox, 11=User, 13=Phone, 15=URL, 17=Attachment, 18=SingleLink, 22=Location, 23=GroupChat, 1001=CreatedUser, 1002=ModifiedUser, 1003=CreatedTime, 1004=ModifiedTime',
              items: {
                type: 'object',
                properties: {
                  field_name: { type: 'string', description: 'Field name' },
                  type: { type: 'number', description: 'Field type number' },
                },
                required: ['field_name', 'type'],
              },
            },
          },
          required: ['app_token', 'name'],
        },
      },
      {
        name: 'feishu_bitable_update_record',
        description: 'Update an existing record (row) in a Bitable table.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            app_token: { type: 'string', description: 'Bitable app token' },
            table_id: { type: 'string', description: 'Table ID' },
            record_id: { type: 'string', description: 'Record ID to update' },
            fields: { type: 'object', description: 'Field values to update' },
          },
          required: ['app_token', 'table_id', 'record_id', 'fields'],
        },
      },
      // --- Drive ---
      {
        name: 'feishu_drive_create_folder',
        description: 'Create a folder in Feishu Drive.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            name: { type: 'string', description: 'Folder name' },
            parent_token: { type: 'string', description: 'Parent folder token (optional, root if omitted)' },
          },
          required: ['name'],
        },
      },
      {
        name: 'feishu_drive_list_files',
        description: 'List files in a Feishu Drive folder.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            folder_token: { type: 'string', description: 'Folder token (optional, root if omitted)' },
          },
        },
      },
      // --- Perm ---
      {
        name: 'feishu_perm_add',
        description: 'Add permission member to a document/file.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            token: { type: 'string', description: 'Document/file token' },
            type: { type: 'string', description: 'Token type: doc, docx, sheet, bitable, file, wiki, folder' },
            member_type: { type: 'string', description: 'Member type: email, openid, userid, openchat, etc.' },
            member_id: { type: 'string', description: 'Member ID' },
            perm: { type: 'string', description: 'Permission: view, edit, full_access' },
          },
          required: ['token', 'type', 'member_type', 'member_id', 'perm'],
        },
      },
      {
        name: 'feishu_perm_remove',
        description: 'Remove permission member from a document/file.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            token: { type: 'string', description: 'Document/file token' },
            type: { type: 'string', description: 'Token type: doc, docx, sheet, bitable, file, wiki, folder' },
            member_type: { type: 'string', description: 'Member type: email, openid, userid, openchat, etc.' },
            member_id: { type: 'string', description: 'Member ID' },
          },
          required: ['token', 'type', 'member_type', 'member_id'],
        },
      },
      // --- Approval & Progress ---
      {
        name: 'feishu_send_approval',
        description: 'Send an approval card and wait for user decision. Returns approved/rejected/timeout.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            session_key: { type: 'string', description: 'Session key or chat_id' },
            title: { type: 'string', description: 'Approval title' },
            description: { type: 'string', description: 'Approval description (markdown)' },
            timeout_ms: { type: 'number', description: 'Timeout in ms (default 300000 = 5min)' },
          },
          required: ['session_key', 'title', 'description'],
        },
      },
      {
        name: 'feishu_send_progress',
        description: 'Send a progress card showing step status. Returns messageId for updates.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            session_key: { type: 'string', description: 'Session key or chat_id' },
            title: { type: 'string', description: 'Progress title' },
            steps: { type: 'array', items: { type: 'string' }, description: 'Step names' },
            current_step: { type: 'number', description: 'Current step index (0-based)' },
          },
          required: ['session_key', 'title', 'steps', 'current_step'],
        },
      },
      {
        name: 'feishu_update_progress',
        description: 'Update an existing progress card.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            message_id: { type: 'string', description: 'Message ID of the progress card' },
            title: { type: 'string', description: 'Progress title' },
            steps: { type: 'array', items: { type: 'string' }, description: 'Step names' },
            current_step: { type: 'number', description: 'Current step index (0-based)' },
          },
          required: ['message_id', 'title', 'steps', 'current_step'],
        },
      },
      // --- Whitelist ---
      {
        name: 'feishu_whitelist_add',
        description: 'Add a chat to the whitelist.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: { type: 'string', description: 'Chat ID to whitelist' },
            name: { type: 'string', description: 'Display name (optional)' },
          },
          required: ['chat_id'],
        },
      },
      {
        name: 'feishu_whitelist_remove',
        description: 'Remove a chat from the whitelist.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: { type: 'string', description: 'Chat ID to remove' },
          },
          required: ['chat_id'],
        },
      },
      {
        name: 'feishu_whitelist_list',
        description: 'List all whitelisted chats.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      // --- Calendar ---
      {
        name: 'feishu_calendar_create',
        description: 'Create a calendar event.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            title: { type: 'string', description: 'Event title' },
            start_time: { type: 'string', description: 'Start time (ISO 8601)' },
            end_time: { type: 'string', description: 'End time (ISO 8601)' },
            description: { type: 'string', description: 'Event description (optional)' },
            attendees: { type: 'array', items: { type: 'string' }, description: 'Attendee user_ids (optional)' },
          },
          required: ['title', 'start_time', 'end_time'],
        },
      },
      {
        name: 'feishu_calendar_list',
        description: 'List calendar events in a time range.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            start_time: { type: 'string', description: 'Range start (ISO 8601)' },
            end_time: { type: 'string', description: 'Range end (ISO 8601)' },
          },
          required: ['start_time', 'end_time'],
        },
      },
      {
        name: 'feishu_calendar_update',
        description: 'Update a calendar event.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            event_id: { type: 'string', description: 'Event ID to update' },
            title: { type: 'string', description: 'New title (optional)' },
            start_time: { type: 'string', description: 'New start time ISO 8601 (optional)' },
            end_time: { type: 'string', description: 'New end time ISO 8601 (optional)' },
            description: { type: 'string', description: 'New description (optional)' },
          },
          required: ['event_id'],
        },
      },
      {
        name: 'feishu_calendar_delete',
        description: 'Delete a calendar event.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            event_id: { type: 'string', description: 'Event ID to delete' },
          },
          required: ['event_id'],
        },
      },
      // --- File & Image ---
      {
        name: 'feishu_send_file',
        description: 'Upload a local file and send it to a chat.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            session_key: { type: 'string', description: 'Session key or chat_id' },
            file_path: { type: 'string', description: 'Local file path' },
            file_name: { type: 'string', description: 'File name to display' },
          },
          required: ['session_key', 'file_path', 'file_name'],
        },
      },
      {
        name: 'feishu_upload_image',
        description: 'Upload a local image and send it to a chat.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            session_key: { type: 'string', description: 'Session key or chat_id' },
            file_path: { type: 'string', description: 'Local image file path' },
          },
          required: ['session_key', 'file_path'],
        },
      },
  ]

  // ============ Tool Handlers ============

  async function handleToolCall(name: string, args: Record<string, unknown> | undefined) {
    try {
      switch (name) {
        // --- Messaging ---
        case 'feishu_send_message': {
          const { sendMarkdownCard, replyInThread } = await import('./send.ts')
          const sk = args?.session_key as string
          const mapping = sessionMap.get(sk)

          const content = args?.content as string
          let messageId: string | undefined

          if (mapping?.anchorMessageId && sk.startsWith('topic:')) {
            messageId = await replyInThread(mapping.anchorMessageId, content)
          } else {
            const chatId = mapping?.chatId ?? sk
            messageId = await sendMarkdownCard(chatId, content, {
              title: args?.title as string | undefined,
            })
          }
          if (messageId && db) db.saveSentCard(messageId, content)
          return json({ success: true, messageId })
        }

        // --- Docx ---
        case 'feishu_create_doc': {
          const { createDoc } = await import('./tools/docx.ts')
          return json(await createDoc(args?.title as string, args?.folder_token as string | undefined))
        }
        case 'feishu_read_doc': {
          const { readDoc } = await import('./tools/docx.ts')
          return json(await readDoc(args?.document_id as string))
        }
        case 'feishu_insert_blocks': {
          const { insertBlocks } = await import('./tools/docx.ts')
          return json(await insertBlocks(
            args?.document_id as string,
            args?.markdown as string,
            args?.parent_block_id as string | undefined,
          ))
        }

        // --- Wiki ---
        case 'feishu_wiki_list_spaces': {
          const { listSpaces } = await import('./tools/wiki.ts')
          return json(await listSpaces())
        }
        case 'feishu_wiki_list_nodes': {
          const { listNodes } = await import('./tools/wiki.ts')
          return json(await listNodes(args?.space_id as string, args?.parent_node_token as string | undefined))
        }
        case 'feishu_wiki_create': {
          const { createNode } = await import('./tools/wiki.ts')
          return json(await createNode(
            args?.space_id as string,
            args?.title as string,
            args?.parent_node_token as string | undefined,
          ))
        }

        // --- Bitable ---
        case 'feishu_bitable_list_fields': {
          const { listFields } = await import('./tools/bitable.ts')
          return json(await listFields(args?.app_token as string, args?.table_id as string))
        }
        case 'feishu_bitable_list_records': {
          const { listRecords } = await import('./tools/bitable.ts')
          return json(await listRecords(
            args?.app_token as string,
            args?.table_id as string,
            args?.page_size as number | undefined,
            args?.page_token as string | undefined,
          ))
        }
        case 'feishu_bitable_create_record': {
          const { createRecord } = await import('./tools/bitable.ts')
          return json(await createRecord(
            args?.app_token as string,
            args?.table_id as string,
            args?.fields as Record<string, unknown>,
          ))
        }
        case 'feishu_bitable_create': {
          const { createApp } = await import('./tools/bitable.ts')
          return json(await createApp(
            args?.name as string,
            args?.folder_token as string | undefined,
          ))
        }
        case 'feishu_bitable_add_table': {
          const { addTable } = await import('./tools/bitable.ts')
          return json(await addTable(
            args?.app_token as string,
            args?.name as string,
            args?.fields as Array<{ field_name: string; type: number }> | undefined,
          ))
        }
        case 'feishu_bitable_update_record': {
          const { updateRecord } = await import('./tools/bitable.ts')
          return json(await updateRecord(
            args?.app_token as string,
            args?.table_id as string,
            args?.record_id as string,
            args?.fields as Record<string, unknown>,
          ))
        }

        // --- Drive ---
        case 'feishu_drive_create_folder': {
          const { createFolder } = await import('./tools/drive.ts')
          return json(await createFolder(args?.name as string, args?.parent_token as string | undefined))
        }
        case 'feishu_drive_list_files': {
          const { listFiles } = await import('./tools/drive.ts')
          return json(await listFiles(args?.folder_token as string | undefined))
        }

        // --- Perm ---
        case 'feishu_perm_add': {
          const { addMember } = await import('./tools/perm.ts')
          return json(await addMember(
            args?.token as string,
            args?.type as string,
            args?.member_type as string,
            args?.member_id as string,
            args?.perm as string,
          ))
        }
        case 'feishu_perm_remove': {
          const { removeMember } = await import('./tools/perm.ts')
          return json(await removeMember(
            args?.token as string,
            args?.type as string,
            args?.member_type as string,
            args?.member_id as string,
          ))
        }

        // --- Approval & Progress ---
        case 'feishu_send_approval': {
          const { sendApproval } = await import('./tools/approval-card.ts')
          const chatId = resolveChatId(sessionMap, args?.session_key as string)
          const result = await sendApproval(
            chatId,
            args?.title as string,
            args?.description as string,
            args?.timeout_ms as number | undefined,
          )
          return json({ result })
        }
        case 'feishu_send_progress': {
          const { sendProgress } = await import('./tools/progress-card.ts')
          const chatId = resolveChatId(sessionMap, args?.session_key as string)
          const messageId = await sendProgress(
            chatId,
            args?.title as string,
            args?.steps as string[],
            args?.current_step as number,
          )
          return json({ messageId })
        }
        case 'feishu_update_progress': {
          const { updateProgress } = await import('./tools/progress-card.ts')
          await updateProgress(
            args?.message_id as string,
            args?.title as string,
            args?.steps as string[],
            args?.current_step as number,
          )
          return json({ success: true })
        }

        // --- Whitelist ---
        case 'feishu_whitelist_add': {
          whitelist.add(args?.chat_id as string, args?.name as string | undefined)
          return json({ success: true })
        }
        case 'feishu_whitelist_remove': {
          whitelist.remove(args?.chat_id as string)
          return json({ success: true })
        }
        case 'feishu_whitelist_list': {
          return json({ entries: whitelist.list() })
        }

        // --- Calendar ---
        case 'feishu_calendar_create': {
          const { createCalendarEvent } = await import('./tools/calendar.ts')
          return json(await createCalendarEvent({
            title: args?.title as string,
            startTime: args?.start_time as string,
            endTime: args?.end_time as string,
            description: args?.description as string | undefined,
            attendees: args?.attendees as string[] | undefined,
          }))
        }
        case 'feishu_calendar_list': {
          const { listCalendarEvents } = await import('./tools/calendar.ts')
          return json(await listCalendarEvents({
            startTime: args?.start_time as string,
            endTime: args?.end_time as string,
          }))
        }
        case 'feishu_calendar_update': {
          const { updateCalendarEvent } = await import('./tools/calendar.ts')
          return json(await updateCalendarEvent({
            eventId: args?.event_id as string,
            title: args?.title as string | undefined,
            startTime: args?.start_time as string | undefined,
            endTime: args?.end_time as string | undefined,
            description: args?.description as string | undefined,
          }))
        }
        case 'feishu_calendar_delete': {
          const { deleteCalendarEvent } = await import('./tools/calendar.ts')
          return json(await deleteCalendarEvent({
            eventId: args?.event_id as string,
          }))
        }

        // --- File & Image ---
        case 'feishu_send_file': {
          const { uploadFile } = await import('./media.ts')
          const { sendFile } = await import('./send.ts')
          const chatId = resolveChatId(sessionMap, args?.session_key as string)
          const fileKey = await uploadFile(args?.file_path as string, args?.file_name as string)
          const messageId = await sendFile(chatId, fileKey)
          return json({ success: true, fileKey, messageId })
        }
        case 'feishu_upload_image': {
          const { uploadImage } = await import('./media.ts')
          const chatId = resolveChatId(sessionMap, args?.session_key as string)
          const imageKey = await uploadImage(args?.file_path as string)
          // Send image message
          const { getClient } = await import('./client.ts')
          const client = getClient()
          const res = await client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'image',
              content: JSON.stringify({ image_key: imageKey }),
            },
          })
          return json({ success: true, imageKey, messageId: res?.data?.message_id })
        }



        default:
          return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true }
      }
    } catch (err) {
      return errorResult(err)
    }
  }

  // ============ HTTP Server (via shared helper) ============

  const handle = await createMcpHttpServer({
    name: 'symbiont-feishu',
    version: '1.0.0',
    setupHandlers: (server) => {
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }))
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params
        return handleToolCall(name, args)
      })
    },
  })

  console.log(`[feishu-mcp] server started at ${handle.url}`)
  return handle
}
