// GitHub connector for releases (architecture.md §7.9, Appendix K). The platform — never an agent —
// opens the release pull request and merges it, pinned to the exact commit the CEO approved.
// GitHub branch protection and required checks still apply on the customer's repository.

export interface PullRequest { number: number; html_url: string; head: { sha: string; ref: string }; state: string; merged?: boolean }

export class GitHubError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export class GitHubApi {
  constructor(private readonly repo: string, private readonly token: string, private readonly base = 'https://api.github.com') {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}/repos/${this.repo}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json', 'user-agent': 'the-ai-company' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new GitHubError(`GitHub ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`, res.status);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Reconciliation by natural key: an open PR from this head branch. */
  async findOpenPullRequest(head: string): Promise<PullRequest | null> {
    const owner = this.repo.split('/')[0];
    const prs = await this.req<PullRequest[]>('GET', `/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`);
    return prs[0] ?? null;
  }

  /** Idempotent: returns the existing open PR for this head instead of creating a duplicate. */
  async ensurePullRequest(head: string, baseBranch: string, title: string, body: string): Promise<PullRequest> {
    const existing = await this.findOpenPullRequest(head);
    if (existing) return existing;
    try {
      return await this.req<PullRequest>('POST', '/pulls', { head, base: baseBranch, title, body });
    } catch (e) {
      // A concurrent attempt may have created it between our check and create (422): reconcile.
      if (e instanceof GitHubError && e.status === 422) { const again = await this.findOpenPullRequest(head); if (again) return again; }
      throw e;
    }
  }

  /** Merge only if the PR head is still exactly the approved commit (GitHub enforces `sha`). */
  async mergePinned(number: number, approvedSha: string, title: string): Promise<{ sha: string; merged: boolean }> {
    return this.req<{ sha: string; merged: boolean }>('PUT', `/pulls/${number}/merge`, { sha: approvedSha, merge_method: 'merge', commit_title: title });
  }

  async getPullRequest(number: number): Promise<PullRequest> { return this.req<PullRequest>('GET', `/pulls/${number}`); }
}
