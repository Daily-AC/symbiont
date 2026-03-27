import { getClient } from '../client.ts'

/**
 * List all accessible wiki spaces.
 */
export async function listSpaces(): Promise<{
  spaces: Array<{
    spaceId: string | undefined
    name: string | undefined
    description: string | undefined
    visibility: string | undefined
  }>
  hint?: string
}> {
  const client = getClient()
  const res = await client.wiki.space.list({})
  if (res.code !== 0) throw new Error(res.msg)

  const spaces = res.data?.items?.map((s) => ({
    spaceId: s.space_id,
    name: s.name,
    description: s.description,
    visibility: s.visibility,
  })) ?? []

  return {
    spaces,
    ...(spaces.length === 0 && {
      hint: 'To grant wiki access: Open wiki space -> Settings -> Members -> Add the bot.',
    }),
  }
}

/**
 * List nodes in a wiki space.
 */
export async function listNodes(
  spaceId: string,
  parentNodeToken?: string,
): Promise<{
  nodes: Array<{
    nodeToken: string | undefined
    objToken: string | undefined
    objType: string | undefined
    title: string | undefined
    hasChild: boolean | undefined
  }>
}> {
  const client = getClient()
  const res = await client.wiki.spaceNode.list({
    path: { space_id: spaceId },
    params: { parent_node_token: parentNodeToken },
  })
  if (res.code !== 0) throw new Error(res.msg)

  return {
    nodes: res.data?.items?.map((n) => ({
      nodeToken: n.node_token,
      objToken: n.obj_token,
      objType: n.obj_type,
      title: n.title,
      hasChild: n.has_child,
    })) ?? [],
  }
}

/**
 * Create a wiki node (defaults to docx type).
 */
export async function createNode(
  spaceId: string,
  title: string,
  parentNodeToken?: string,
): Promise<{
  nodeToken: string | undefined
  objToken: string | undefined
  objType: string | undefined
  title: string | undefined
}> {
  const client = getClient()
  const res = await client.wiki.spaceNode.create({
    path: { space_id: spaceId },
    data: {
      obj_type: 'docx',
      node_type: 'origin' as const,
      title,
      parent_node_token: parentNodeToken,
    },
  })
  if (res.code !== 0) throw new Error(res.msg)

  const node = res.data?.node
  return {
    nodeToken: node?.node_token,
    objToken: node?.obj_token,
    objType: node?.obj_type,
    title: node?.title,
  }
}

/**
 * Move a wiki node to a new parent.
 */
export async function moveNode(
  spaceId: string,
  nodeToken: string,
  targetParentToken: string,
): Promise<{ success: boolean; nodeToken: string | undefined }> {
  const client = getClient()
  const res = await client.wiki.spaceNode.move({
    path: { space_id: spaceId, node_token: nodeToken },
    data: {
      target_space_id: spaceId,
      target_parent_token: targetParentToken,
    },
  })
  if (res.code !== 0) throw new Error(res.msg)
  return { success: true, nodeToken: res.data?.node?.node_token }
}

/**
 * Rename a wiki node.
 */
export async function renameNode(
  spaceId: string,
  nodeToken: string,
  title: string,
): Promise<{ success: boolean; nodeToken: string; title: string }> {
  const client = getClient()
  const res = await client.wiki.spaceNode.updateTitle({
    path: { space_id: spaceId, node_token: nodeToken },
    data: { title },
  })
  if (res.code !== 0) throw new Error(res.msg)
  return { success: true, nodeToken, title }
}
