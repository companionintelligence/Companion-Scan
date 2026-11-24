/**
 * Who is calling a world route, and what they may do there. main.ts's `/worlds/:slug/...` handlers and
 * `GET /projects/:id/world` ask this; it lives apart from main.ts because main.ts serves at import and a test cannot
 * import it.
 *
 * ## Two credentials, two places each
 *
 * A world is opened by a **member token** of that world (owner, editor, commenter, viewer, scanner: the share links).
 * A person signed in with a Companion Account carries a **Companion session** instead (server/portal_auth.ts). Either
 * can arrive as `?token=` (media and WebSocket URLs cannot carry a header) or as `Authorization: Bearer`: a signed-in
 * shell adds its session as Bearer to every request (src/shared/shell-sign-in.ts). So both places are read, and each
 * value is asked whether it is a member token of this world, then whether it is a valid session (F-05). A session is
 * never "an invalid world token": it reads as a request with no member token, so the open reads stay open to it and a
 * strict install still asks it for the world's token to write. The one place a session counts for more is the jobs
 * that send data off the box or delete it (`OFF_BOX_OR_DELETING`, server/world/job_request.ts).
 *
 * ## Roles
 *
 * `ROLE_RANK` orders them. A route names the lowest role it accepts. With strict world auth off (the tailnet appliance
 * default) a request with no member token passes every gate, as it always has, and acts as an editor, which is the
 * role the editor opened without a token has always had. It is never an owner: `shareableRoles` gives it the links at
 * or below editor (F-02).
 */
import type { MemberRole, WorldMember, WorldProject } from '../../src/world/types.ts'

export const ROLE_RANK: Record<MemberRole, number> = {
  scanner: 0,
  viewer: 1,
  commenter: 2,
  editor: 3,
  owner: 4,
}

/** Every role, lowest first. The order share links are listed in is the caller's business. */
const ROLES_LOW_TO_HIGH = (Object.keys(ROLE_RANK) as MemberRole[]).sort((a, b) => ROLE_RANK[a] - ROLE_RANK[b])

/** The role a request with no member token acts as on an install without strict world auth. */
export const OPEN_INSTALL_ROLE: MemberRole = 'editor'

/**
 * The credentials a world request carries, `?token=` first, then the Bearer header. Empty values are dropped and a
 * value sent twice is asked once.
 */
export function worldRequestTokens(queryToken: string | undefined | null, authorization: string | undefined | null): string[] {
  const tokens: string[] = []
  if (queryToken) tokens.push(queryToken)
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (bearer && !tokens.includes(bearer)) tokens.push(bearer)
  return tokens
}

/** The member a token names, if it is one of this world's and is neither revoked nor expired. */
export function activeMemberForToken(world: WorldProject, token: string | null | undefined, now = Date.now()): WorldMember | null {
  if (!token) return null
  return world.members.find((member) => {
    if (member.token !== token || member.revokedAt) return false
    if (member.expiresAt && Date.parse(member.expiresAt) <= now) return false
    return true
  }) ?? null
}

/** Who is calling one world. */
export interface WorldCaller {
  /** The member a token named, or null. */
  member: WorldMember | null
  /** A credential was a valid Companion session (signed in, allowlisted). */
  session: boolean
  /** A credential was presented that is neither a member token of this world nor a valid session. */
  invalid: boolean
}

/**
 * Asks each credential, in order, whether it is a member token of `world`; the first that is wins. A credential that is
 * not one is asked `isSession`. The answer is `invalid` only when something was presented and none of it was either.
 */
export async function worldCallerFor(
  world: WorldProject,
  tokens: readonly string[],
  isSession: (token: string) => Promise<boolean>,
  now = Date.now(),
): Promise<WorldCaller> {
  for (const token of tokens) {
    const member = activeMemberForToken(world, token, now)
    if (member) return { member, session: false, invalid: false }
  }
  let session = false
  for (const token of tokens) {
    if (await isSession(token).catch(() => false)) {
      session = true
      break
    }
  }
  return { member: null, session, invalid: tokens.length > 0 && !session }
}

/** A refusal a route sends as it is. */
export interface WorldDenial {
  status: 401 | 403
  body: Record<string, unknown>
}

/**
 * Whether `caller` may use a route that accepts `minimumRole` and up. `allowAnonymous` is the open read some routes
 * offer on every install; `strict` is whether world writes need the world's token (server/wp-a-auth.ts).
 */
export function worldRoleDenial(
  caller: WorldCaller,
  minimumRole: MemberRole,
  opts: { allowAnonymous?: boolean; strict: boolean },
): WorldDenial | null {
  if (caller.invalid) return { status: 403, body: { error: 'Invalid or expired world token' } }
  const member = caller.member
  if (!member) {
    if (opts.allowAnonymous || !opts.strict) return null
    return { status: 401, body: { error: `A ${minimumRole} token is required` } }
  }
  if (ROLE_RANK[member.role] < ROLE_RANK[minimumRole]) {
    return { status: 403, body: { error: `${minimumRole} capability required`, role: member.role } }
  }
  return null
}

/**
 * The role a caller acts as: its member's, or, with no member token, the open install's editor (and nothing on a strict
 * install, where such a caller is not let in to anything that needs a role).
 */
export function effectiveRole(caller: WorldCaller, strict: boolean): MemberRole | null {
  if (caller.member) return caller.member.role
  return strict ? null : OPEN_INSTALL_ROLE
}

/** The roles whose share links a caller may be given: its own and every one below it. Only an owner gets the owner link. */
export function shareableRoles(caller: WorldCaller, strict: boolean): MemberRole[] {
  const role = effectiveRole(caller, strict)
  if (!role) return []
  return ROLES_LOW_TO_HIGH.filter((candidate) => ROLE_RANK[candidate] <= ROLE_RANK[role])
}

/**
 * A copy of the world for this caller: the other members' tokens are blanked unless the caller is the owner. The
 * caller's own token stays, so the editor can keep using it.
 */
export function redactWorldForCaller(world: WorldProject, caller: WorldCaller): WorldProject {
  const member = caller.member
  const canSeeTokens = member?.role === 'owner'
  return {
    ...world,
    members: world.members.map((item) => ({
      ...item,
      token: canSeeTokens || item.memberId === member?.memberId ? item.token : '',
    })),
  }
}
