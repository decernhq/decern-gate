/**
 * File patterns that require an approved decision (high-impact changes).
 * Path patterns: match via normalized.includes(pattern).
 * Basenames: match via equals or startsWith/endsWith for known variants.
 * Optional extraPatterns from env DECERN_GATE_EXTRA_PATTERNS (comma-separated): path substring or basename.
 */

// ---------------------------------------------------------------------------
// 1) DATABASE / SCHEMA
// ---------------------------------------------------------------------------
const DB_PATH_PATTERNS = [
  "supabase/migrations/",
  "prisma/migrations/",
  "typeorm/migrations/",
  "liquibase/",
  "flyway/",
  "db/migrations/",
  "database/migrations/",
];

const DB_BASENAMES = ["schema.prisma", "liquibase.properties", "flyway.conf"];

// ---------------------------------------------------------------------------
// 2) INFRA / IAC / DEPLOY
// ---------------------------------------------------------------------------
const INFRA_PATH_PATTERNS = [
  "terraform/",
  "pulumi/",
  "cdk/",
  "helm/",
  "charts/",
  "k8s/",
  "kubernetes/",
  "manifests/",
  "ansible/",
  "packer/",
];

const INFRA_BASENAMES = [
  "docker-compose.yml",
  "kustomization.yaml",
  "skaffold.yaml",
  "Tiltfile",
  "tiltfile",
  "values.yaml",
  ".dockerignore",
  "compose.yaml",
  "compose.yml",
];

// ---------------------------------------------------------------------------
// 3) CI / CD
// ---------------------------------------------------------------------------
const CI_PATH_PATTERNS = [".github/workflows/", ".github/actions/", ".circleci/", ".buildkite/"];

const CI_BASENAMES = [
  ".gitlab-ci.yml",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
];

// ---------------------------------------------------------------------------
// 4) DEPENDENCIES / BUILD SYSTEM
// ---------------------------------------------------------------------------
const DEPS_BASENAMES = [
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "requirements.txt",
  "pyproject.toml",
  "poetry.lock",
  "Pipfile",
  "Pipfile.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "gradle.properties",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "Gemfile",
  "Gemfile.lock",
  "composer.json",
  "composer.lock",
  "packages.config",
  "CMakeLists.txt",
  "Makefile",
  "vcpkg.json",
  "renovate.json",
  "renovate.json5",
  "turbo.json",
  "nx.json",
  "pnpm-workspace.yaml",
  "settings.gradle.kts",
];

// ---------------------------------------------------------------------------
// 5) AUTH / SECURITY / ACCESS
// ---------------------------------------------------------------------------
const SECURITY_PATH_PATTERNS = [
  "auth/",
  "authentication/",
  "authorization/",
  "iam/",
  "rbac/",
  "acl/",
  "oauth/",
  "oidc/",
  "saml/",
  "security/",
  "crypto/",
  "opa/",
  "rego/",
];

const SECURITY_BASENAMES = ["CODEOWNERS", ".snyk"];

// ---------------------------------------------------------------------------
// 6) API CONTRACTS / INTERFACES (path proto/; graphql/ removed to avoid false positives; schema basenames kept)
// ---------------------------------------------------------------------------
const API_PATH_PATTERNS = ["proto/"];

const API_BASENAMES = [
  "openapi.yaml",
  "openapi.yml",
  "openapi.json",
  "swagger.yaml",
  "swagger.yml",
  "swagger.json",
  "asyncapi.yaml",
  "asyncapi.yml",
  "asyncapi.json",
  "schema.graphql",
  "schema.gql",
];

// ---------------------------------------------------------------------------
// 7) RUNTIME CONFIG / ENV (specific basenames only; appsettings*.json covered by basename rule)
// ---------------------------------------------------------------------------
const CONFIG_BASENAMES = [
  "Procfile",
  "nginx.conf",
  "haproxy.cfg",
  "application.yml",
  "application.yaml",
  "application.properties",
];

// ---------------------------------------------------------------------------
// 8) OBSERVABILITY / ALERTING
// ---------------------------------------------------------------------------
const OBSERVABILITY_PATH_PATTERNS = [
  "prometheus/",
  "grafana/",
  "alertmanager/",
  "otel/",
  "opentelemetry/",
];

// ---------------------------------------------------------------------------
// GRADLE WRAPPER
// ---------------------------------------------------------------------------
const GRADLE_PATH_PATTERNS = ["gradle/wrapper/"];

// ---------------------------------------------------------------------------
// COMBINED EXPORTS (readonly arrays for public API)
// ---------------------------------------------------------------------------

