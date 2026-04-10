/**
 * Collects CI environment metadata for evidence records.
 *
 * Detects the CI provider and extracts author identity, repository info,
 * and commit SHAs from well-known environment variables.
 */

export interface CiMetadata {
  ci_provider: string;
  repository_identifier: string;
  author_identity: {
    provider: string;
    id: string;
    email: string;
    display_name: string;
  };
  commit_sha: string;
  base_commit_sha: string;
  diff_files: string[];
  diff_size_bytes: number;
}

type CiProviderKey = "github_actions" | "gitlab_ci" | "bitbucket_pipelines" | "jenkins" | "azure_devops" | "unknown";

export function detectCiProvider(): CiProviderKey {
  if (process.env.GITHUB_ACTIONS === "true") return "github_actions";
  if (process.env.GITLAB_CI === "true") return "gitlab_ci";
  if (process.env.BITBUCKET_BUILD_NUMBER) return "bitbucket_pipelines";
  if (process.env.JENKINS_URL) return "jenkins";
  if (process.env.BUILD_BUILDID && process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI) return "azure_devops";
  return "unknown";
}

export function collectCiMetadata(
  changedFiles: string[],
  diffSizeBytes: number,
  baseSha: string,
  headSha: string,
): CiMetadata {
  const provider = detectCiProvider();
  return {
    ci_provider: provider,
    repository_identifier: getRepositoryIdentifier(provider),
    author_identity: getAuthorIdentity(provider),
    commit_sha: headSha || getHeadSha(provider),
    base_commit_sha: baseSha || getBaseSha(provider),
    diff_files: changedFiles,
    diff_size_bytes: diffSizeBytes,
  };
}

function getRepositoryIdentifier(provider: CiProviderKey): string {
  switch (provider) {
    case "github_actions": {
      const repo = process.env.GITHUB_REPOSITORY; // "owner/repo"
      return repo ? `github.com/${repo}` : "unknown";
    }
    case "gitlab_ci": {
      const path = process.env.CI_PROJECT_PATH; // "group/project"
      const server = process.env.CI_SERVER_HOST ?? "gitlab.com";
      return path ? `${server}/${path}` : "unknown";
    }
    case "bitbucket_pipelines": {
      const workspace = process.env.BITBUCKET_WORKSPACE;
      const repo = process.env.BITBUCKET_REPO_SLUG;
      return workspace && repo ? `bitbucket.org/${workspace}/${repo}` : "unknown";
    }
    case "azure_devops": {
      const org = process.env.SYSTEM_TEAMPROJECT;
      const repo = process.env.BUILD_REPOSITORY_NAME;
      return org && repo ? `dev.azure.com/${org}/${repo}` : "unknown";
    }
    default:
      return "unknown";
  }
}

function getAuthorIdentity(provider: CiProviderKey) {
  switch (provider) {
    case "github_actions":
      return {
        provider: "github",
        id: process.env.GITHUB_ACTOR_ID ?? process.env.GITHUB_ACTOR ?? "unknown",
        email: process.env.GITHUB_ACTOR ? `${process.env.GITHUB_ACTOR}@users.noreply.github.com` : "unknown",
        display_name: process.env.GITHUB_ACTOR ?? "unknown",
      };
    case "gitlab_ci":
      return {
        provider: "gitlab",
        id: process.env.GITLAB_USER_ID ?? "unknown",
        email: process.env.GITLAB_USER_EMAIL ?? "unknown",
        display_name: process.env.GITLAB_USER_LOGIN ?? process.env.GITLAB_USER_NAME ?? "unknown",
      };
    case "bitbucket_pipelines":
      return {
        provider: "bitbucket",
        id: process.env.BITBUCKET_STEP_TRIGGERER_UUID ?? "unknown",
        email: "unknown",
        display_name: "unknown",
      };
    case "jenkins":
      return {
        provider: "jenkins",
        id: process.env.BUILD_USER_ID ?? "unknown",
        email: process.env.BUILD_USER_EMAIL ?? "unknown",
        display_name: process.env.BUILD_USER ?? "unknown",
      };
    case "azure_devops":
      return {
        provider: "azure_devops",
        id: process.env.BUILD_REQUESTEDFORID ?? "unknown",
        email: process.env.BUILD_REQUESTEDFOREMAIL ?? "unknown",
        display_name: process.env.BUILD_REQUESTEDFOR ?? "unknown",
      };
    default:
      return { provider: "unknown", id: "unknown", email: "unknown", display_name: "unknown" };
  }
}

function getHeadSha(provider: CiProviderKey): string {
  switch (provider) {
    case "github_actions": return process.env.GITHUB_SHA ?? "unknown";
    case "gitlab_ci": return process.env.CI_COMMIT_SHA ?? "unknown";
    case "bitbucket_pipelines": return process.env.BITBUCKET_COMMIT ?? "unknown";
    case "azure_devops": return process.env.BUILD_SOURCEVERSION ?? "unknown";
    default: return "unknown";
  }
}

function getBaseSha(provider: CiProviderKey): string {
  switch (provider) {
    case "github_actions": return process.env.GITHUB_BASE_REF ?? "unknown";
    case "gitlab_ci": return process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA ?? "unknown";
    default: return "unknown";
  }
}
