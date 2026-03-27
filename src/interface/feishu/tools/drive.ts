import { getClient } from '../client.ts'

/**
 * Create a folder in Feishu Drive.
 */
export async function createFolder(
  name: string,
  folderToken?: string,
): Promise<{ token: string | undefined; url: string | undefined }> {
  const client = getClient()
  const res = await client.drive.file.createFolder({
    data: {
      name,
      folder_token: folderToken ?? '0',
    },
  })
  if (res.code !== 0) throw new Error(res.msg)
  return { token: res.data?.token, url: res.data?.url }
}

/**
 * List files in a folder.
 */
export async function listFiles(
  folderToken?: string,
): Promise<{
  files: Array<{
    token: string | undefined
    name: string | undefined
    type: string | undefined
    url: string | undefined
    createdTime: string | undefined
    modifiedTime: string | undefined
  }>
  nextPageToken: string | undefined
}> {
  const client = getClient()
  const validToken = folderToken && folderToken !== '0' ? folderToken : undefined
  const res = await client.drive.file.list({
    params: validToken ? { folder_token: validToken } : {},
  })
  if (res.code !== 0) throw new Error(res.msg)

  return {
    files: res.data?.files?.map((f) => ({
      token: f.token,
      name: f.name,
      type: f.type,
      url: f.url,
      createdTime: f.created_time,
      modifiedTime: f.modified_time,
    })) ?? [],
    nextPageToken: res.data?.next_page_token,
  }
}

/**
 * Move a file to a different folder.
 */
export async function moveFile(
  fileToken: string,
  destFolderToken: string,
  type: string = 'file',
): Promise<{ success: boolean; taskId: string | undefined }> {
  const client = getClient()
  type DriveFileType = 'doc' | 'docx' | 'sheet' | 'bitable' | 'folder' | 'file' | 'mindnote' | 'slides'
  const res = await client.drive.file.move({
    path: { file_token: fileToken },
    data: {
      type: type as DriveFileType,
      folder_token: destFolderToken,
    },
  })
  if (res.code !== 0) throw new Error(res.msg)
  return { success: true, taskId: res.data?.task_id }
}
