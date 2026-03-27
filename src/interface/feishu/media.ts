import { getClient } from './client.ts'
import { createReadStream, createWriteStream, statSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function uploadImage(filePath: string): Promise<string> {
  const client = getClient()
  const res: any = await client.im.image.create({
    data: {
      image_type: 'message',
      image: createReadStream(filePath),
    },
  })
  const imageKey = res?.data?.image_key ?? res?.image_key
  if (!imageKey) throw new Error(`Upload image failed: ${JSON.stringify(res)}`)
  return imageKey
}

export async function uploadFile(filePath: string, fileName: string): Promise<string> {
  const client = getClient()
  const res: any = await client.im.file.create({
    data: {
      file_type: 'stream',
      file_name: fileName,
      file: createReadStream(filePath),
    },
  })
  const fileKey = res?.data?.file_key ?? res?.file_key
  if (!fileKey) throw new Error(`Upload file failed: ${JSON.stringify(res)}`)
  return fileKey
}

export async function downloadMessageResource(
  messageId: string,
  fileKey: string,
  type: 'image' | 'file',
  destDir: string,
  fileName?: string
): Promise<string> {
  const client = getClient()
  const res: any = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  })
  const destPath = join(destDir, fileName ?? fileKey)

  // SDK 返回的对象直接有 writeFile / getReadableStream 方法
  if (typeof res?.writeFile === 'function') {
    await res.writeFile(destPath)
  } else if (typeof res?.getReadableStream === 'function') {
    const ws = createWriteStream(destPath)
    await new Promise<void>((resolve, reject) => {
      res.getReadableStream().pipe(ws)
      ws.on('finish', resolve)
      ws.on('error', reject)
    })
  } else {
    throw new Error(`Unexpected messageResource.get() response: ${Object.keys(res ?? {})}`)
  }

  // 图片超过 200KB 时自动压缩（CC 的 Read 工具对大图片可能卡住）
  if (type === 'image') {
    try {
      const stat = statSync(destPath)
      if (stat.size > 200 * 1024) {
        const compressedPath = destPath + '.compressed.jpg'
        await execFileAsync('ffmpeg', [
          '-i', destPath,
          '-vf', 'scale=iw*min(1,1280/iw):ih*min(1,1280/ih)',
          '-q:v', '8',
          '-y', compressedPath,
        ], { timeout: 10000 })
        const newStat = statSync(compressedPath)
        if (newStat.size < stat.size) {
          renameSync(compressedPath, destPath)
          console.log(`[media] compressed image: ${stat.size} → ${newStat.size} bytes`)
        } else {
          unlinkSync(compressedPath)
        }
      }
    } catch (err) {
      console.warn('[media] image compression failed, using original:', (err as Error).message?.slice(0, 80))
    }
  }

  return destPath
}
