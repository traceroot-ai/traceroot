/** What the code changes section knows about a repository's recent history. */

export interface RepoPull {
  number: number;
  title: string;
  mergedAt: Date;
  /** The commit the merge produced on the default branch. */
  mergeCommitSha: string;
  author: string;
  url: string;
  /** Paths the pull request changed, from the host's metadata. */
  files: string[];
}

export interface RepoRelease {
  tag: string;
  name: string;
  publishedAt: Date;
  commitSha: string;
  url: string;
}

export interface RepoInfo {
  fullName: string;
  defaultBranch: string;
  /** The host's own address for cloning, when it gives one. */
  cloneUrl: string | null;
  /** What the host says the repository weighs, in kilobytes, when it says. */
  sizeKb: number | null;
}

export interface RepoMetadata {
  repo: RepoInfo;
  pulls: RepoPull[];
  releases: RepoRelease[];
}
