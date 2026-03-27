import { getClient } from '../client.ts'

// ============ Helpers ============

const FIELD_TYPE_NAMES: Record<number, string> = {
  1: 'Text', 2: 'Number', 3: 'SingleSelect', 4: 'MultiSelect',
  5: 'DateTime', 7: 'Checkbox', 11: 'User', 13: 'Phone',
  15: 'URL', 17: 'Attachment', 18: 'SingleLink', 19: 'Lookup',
  20: 'Formula', 21: 'DuplexLink', 22: 'Location', 23: 'GroupChat',
  1001: 'CreatedUser', 1002: 'ModifiedUser', 1003: 'CreatedTime',
  1004: 'ModifiedTime', 1005: 'AutoNumber',
}

// ============ Exported Functions ============

/**
 * List all fields (columns) in a Bitable table.
 */
export async function listFields(
  appToken: string,
  tableId: string,
): Promise<{
  fields: Array<{
    fieldId: string | undefined
    fieldName: string | undefined
    type: number | undefined
    typeName: string
    isPrimary: boolean | undefined
  }>
  total: number
}> {
  const client = getClient()
  const res = await client.bitable.appTableField.list({
    path: { app_token: appToken, table_id: tableId },
  })
  if (res.code !== 0) throw new Error(res.msg)

  const fields = res.data?.items ?? []
  return {
    fields: fields.map((f) => ({
      fieldId: f.field_id,
      fieldName: f.field_name,
      type: f.type,
      typeName: FIELD_TYPE_NAMES[f.type ?? 0] || `type_${f.type}`,
      isPrimary: f.is_primary,
    })),
    total: fields.length,
  }
}

/**
 * List records (rows) from a Bitable table.
 */
export async function listRecords(
  appToken: string,
  tableId: string,
  pageSize?: number,
  pageToken?: string,
): Promise<{
  // deno-lint-ignore no-explicit-any
  records: any[]
  hasMore: boolean
  pageToken: string | undefined
  total: number | undefined
}> {
  const client = getClient()
  const res = await client.bitable.appTableRecord.list({
    path: { app_token: appToken, table_id: tableId },
    params: {
      page_size: pageSize ?? 100,
      ...(pageToken && { page_token: pageToken }),
    },
  })
  if (res.code !== 0) throw new Error(res.msg)

  return {
    records: res.data?.items ?? [],
    hasMore: res.data?.has_more ?? false,
    pageToken: res.data?.page_token,
    total: res.data?.total,
  }
}

/**
 * Create a new record (row) in a Bitable table.
 */
export async function createRecord(
  appToken: string,
  tableId: string,
  fields: Record<string, unknown>,
  // deno-lint-ignore no-explicit-any
): Promise<{ record: any }> {
  const client = getClient()
  const res = await client.bitable.appTableRecord.create({
    path: { app_token: appToken, table_id: tableId },
    // deno-lint-ignore no-explicit-any
    data: { fields: fields as any },
  })
  if (res.code !== 0) throw new Error(res.msg)
  return { record: res.data?.record }
}

/**
 * Update an existing record (row) in a Bitable table.
 */
export async function updateRecord(
  appToken: string,
  tableId: string,
  recordId: string,
  fields: Record<string, unknown>,
  // deno-lint-ignore no-explicit-any
): Promise<{ record: any }> {
  const client = getClient()
  const res = await client.bitable.appTableRecord.update({
    path: { app_token: appToken, table_id: tableId, record_id: recordId },
    // deno-lint-ignore no-explicit-any
    data: { fields: fields as any },
  })
  if (res.code !== 0) throw new Error(res.msg)
  return { record: res.data?.record }
}

/**
 * Create a new Bitable application.
 */
export async function createApp(
  name: string,
  folderToken?: string,
): Promise<{
  appToken: string
  tableId: string | undefined
  name: string | undefined
  url: string | undefined
}> {
  const client = getClient()
  const res = await client.bitable.app.create({
    data: {
      name,
      ...(folderToken && { folder_token: folderToken }),
    },
  })
  if (res.code !== 0) throw new Error(res.msg)

  const appToken = res.data?.app?.app_token
  if (!appToken) throw new Error('Failed to create Bitable: no app_token returned')

  // Get default table id
  let tableId: string | undefined
  try {
    const tablesRes = await client.bitable.appTable.list({
      path: { app_token: appToken },
    })
    if (tablesRes.code === 0 && tablesRes.data?.items?.length) {
      tableId = tablesRes.data.items[0].table_id ?? undefined
    }
  } catch { /* non-critical */ }

  return {
    appToken,
    tableId,
    name: res.data?.app?.name,
    url: res.data?.app?.url,
  }
}

/**
 * Add a new table (data sheet) to an existing Bitable application.
 */
export async function addTable(
  appToken: string,
  name: string,
  fields?: Array<{ field_name: string; type: number }>,
): Promise<{
  tableId: string
}> {
  const client = getClient()
  const res = await client.bitable.appTable.create({
    path: { app_token: appToken },
    data: {
      table: {
        name,
        ...(fields?.length && {
          fields: fields.map((f) => ({
            field_name: f.field_name,
            type: f.type,
          })),
        }),
      },
    },
  })
  if (res.code !== 0) throw new Error(res.msg)

  const tableId = res.data?.table_id
  if (!tableId) throw new Error('Failed to add table: no table_id returned')

  return { tableId }
}
