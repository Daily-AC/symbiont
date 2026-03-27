import { getClient } from '../client.ts'

type TokenType = 'doc' | 'sheet' | 'file' | 'wiki' | 'bitable' | 'docx' | 'folder' | 'mindnote' | 'minutes' | 'slides'
type MemberType = 'email' | 'openid' | 'unionid' | 'openchat' | 'opendepartmentid' | 'userid' | 'groupid' | 'wikispaceid'
type PermType = 'view' | 'edit' | 'full_access'

/**
 * Add a permission member to a document/file.
 */
export async function addMember(
  token: string,
  type: string,
  memberType: string,
  memberId: string,
  perm: string,
  // deno-lint-ignore no-explicit-any
): Promise<{ success: boolean; member: any }> {
  const client = getClient()
  const res = await client.drive.permissionMember.create({
    path: { token },
    params: { type: type as TokenType, need_notification: false },
    data: {
      member_type: memberType as MemberType,
      member_id: memberId,
      perm: perm as PermType,
    },
  })
  if (res.code !== 0) throw new Error(res.msg)
  return { success: true, member: res.data?.member }
}

/**
 * Remove a permission member from a document/file.
 */
export async function removeMember(
  token: string,
  type: string,
  memberType: string,
  memberId: string,
): Promise<{ success: boolean }> {
  const client = getClient()
  const res = await client.drive.permissionMember.delete({
    path: { token, member_id: memberId },
    params: { type: type as TokenType, member_type: memberType as MemberType },
  })
  if (res.code !== 0) throw new Error(res.msg)
  return { success: true }
}