export const REQUIRED_PATH_PATTERNS: readonly string[] = [
  ...DB_PATH_PATTERNS,
  ...INFRA_PATH_PATTERNS,
  ...CI_PATH_PATTERNS,
  ...SECURITY_PATH_PATTERNS,
  ...API_PATH_PATTERNS,
  ...OBSERVABILITY_PATH_PATTERNS,
  ...GRADLE_PATH_PATTERNS,
];

export const REQUIRED_BASENAMES: readonly string[] = [
  ...DB_BASENAMES,
  ...INFRA_BASENAMES,
  ...CI_BASENAMES,
  ...DEPS_BASENAMES,
  ...API_BASENAMES,
  ...CONFIG_BASENAMES,
  ...SECURITY_BASENAMES,
];

export function pathMatchesRequired(path: string, extraPatterns?: string[]): boolean {
  const normalized = path.replace(/\\/g, "/");
  const basename = normalized.split("/").pop() ?? normalized;

  if (extraPatterns && extraPatterns.length > 0) {
    for (const p of extraPatterns) {
      if (p.includes("/")) {
        if (normalized.includes(p)) return true;
      } else if (basename === p) {
        return true;
      }
    }
  }

  for (const p of REQUIRED_PATH_PATTERNS) {
    if (normalized.includes(p)) return true;
  }
  // Dependabot config (exact path or under repo root)
  if (
    normalized === ".github/dependabot.yml" ||
    normalized.endsWith("/.github/dependabot.yml") ||
    normalized === ".github/dependabot.yaml" ||
    normalized.endsWith("/.github/dependabot.yaml")
  )
    return true;

  // Terraform files (any path)
  if (
    basename.endsWith(".tf") ||
    basename.endsWith(".tfvars") ||
    basename.endsWith(".tf.json") ||
    basename === ".terraform.lock.hcl" ||
    basename === ".tflint.hcl"
  )
    return true;

  // Dockerfile variants: Dockerfile, Dockerfile.prod, etc.
  if (basename === "Dockerfile" || basename.startsWith("Dockerfile.")) return true;
  // Jenkinsfile variants: Jenkinsfile, Jenkinsfile.groovy, etc.
  if (basename === "Jenkinsfile" || basename.startsWith("Jenkinsfile.")) return true;
  // docker-compose variants: docker-compose.yml, docker-compose.yaml, docker-compose.*.(yml|yaml)
  if (
    basename === "docker-compose.yml" ||
    basename === "docker-compose.yaml" ||
    (basename.startsWith("docker-compose.") && (basename.endsWith(".yml") || basename.endsWith(".yaml")))
  )
    return true;
  // values-*.yaml
  if (basename.startsWith("values-") && (basename.endsWith(".yaml") || basename.endsWith(".yml"))) return true;
  // requirements-*.txt
  if (basename.startsWith("requirements-") && basename.endsWith(".txt")) return true;
  // .env, .env.local, .env.production, etc.
  if (basename === ".env" || basename.startsWith(".env.")) return true;
  // .NET: *.csproj, *.fsproj, *.sln
  if (basename.endsWith(".csproj") || basename.endsWith(".fsproj") || basename.endsWith(".sln")) return true;
  // conanfile.py, conanfile.txt, etc.
  if (basename.startsWith("conanfile.")) return true;
  // Containerfile variants: Containerfile, Containerfile.prod, etc.
  if (basename === "Containerfile" || basename.startsWith("Containerfile.")) return true;
  // appsettings.json, appsettings.Production.json, etc.
  if (basename.startsWith("appsettings") && basename.endsWith(".json")) return true;
  // tsconfig.json, tsconfig.app.json, etc.
  if (basename === "tsconfig.json" || (basename.startsWith("tsconfig.") && basename.endsWith(".json"))) return true;
  // next.config.(js|mjs|ts|cjs)
  if (basename.startsWith("next.config.") && (basename.endsWith(".js") || basename.endsWith(".mjs") || basename.endsWith(".ts") || basename.endsWith(".cjs"))) return true;
  // vite.config.(js|mjs|ts|cjs)
  if (basename.startsWith("vite.config.") && (basename.endsWith(".js") || basename.endsWith(".mjs") || basename.endsWith(".ts") || basename.endsWith(".cjs"))) return true;
  // webpack.config.(js|mjs|ts|cjs)
  if (basename.startsWith("webpack.config.") && (basename.endsWith(".js") || basename.endsWith(".mjs") || basename.endsWith(".ts") || basename.endsWith(".cjs"))) return true;
  // babel.config.(js|cjs|mjs|json)
  if (basename.startsWith("babel.config.") && (basename.endsWith(".js") || basename.endsWith(".cjs") || basename.endsWith(".mjs") || basename.endsWith(".json"))) return true;

  return REQUIRED_BASENAMES.includes(basename);
}
