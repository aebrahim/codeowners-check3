import * as core from '@actions/core'
import * as github from '@actions/github'
import { parseCodeowners, getOwnersForFile } from './codeowners.js'

/**
 * Splits a comma-or-newline-separated input string into a trimmed list of
 * non-empty tokens.
 */
function splitInput(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Returns true when `filePath` matches any of the provided ignore patterns.
 */
async function isIgnored(
  filePath: string,
  ignorePatterns: string[]
): Promise<boolean> {
  if (ignorePatterns.length === 0) return false
  const { minimatch } = await import('minimatch')
  return ignorePatterns.some((pat) =>
    minimatch(filePath, pat, { dot: true, matchBase: true })
  )
}

/**
 * The main function for the action.
 *
 * @returns Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const token = core.getInput('github-token', { required: true })
    const codeownersPath =
      core.getInput('codeowners-path') || '.github/CODEOWNERS'
    const ignoreFilepaths = splitInput(core.getInput('ignore-filepaths'))
    const ignoreAuthors = splitInput(core.getInput('ignore-authors'))

    const octokit = github.getOctokit(token)
    const { context } = github

    if (!context.payload.pull_request) {
      core.info('Not a pull request event — skipping CODEOWNERS check.')
      return
    }

    const prNumber = context.payload.pull_request.number
    const owner = context.repo.owner
    const repo = context.repo.repo
    const prAuthor: string = context.payload.pull_request.user.login
    const headSha: string = context.payload.pull_request.head.sha

    core.info(`PR #${prNumber} — author: ${prAuthor}, head SHA: ${headSha}`)

    // 1. Read current PR approvals — exit success if none exist
    const reviews = await octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100
    })

    // Build set of users who have an APPROVED review (most-recent per user)
    const latestReviewByUser = new Map<string, string>()
    for (const review of reviews.data) {
      if (review.user?.login) {
        latestReviewByUser.set(review.user.login, review.state)
      }
    }
    const approvers = new Set<string>(
      [...latestReviewByUser.entries()]
        .filter(([, state]) => state === 'APPROVED')
        .map(([login]) => login)
    )

    if (approvers.size === 0) {
      core.info('No approvals found — skipping CODEOWNERS check.')
      return
    }

    core.info(`Approvers: ${[...approvers].join(', ')}`)

    // 2. Exit success if the PR author is in ignore-authors
    if (ignoreAuthors.includes(prAuthor)) {
      core.info(`Author "${prAuthor}" is in ignore-authors — skipping check.`)
      return
    }

    // 3. Read changed files; exit success if all are in ignore-filepaths
    const filesResponse = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100
    })
    const changedFiles = filesResponse.data.map((f) => f.filename)
    core.info(`Changed files: ${changedFiles.join(', ')}`)

    const relevantFiles: string[] = []
    for (const file of changedFiles) {
      if (!(await isIgnored(file, ignoreFilepaths))) {
        relevantFiles.push(file)
      }
    }

    if (relevantFiles.length === 0) {
      core.info('All changed files are in ignore-filepaths — skipping check.')
      return
    }

    // 4. Read CODEOWNERS from the PR head SHA
    let codeownersContent: string
    try {
      const response = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: codeownersPath,
        ref: headSha
      })
      const data = response.data as { content?: string; encoding?: string }
      if (!data.content) {
        core.info('CODEOWNERS file is empty — skipping check.')
        return
      }
      codeownersContent = Buffer.from(data.content, 'base64').toString('utf8')
    } catch {
      core.info(
        `CODEOWNERS file not found at "${codeownersPath}" — skipping check.`
      )
      return
    }

    const entries = parseCodeowners(codeownersContent)
    core.debug(`Parsed ${entries.length} CODEOWNERS entries.`)

    // 5. Evaluate each relevant file against CODEOWNERS
    const participants = new Set<string>([prAuthor, ...approvers])
    const failures: { file: string; requiredOwners: string[] }[] = []
    // Cache team membership lookups so the same team is only fetched once
    const teamMembersCache = new Map<string, Set<string> | null>()

    const getTeamMembers = async (
      teamOrg: string,
      teamSlug: string
    ): Promise<Set<string> | null> => {
      const cacheKey = `${teamOrg}/${teamSlug}`
      if (teamMembersCache.has(cacheKey)) {
        return teamMembersCache.get(cacheKey)!
      }
      try {
        const membersResp = await octokit.rest.teams.listMembersInOrg({
          org: teamOrg,
          team_slug: teamSlug,
          per_page: 100
        })
        const logins = new Set(
          membersResp.data.map((m: { login: string }) => m.login)
        )
        teamMembersCache.set(cacheKey, logins)
        return logins
      } catch (error: unknown) {
        // Team not found or insufficient permissions — treat as not satisfied
        core.error(
          `Could not fetch members for team "${cacheKey}" with error ${error instanceof Error ? error.message : String(error)}`
        )
        teamMembersCache.set(cacheKey, null)
        return null
      }
    }

    for (const file of relevantFiles) {
      const owners = getOwnersForFile(file, entries)
      if (owners.length === 0) {
        // No owners required — file passes
        continue
      }

      // At least one required owner must be a participant
      let satisfied = false
      for (const ownerEntry of owners) {
        const stripped = ownerEntry.startsWith('@')
          ? ownerEntry.slice(1)
          : ownerEntry
        if (stripped.includes('/')) {
          // Team entry: org/team-slug — check if any participant is a team member
          const slashIndex = stripped.indexOf('/')
          const teamOrg = stripped.slice(0, slashIndex)
          const teamSlug = stripped.slice(slashIndex + 1)
          const teamLogins = await getTeamMembers(teamOrg, teamSlug)
          if (teamLogins && [...participants].some((p) => teamLogins.has(p))) {
            satisfied = true
            break
          }
        } else {
          if (participants.has(stripped)) {
            satisfied = true
            break
          }
        }
      }

      if (!satisfied) {
        failures.push({ file, requiredOwners: owners })
      }
    }

    // 6. Fail with per-file owner details when requirements are not met
    if (failures.length > 0) {
      const lines = failures.map(
        ({ file, requiredOwners }) =>
          `  ${file}: requires approval from ${requiredOwners.join(' or ')}`
      )
      core.setFailed(
        `CODEOWNERS check failed. The following files need approval:\n${lines.join('\n')}`
      )
    } else {
      core.info('CODEOWNERS check passed.')
    }
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}
