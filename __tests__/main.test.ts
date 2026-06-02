/**
 * Unit tests for the action's main functionality, src/main.ts
 *
 * To mock dependencies in ESM, you can create fixtures that export mock
 * functions and objects. For example, the core module is mocked in this test,
 * so that the actual '@actions/core' module is not imported.
 */
import { jest } from '@jest/globals'
import * as core from '../__fixtures__/core.js'
import * as gh from '../__fixtures__/github.js'

// Mocks should be declared before the module being tested is imported.
jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('@actions/github', () => gh)

// The module being tested should be imported dynamically. This ensures that the
// mocks are used in place of any actual dependencies.
const { run } = await import('../src/main.js')

/** Build a base64-encoded CODEOWNERS content string. */
function b64(content: string): string {
  return Buffer.from(content).toString('base64')
}

const BASE_CODEOWNERS = '*.ts @org/frontend\n* @org/default\n'

describe('main.ts', () => {
  beforeEach(() => {
    jest.resetAllMocks()

    // Default inputs
    core.getInput.mockImplementation((name: string) => {
      switch (name) {
        case 'github-token':
          return 'fake-token'
        case 'codeowners-path':
          return '.github/CODEOWNERS'
        case 'ignore-filepaths':
          return ''
        case 'ignore-authors':
          return ''
        default:
          return ''
      }
    })

    // Default PR context
    gh.context.payload = {
      pull_request: {
        number: 42,
        user: { login: 'alice' },
        head: { sha: 'deadbeef' }
      }
    }
    gh.context.repo = { owner: 'myorg', repo: 'myrepo' }
  })

  it('skips check when not a pull_request event', async () => {
    gh.context.payload = {}
    gh.getOctokit.mockReturnValue(gh.buildMockOctokit())

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('Not a pull request')
    )
  })

  it('skips check when there are no approvals', async () => {
    gh.getOctokit.mockReturnValue(
      gh.buildMockOctokit({
        listReviews: jest
          .fn<() => Promise<unknown>>()
          .mockResolvedValue({ data: [] })
      })
    )

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('No approvals found')
    )
  })

  it('skips check when author is in ignore-authors', async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === 'github-token') return 'fake-token'
      if (name === 'ignore-authors') return 'alice'
      return ''
    })

    gh.getOctokit.mockReturnValue(
      gh.buildMockOctokit({
        listReviews: jest.fn<() => Promise<unknown>>().mockResolvedValue({
          data: [{ user: { login: 'bob' }, state: 'APPROVED' }]
        })
      })
    )

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('ignore-authors')
    )
  })

  it('skips check when all changed files are ignored', async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === 'github-token') return 'fake-token'
      if (name === 'ignore-filepaths') return 'dist/**'
      return ''
    })

    gh.getOctokit.mockReturnValue(
      gh.buildMockOctokit({
        listReviews: jest.fn<() => Promise<unknown>>().mockResolvedValue({
          data: [{ user: { login: 'bob' }, state: 'APPROVED' }]
        }),
        listFiles: jest.fn<() => Promise<unknown>>().mockResolvedValue({
          data: [{ filename: 'dist/bundle.js' }]
        })
      })
    )

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('ignore-filepaths')
    )
  })

  it('skips check when CODEOWNERS file is not found', async () => {
    gh.getOctokit.mockReturnValue(
      gh.buildMockOctokit({
        listReviews: jest.fn<() => Promise<unknown>>().mockResolvedValue({
          data: [{ user: { login: 'bob' }, state: 'APPROVED' }]
        }),
        listFiles: jest.fn<() => Promise<unknown>>().mockResolvedValue({
          data: [{ filename: 'src/foo.ts' }]
        }),
        getContent: jest
          .fn<() => Promise<unknown>>()
          .mockRejectedValue(new Error('Not Found'))
      })
    )

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('CODEOWNERS file not found')
    )
  })

  it('passes when approver satisfies CODEOWNERS requirement', async () => {
    gh.getOctokit.mockReturnValue(
      gh.buildMockOctokit({
        listReviews: jest.fn<() => Promise<unknown>>().mockResolvedValue({
          data: [{ user: { login: 'frontend-dev' }, state: 'APPROVED' }]
        }),
        listFiles: jest.fn<() => Promise<unknown>>().mockResolvedValue({
          data: [{ filename: 'src/app.ts' }]
        }),
        getContent: jest.fn<() => Promise<unknown>>().mockResolvedValue({
          data: { content: b64('*.ts @frontend-dev\n'), encoding: 'base64' }
        })
      })
    )

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('CODEOWNERS check passed')
    )
  })

  it('fails when no participant satisfies CODEOWNERS requirement', async () => {
    gh.getOctokit.mockReturnValue(
      gh.buildMockOctokit({
        listReviews: jest.fn<() => Promise<unknown>>().mockResolvedValue({
          data: [{ user: { login: 'bob' }, state: 'APPROVED' }]
        }),
        listFiles: jest.fn<() => Promise<unknown>>().mockResolvedValue({
          data: [{ filename: 'src/app.ts' }]
        }),
        getContent: jest.fn<() => Promise<unknown>>().mockResolvedValue({
          data: {
            content: b64(BASE_CODEOWNERS),
            encoding: 'base64'
          }
        })
      })
    )

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('src/app.ts')
    )
  })

  it('passes when the PR author is themselves an owner', async () => {
    // alice is the PR author (set in beforeEach) and also the owner
    gh.getOctokit.mockReturnValue(
      gh.buildMockOctokit({
        listReviews: jest.fn<() => Promise<unknown>>().mockResolvedValue({
          data: [{ user: { login: 'bob' }, state: 'APPROVED' }]
        }),
        listFiles: jest.fn<() => Promise<unknown>>().mockResolvedValue({
          data: [{ filename: 'src/app.ts' }]
        }),
        getContent: jest.fn<() => Promise<unknown>>().mockResolvedValue({
          data: {
            content: b64('*.ts @alice\n'),
            encoding: 'base64'
          }
        })
      })
    )

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('handles a setFailed error from the GitHub client', async () => {
    gh.getOctokit.mockImplementation(() => {
      throw new Error('Bad credentials')
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith('Bad credentials')
  })
})
