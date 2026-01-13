/**
 * Crane Relay Worker
 *
 * Enables PM Team to create GitHub issues via HTTP POST.
 * Eliminates copy-paste handoffs between Claude Web and GitHub.
 *
 * Multi-repo support: All endpoints accept an optional `repo` parameter.
 * If not provided, defaults to GITHUB_OWNER/GITHUB_REPO from env.
 */

interface Env {
  // V1 bindings
  GITHUB_TOKEN: string;
  RELAY_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;

  // V2 bindings
  DB: D1Database;
  EVIDENCE_BUCKET: R2Bucket;
  RELAY_SHARED_SECRET: string;
  GH_APP_ID: string;
  GH_INSTALLATION_ID: string;
  GH_PRIVATE_KEY_PEM: string;
  LABEL_RULES_JSON: string;
  GH_API_BASE?: string;
}

interface DirectivePayload {
  to: 'dev' | 'qa' | 'pm';
  title: string;
  labels: string[];
  body: string;
  assignees?: string[];
  repo?: string; // Optional: defaults to GITHUB_OWNER/GITHUB_REPO
}

interface CommentPayload {
  issue: number;
  body: string;
  repo?: string; // Optional: defaults to GITHUB_OWNER/GITHUB_REPO
}

interface ClosePayload {
  issue: number;
  comment?: string;
  repo?: string; // Optional: defaults to GITHUB_OWNER/GITHUB_REPO
}

interface LabelsPayload {
  issue: number;
  add?: string[];
  remove?: string[];
  repo?: string; // Optional: defaults to GITHUB_OWNER/GITHUB_REPO
}

interface GitHubIssueResponse {
  number: number;
  html_url: string;
  title: string;
}

// ============================================================================
// V2 TYPES
// ============================================================================

type Verdict = "PASS" | "FAIL" | "BLOCKED" | "PASS_UNVERIFIED" | "FAIL_UNCONFIRMED";
type Role = "QA" | "DEV" | "PM" | "MENTOR";
type ScopeResult = { id: string; status: "PASS" | "FAIL" | "SKIPPED"; notes?: string };
type RelayEvent = {
  event_id: string;
  repo: string;
  issue_number: number;
  role: Role;
  agent: string;
  event_type: string;
  summary?: string;
  environment?: "preview" | "production" | "dev";
  build?: { pr?: number; commit_sha: string };
  overall_verdict?: Verdict;
  scope_results?: ScopeResult[];
  severity?: "P0" | "P1" | "P2" | "P3";
  repro_steps?: string;
  expected?: string;
  actual?: string;
  evidence_urls?: string[];
  artifacts?: Array<{ type: string; label?: string; href: string }>;
  details?: unknown;
};
type LabelRule = { add?: string[]; remove?: string[] };
type LabelRules = Record<string, Record<string, LabelRule>>;

// ============================================================================
// V2 CONSTANTS
// ============================================================================

const RELAY_STATUS_MARKER = "<!-- RELAY_STATUS v2 -->";

// ============================================================================
// V2 UTILITY FUNCTIONS
// ============================================================================

function v2Json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function badRequest(message: string, details?: unknown) {
  return v2Json({ error: message, details }, 400);
}

function conflict(message: string, details?: unknown) {
  return v2Json({ error: message, details }, 409);
}

function unauthorized() {
  return new Response("Unauthorized", { status: 401 });
}

function nowIso() {
  return new Date().toISOString();
}

function requireAuth(req: Request, env: Env): Response | null {
  const key = req.headers.get("x-relay-key");
  if (!key || key !== env.RELAY_SHARED_SECRET) return unauthorized();
  return null;
}

function isHexSha(s: string) {
  return /^[0-9a-f]{7,40}$/i.test(s);
}

function isRepoSlug(s: string) {
  return /^[^/]+\/[^/]+$/.test(s);
}

function safeInt(x: unknown): number | null {
  const n = typeof x === "string" ? Number(x) : (typeof x === "number" ? x : NaN);
  return Number.isFinite(n) ? n : null;
}

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", enc);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Get default repo from env or use provided repo
 */
function getRepo(env: Env, providedRepo?: string): string {
  if (providedRepo && isRepoSlug(providedRepo)) {
    return providedRepo;
  }
  return `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
}

// CORS configuration (#98)
const ALLOWED_ORIGINS = [
  'https://app.durganfieldguide.com',
  'https://durganfieldguide.com',
  'http://localhost:3000',
];

function getCorsOrigin(request: Request): string {
  const origin = request.headers.get('Origin');
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return origin;
  }
  return ALLOWED_ORIGINS[0];
}

// Store request for CORS in responses
let currentRequest: Request | null = null;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    currentRequest = request;

    // Request-lifecycle cache for GitHub token (V2)
    let ghTokenPromise: Promise<string> | null = null;
    const getGhToken = () => {
      if (!ghTokenPromise) ghTokenPromise = getInstallationToken(env);
      return ghTokenPromise;
    };

    // CORS headers for preflight (#98: restricted origins)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': getCorsOrigin(request),
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Relay-Key',
        },
      });
    }

    // V2 ROUTES (processed before V1 routes)
    if (request.method === "POST" && url.pathname === "/v2/events") {
      try {
        return await handlePostEvents(request, env, getGhToken);
      } catch (err: any) {
        return v2Json({ error: "Internal error", details: String(err?.message || err) }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/v2/evidence") {
      try {
        return await handleEvidenceUpload(request, env);
      } catch (err: any) {
        return v2Json({ error: "Internal error", details: String(err?.message || err) }, 500);
      }
    }

    if (request.method === "GET" && url.pathname.startsWith("/v2/evidence/")) {
      const id = url.pathname.replace("/v2/evidence/", "").trim();
      if (!id) return badRequest("Missing evidence id");
      try {
        return await handleEvidenceGet(request, env, id);
      } catch (err: any) {
        return v2Json({ error: "Internal error", details: String(err?.message || err) }, 500);
      }
    }

    // V1 ROUTE HANDLING (existing endpoints)
    switch (url.pathname) {
      case '/health':
        return handleHealth();

      case '/directive':
        return handleDirective(request, env);

      case '/comment':
        return handleComment(request, env);

      case '/close':
        return handleClose(request, env);

      case '/labels':
        return handleLabels(request, env);

      default:
        return jsonResponse({ error: 'Not found' }, 404);
    }
  },
};

/**
 * Health check endpoint
 */
function handleHealth(): Response {
  return jsonResponse({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
}

/**
 * Create GitHub issue from directive
 */
async function handleDirective(request: Request, env: Env): Promise<Response> {
  // Method check
  if (request.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Method not allowed' }, 405);
  }

  // Auth check
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || authHeader !== `Bearer ${env.RELAY_TOKEN}`) {
    return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
  }

  // Parse payload
  let payload: DirectivePayload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON' }, 400);
  }

  // Validate required fields
  if (!payload.title || !payload.body || !payload.to) {
    return jsonResponse({
      success: false,
      error: 'Missing required fields: title, body, to'
    }, 400);
  }

  // Get repo (with default)
  const repo = getRepo(env, payload.repo);

  // Build issue body with metadata header
  const issueBody = buildIssueBody(payload);

  // Create GitHub issue
  try {
    const issue = await createGitHubIssue(env, repo, {
      title: payload.title,
      body: issueBody,
      labels: payload.labels || [],
      assignees: payload.assignees || [],
    });

    return jsonResponse({
      success: true,
      issue: issue.number,
      url: issue.html_url,
      repo,
    });
  } catch (error) {
    console.error('GitHub API error:', error);
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : 'GitHub API failed',
    }, 500);
  }
}

/**
 * Build issue body with metadata header, planning requirement, and suggested commands (#164, #166)
 */
function buildIssueBody(payload: DirectivePayload): string {
  const header = [
    '<!-- Crane Relay: Auto-generated issue -->',
    `**Routed to:** ${payload.to.toUpperCase()} Team`,
    `**Created:** ${new Date().toISOString()}`,
    '',
    '---',
    '',
  ].join('\n');

  const planningSection = requiresPlanning(payload.labels)
    ? '\n\n---\n\n### Planning Required\n\n⚠️ **This issue requires planning before implementation.**\n\nRun `/project:plan` to create an implementation plan before starting work.\n\n'
    : '';

  const suggestedCommands = getSuggestedCommands(payload.labels);
  const commandsSection = suggestedCommands.length > 0
    ? '\n\n---\n\n### Suggested Commands\n\n' + suggestedCommands.join('\n') + '\n'
    : '';

  return header + payload.body + planningSection + commandsSection;
}

/**
 * Check if issue requires planning based on labels (#166)
 * Planning required if: points >= 3 OR prio:P0
 */
function requiresPlanning(labels: string[]): boolean {
  for (const label of labels) {
    // Check for prio:P0
    if (label === 'prio:P0') {
      return true;
    }

    // Check for points >= 3
    const pointsMatch = label.match(/^points:(\d+)$/);
    if (pointsMatch) {
      const points = parseInt(pointsMatch[1], 10);
      if (points >= 3) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Get suggested commands based on labels (#164)
 */
function getSuggestedCommands(labels: string[]): string[] {
  const commands: string[] = [];

  for (const label of labels) {
    if (label === 'component:dfg-relay') {
      commands.push('```bash\ncd workers/dfg-relay\nnpx wrangler deploy\n```');
    } else if (label === 'component:dfg-api') {
      commands.push('```bash\ncd workers/dfg-api\nnpm run test\nnpx tsc --noEmit\nnpx wrangler deploy\n```');
    } else if (label === 'component:dfg-scout') {
      commands.push('```bash\ncd workers/dfg-scout\nnpm run test\nnpx tsc --noEmit\nnpx wrangler deploy\n```');
    } else if (label === 'component:dfg-analyst') {
      commands.push('```bash\ncd workers/dfg-analyst\nnpm run test\nnpx tsc --noEmit\nnpx wrangler deploy\n```');
    } else if (label === 'component:dfg-app') {
      commands.push('```bash\ncd apps/dfg-app\nnpm run lint\nnpm run type-check\nnpm run build\n```');
    }
  }

  return commands;
}

/**
 * Add comment to existing GitHub issue (#165)
 */
async function handleComment(request: Request, env: Env): Promise<Response> {
  // Method check
  if (request.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Method not allowed' }, 405);
  }

  // Auth check
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || authHeader !== `Bearer ${env.RELAY_TOKEN}`) {
    return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
  }

  // Parse payload
  let payload: CommentPayload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON' }, 400);
  }

  // Validate required fields
  if (!payload.issue || !payload.body) {
    return jsonResponse({
      success: false,
      error: 'Missing required fields: issue, body'
    }, 400);
  }

  // Get repo (with default)
  const repo = getRepo(env, payload.repo);

  // Create GitHub comment
  try {
    await createGitHubComment(env, repo, payload.issue, payload.body);

    return jsonResponse({
      success: true,
      issue: payload.issue,
      repo,
    });
  } catch (error) {
    console.error('GitHub API error:', error);
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : 'GitHub API failed',
    }, 500);
  }
}

/**
 * Close GitHub issue (#168)
 */
async function handleClose(request: Request, env: Env): Promise<Response> {
  // Method check
  if (request.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Method not allowed' }, 405);
  }

  // Auth check
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || authHeader !== `Bearer ${env.RELAY_TOKEN}`) {
    return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
  }

  // Parse payload
  let payload: ClosePayload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON' }, 400);
  }

  // Validate required fields
  if (!payload.issue) {
    return jsonResponse({
      success: false,
      error: 'Missing required field: issue'
    }, 400);
  }

  // Get repo (with default)
  const repo = getRepo(env, payload.repo);

  // Close GitHub issue (with optional comment)
  try {
    // Add comment if provided
    if (payload.comment) {
      await createGitHubComment(env, repo, payload.issue, payload.comment);
    }

    // Close the issue
    await closeGitHubIssue(env, repo, payload.issue);

    return jsonResponse({
      success: true,
      issue: payload.issue,
      repo,
    });
  } catch (error) {
    console.error('GitHub API error:', error);
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : 'GitHub API failed',
    }, 500);
  }
}

/**
 * Update labels on GitHub issue (#179)
 */
async function handleLabels(request: Request, env: Env): Promise<Response> {
  // Method check
  if (request.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Method not allowed' }, 405);
  }

  // Auth check
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || authHeader !== `Bearer ${env.RELAY_TOKEN}`) {
    return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
  }

  // Parse payload
  let payload: LabelsPayload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON' }, 400);
  }

  // Validate required fields
  if (!payload.issue) {
    return jsonResponse({
      success: false,
      error: 'Missing required field: issue'
    }, 400);
  }

  // At least one operation required
  if (!payload.add && !payload.remove) {
    return jsonResponse({
      success: false,
      error: 'Must specify at least one of: add, remove'
    }, 400);
  }

  // Get repo (with default)
  const repo = getRepo(env, payload.repo);

  // Update labels on GitHub issue
  try {
    // Remove labels first (if specified)
    if (payload.remove && payload.remove.length > 0) {
      for (const label of payload.remove) {
        await removeGitHubLabel(env, repo, payload.issue, label);
      }
    }

    // Add labels (if specified)
    if (payload.add && payload.add.length > 0) {
      await addGitHubLabels(env, repo, payload.issue, payload.add);
    }

    // Fetch updated labels
    const labels = await getGitHubLabels(env, repo, payload.issue);

    return jsonResponse({
      success: true,
      issue: payload.issue,
      repo,
      labels,
    });
  } catch (error) {
    console.error('GitHub API error:', error);
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : 'GitHub API failed',
    }, 500);
  }
}

/**
 * Create issue via GitHub REST API
 */
async function createGitHubIssue(
  env: Env,
  repo: string,
  params: {
    title: string;
    body: string;
    labels: string[];
    assignees: string[];
  }
): Promise<GitHubIssueResponse> {
  const url = `https://api.github.com/repos/${repo}/issues`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `token ${env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'crane-relay-worker',
      'Accept': 'application/vnd.github.v3+json',
    },
    body: JSON.stringify({
      title: params.title,
      body: params.body,
      labels: params.labels,
      assignees: params.assignees,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GitHub API ${response.status}: ${errorBody}`);
  }

  return response.json();
}

/**
 * Add comment to GitHub issue via REST API (#165)
 */
async function createGitHubComment(
  env: Env,
  repo: string,
  issueNumber: number,
  body: string
): Promise<void> {
  const url = `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `token ${env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'crane-relay-worker',
      'Accept': 'application/vnd.github.v3+json',
    },
    body: JSON.stringify({ body }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GitHub API ${response.status}: ${errorBody}`);
  }
}

/**
 * Close GitHub issue via REST API (#168)
 */
async function closeGitHubIssue(
  env: Env,
  repo: string,
  issueNumber: number
): Promise<void> {
  const url = `https://api.github.com/repos/${repo}/issues/${issueNumber}`;

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `token ${env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'crane-relay-worker',
      'Accept': 'application/vnd.github.v3+json',
    },
    body: JSON.stringify({ state: 'closed' }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GitHub API ${response.status}: ${errorBody}`);
  }
}

/**
 * Add labels to GitHub issue via REST API (#179)
 */
async function addGitHubLabels(
  env: Env,
  repo: string,
  issueNumber: number,
  labels: string[]
): Promise<void> {
  const url = `https://api.github.com/repos/${repo}/issues/${issueNumber}/labels`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `token ${env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'crane-relay-worker',
      'Accept': 'application/vnd.github.v3+json',
    },
    body: JSON.stringify({ labels }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GitHub API ${response.status}: ${errorBody}`);
  }
}

/**
 * Remove label from GitHub issue via REST API (#179)
 */
async function removeGitHubLabel(
  env: Env,
  repo: string,
  issueNumber: number,
  label: string
): Promise<void> {
  const url = `https://api.github.com/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`;

  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Authorization': `token ${env.GITHUB_TOKEN}`,
      'User-Agent': 'crane-relay-worker',
      'Accept': 'application/vnd.github.v3+json',
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GitHub API ${response.status}: ${errorBody}`);
  }
}

/**
 * Get labels for GitHub issue via REST API (#179)
 */
async function getGitHubLabels(
  env: Env,
  repo: string,
  issueNumber: number
): Promise<string[]> {
  const url = `https://api.github.com/repos/${repo}/issues/${issueNumber}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `token ${env.GITHUB_TOKEN}`,
      'User-Agent': 'crane-relay-worker',
      'Accept': 'application/vnd.github.v3+json',
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GitHub API ${response.status}: ${errorBody}`);
  }

  const issue = await response.json() as { labels: Array<{ name: string }> };
  return issue.labels.map(l => l.name);
}

/**
 * Helper: JSON response with CORS (#98: restricted origins)
 */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': currentRequest ? getCorsOrigin(currentRequest) : ALLOWED_ORIGINS[0],
    },
  });
}
// EVENT VALIDATION
// ============================================================================

function validateEvent(e: any): { ok: true; event: RelayEvent } | { ok: false; message: string } {
  if (!e || typeof e !== "object") return { ok: false, message: "Body must be a JSON object" };

  const event_id = String(e.event_id || "").trim();
  const repo = String(e.repo || "").trim();
  const issue_number = safeInt(e.issue_number);
  const role = String(e.role || "").trim();
  const agent = String(e.agent || "").trim();
  const event_type = String(e.event_type || "").trim();

  if (!event_id || event_id.length < 8) return { ok: false, message: "event_id is required (min length 8)" };
  if (!repo || !isRepoSlug(repo)) return { ok: false, message: "repo must be 'org/repo'" };
  if (!issue_number || issue_number < 1) return { ok: false, message: "issue_number must be a positive integer" };
  if (!["QA", "DEV", "PM", "MENTOR"].includes(role)) return { ok: false, message: "role must be QA|DEV|PM|MENTOR" };
  if (!agent || agent.length < 2) return { ok: false, message: "agent is required" };
  if (!event_type) return { ok: false, message: "event_type is required" };

  let build: RelayEvent["build"] | undefined;
  if (e.build) {
    if (typeof e.build !== "object") return { ok: false, message: "build must be an object" };
    const commit_sha = String(e.build.commit_sha || "").trim().toLowerCase();
    const pr = e.build.pr != null ? safeInt(e.build.pr) : undefined;
    if (!commit_sha || !isHexSha(commit_sha)) return { ok: false, message: "build.commit_sha must be a hex sha (7-40 chars)" };
    build = { commit_sha, ...(pr ? { pr } : {}) };
  }

  const environment = e.environment ? String(e.environment) : undefined;
  if (environment && !["preview", "production", "dev"].includes(environment)) {
    return { ok: false, message: "environment must be preview|production|dev" };
  }

  let overall_verdict: Verdict | undefined = e.overall_verdict;
  if (overall_verdict && !["PASS", "FAIL", "BLOCKED", "PASS_UNVERIFIED", "FAIL_UNCONFIRMED"].includes(overall_verdict)) {
    return { ok: false, message: "overall_verdict invalid" };
  }

  let scope_results: ScopeResult[] | undefined;
  if (e.scope_results != null) {
    if (!Array.isArray(e.scope_results) || e.scope_results.length < 1) {
      return { ok: false, message: "scope_results must be a non-empty array" };
    }
    scope_results = e.scope_results.map((r: any) => ({
      id: String(r.id || "").trim(),
      status: String(r.status || "").trim(),
      notes: r.notes != null ? String(r.notes) : undefined
    })) as any;

    for (const r of scope_results!) {
      if (!r.id) return { ok: false, message: "scope_results[].id is required" };
      if (!["PASS", "FAIL", "SKIPPED"].includes(r.status)) return { ok: false, message: "scope_results[].status must be PASS|FAIL|SKIPPED" };
    }
  }

  // Conditional requirements on FAIL/BLOCKED
  if (overall_verdict === "FAIL" || overall_verdict === "BLOCKED") {
    if (!e.severity || !["P0", "P1", "P2", "P3"].includes(String(e.severity))) {
      return { ok: false, message: "severity is required for FAIL/BLOCKED and must be P0|P1|P2|P3" };
    }
    for (const k of ["repro_steps", "expected", "actual"]) {
      if (!e[k] || String(e[k]).trim().length < 3) {
        return { ok: false, message: `${k} is required for FAIL/BLOCKED (min length 3)` };
      }
    }
  }

  const evidence_urls = e.evidence_urls
    ? (Array.isArray(e.evidence_urls) ? e.evidence_urls.map((u: any) => String(u)) : null)
    : undefined;
  if (evidence_urls === null) return { ok: false, message: "evidence_urls must be an array of strings" };

  const event: RelayEvent = {
    event_id,
    repo,
    issue_number,
    role: role as Role,
    agent,
    event_type,
    summary: e.summary != null ? String(e.summary) : undefined,
    environment: environment as any,
    build,
    overall_verdict,
    scope_results,
    severity: e.severity,
    repro_steps: e.repro_steps,
    expected: e.expected,
    actual: e.actual,
    evidence_urls,
    artifacts: Array.isArray(e.artifacts) ? e.artifacts : undefined,
    details: e.details
  };

  return { ok: true, event };
}

// ============================================================================
// GITHUB APP AUTH (RS256 JWT -> installation token)
// ============================================================================

function b64url(input: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof input === "string") bytes = new TextEncoder().encode(input);
  else bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const clean = pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/g, "")
    .replace(/-----END RSA PRIVATE KEY-----/g, "")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const keyData = pemToArrayBuffer(pem);
  // Try PKCS8 first, fall back to PKCS1
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      keyData,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
  } catch {
    // RSA PRIVATE KEY format (PKCS1) - need to wrap in PKCS8
    // For simplicity, we assume the key works with pkcs8 after stripping headers
    throw new Error("Failed to import private key. Ensure it's in PKCS8 or RSA PRIVATE KEY format.");
  }
}

async function createAppJwt(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 30,
    exp: now + 9 * 60,
    iss: Number(env.GH_APP_ID)
  };

  const encodedHeader = b64url(JSON.stringify(header));
  const encodedPayload = b64url(JSON.stringify(payload));
  const toSign = `${encodedHeader}.${encodedPayload}`;

  const key = await importPrivateKey(env.GH_PRIVATE_KEY_PEM);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(toSign));
  const encodedSig = b64url(sig);

  return `${toSign}.${encodedSig}`;
}

async function githubFetch(env: Env, token: string, method: string, path: string, body?: any) {
  const base = (env.GH_API_BASE || "https://api.github.com").replace(/\/+$/, "");
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "authorization": `Bearer ${token}`,
      "accept": "application/vnd.github+json",
      "user-agent": "crane-relay-v2",
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return res;
}

async function getInstallationToken(env: Env): Promise<string> {
  const appJwt = await createAppJwt(env);
  const res = await githubFetch(env, appJwt, "POST", `/app/installations/${env.GH_INSTALLATION_ID}/access_tokens`);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub installation token error: ${res.status} ${txt}`);
  }
  const data = await res.json() as any;
  return data.token as string;
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split("/");
  return { owner, name };
}

// ============================================================================
// GITHUB OPERATIONS
// ============================================================================

async function getPullRequestHeadSha(env: Env, ghToken: string, repo: string, prNumber: number): Promise<string> {
  const { owner, name } = splitRepo(repo);
  const res = await githubFetch(env, ghToken, "GET", `/repos/${owner}/${name}/pulls/${prNumber}`);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub PR fetch error: ${res.status} ${txt}`);
  }
  const pr = await res.json() as any;
  return String(pr.head?.sha || "").toLowerCase();
}

async function getIssueDetails(env: Env, ghToken: string, repo: string, issueNumber: number) {
  const { owner, name } = splitRepo(repo);
  const res = await githubFetch(env, ghToken, "GET", `/repos/${owner}/${name}/issues/${issueNumber}`);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub issue fetch error: ${res.status} ${txt}`);
  }
  return res.json() as Promise<any>;
}

async function listIssueComments(env: Env, ghToken: string, repo: string, issueNumber: number, page = 1) {
  const { owner, name } = splitRepo(repo);
  const res = await githubFetch(env, ghToken, "GET", `/repos/${owner}/${name}/issues/${issueNumber}/comments?per_page=100&page=${page}`);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub list comments error: ${res.status} ${txt}`);
  }
  return res.json() as Promise<any[]>;
}

async function createIssueComment(env: Env, ghToken: string, repo: string, issueNumber: number, body: string) {
  const { owner, name } = splitRepo(repo);
  const res = await githubFetch(env, ghToken, "POST", `/repos/${owner}/${name}/issues/${issueNumber}/comments`, { body });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub create comment error: ${res.status} ${txt}`);
  }
  return res.json() as Promise<any>;
}

async function updateIssueComment(env: Env, ghToken: string, repo: string, commentId: string, body: string) {
  const { owner, name } = splitRepo(repo);
  const res = await githubFetch(env, ghToken, "PATCH", `/repos/${owner}/${name}/issues/comments/${commentId}`, { body });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub update comment error: ${res.status} ${txt}`);
  }
  return res.json() as Promise<any>;
}

async function putIssueLabels(env: Env, ghToken: string, repo: string, issueNumber: number, labels: string[]) {
  const { owner, name } = splitRepo(repo);
  const res = await githubFetch(env, ghToken, "PUT", `/repos/${owner}/${name}/issues/${issueNumber}/labels`, { labels });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub update labels error: ${res.status} ${txt}`);
  }
  return res.json() as Promise<any>;
}

// ============================================================================
// LABEL TRANSITIONS
// ============================================================================

function parseLabelRules(env: Env): LabelRules | null {
  try {
    const parsed = JSON.parse(env.LABEL_RULES_JSON || "");
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as LabelRules;
  } catch {
    return null;
  }
}

async function applyLabelRules(
  env: Env,
  ghToken: string,
  repo: string,
  issueNumber: number,
  eventType: string,
  verdict: Verdict | undefined
) {
  const rules = parseLabelRules(env);
  if (!rules) return;

  const typeRule = rules[eventType];
  if (!typeRule) return;

  const key = verdict ?? "_";
  const rule = typeRule[key] || typeRule["_"];
  if (!rule) return;

  const add = Array.isArray(rule.add) ? rule.add : [];
  const remove = Array.isArray(rule.remove) ? rule.remove : [];

  const issue = await getIssueDetails(env, ghToken, repo, issueNumber);
  const current = (issue.labels || [])
    .map((l: any) => (typeof l === "string" ? l : l.name))
    .filter(Boolean) as string[];

  const next = new Set<string>(current);
  for (const a of add) next.add(a);
  for (const r of remove) next.delete(r);

  await putIssueLabels(env, ghToken, repo, issueNumber, Array.from(next));
}

// ============================================================================
// ROLLING COMMENT UPSERT
// ============================================================================

async function upsertRollingComment(env: Env, ghToken: string, repo: string, issueNumber: number, body: string): Promise<string> {
  // 1) Try D1 mapping
  const mapped = await env.DB.prepare(
    "SELECT comment_id FROM relay_status_comment WHERE repo = ? AND issue_number = ?"
  ).bind(repo, issueNumber).first<{ comment_id: string }>();

  if (mapped?.comment_id) {
    try {
      await updateIssueComment(env, ghToken, repo, mapped.comment_id, body);
      await env.DB.prepare(
        "UPDATE relay_status_comment SET updated_at = ? WHERE repo = ? AND issue_number = ?"
      ).bind(nowIso(), repo, issueNumber).run();
      return mapped.comment_id;
    } catch {
      // fall through - comment may have been deleted
    }
  }

  // 2) Search GitHub comments for marker (scan up to 3 pages / 300 comments)
  let page = 1;
  let found: any | null = null;
  while (page <= 3 && !found) {
    const comments = await listIssueComments(env, ghToken, repo, issueNumber, page);
    found = comments.find(c => typeof c.body === "string" && c.body.includes(RELAY_STATUS_MARKER)) || null;
    if (comments.length < 100) break;
    page += 1;
  }

  if (found?.id) {
    const commentId = String(found.id);
    await updateIssueComment(env, ghToken, repo, commentId, body);
    await env.DB.prepare(
      "INSERT OR REPLACE INTO relay_status_comment (repo, issue_number, comment_id, updated_at) VALUES (?, ?, ?, ?)"
    ).bind(repo, issueNumber, commentId, nowIso()).run();
    return commentId;
  }

  // 3) Create new comment
  const created = await createIssueComment(env, ghToken, repo, issueNumber, body);
  const commentId = String(created.id);

  await env.DB.prepare(
    "INSERT OR REPLACE INTO relay_status_comment (repo, issue_number, comment_id, updated_at) VALUES (?, ?, ?, ?)"
  ).bind(repo, issueNumber, commentId, nowIso()).run();

  return commentId;
}

// ============================================================================
// ROLLING COMMENT RENDERING
// ============================================================================

function normalizeLabels(issue: any): string[] {
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  return labels.map((l: any) => (typeof l === "string" ? l : l.name)).filter(Boolean);
}

function extractOwner(issue: any): string {
  const assignees = Array.isArray(issue.assignees) ? issue.assignees : [];
  if (assignees.length > 0) return `@${assignees[0].login}`;
  if (issue.assignee?.login) return `@${issue.assignee.login}`;
  return "unassigned";
}

function pickStatus(labels: string[]): string {
  const status = labels.find(l => l.startsWith("status:"));
  return status ? status.replace(/^status:/, "") : "unknown";
}

function formatShortSha(sha?: string | null) {
  if (!sha) return "n/a";
  return `\`${sha.slice(0, 7)}\``;
}

function safeParseEvent(payloadJson: string): RelayEvent | null {
  try {
    const e = JSON.parse(payloadJson);
    return e && typeof e === "object" ? (e as RelayEvent) : null;
  } catch {
    return null;
  }
}

async function getLatestEventByType(env: Env, repo: string, issueNumber: number, eventType: string): Promise<{ created_at: string; payload_json: string } | null> {
  const row = await env.DB.prepare(
    "SELECT created_at, payload_json FROM events WHERE repo = ? AND issue_number = ? AND event_type = ? ORDER BY created_at DESC LIMIT 1"
  ).bind(repo, issueNumber, eventType).first<{ created_at: string; payload_json: string }>();
  return row || null;
}

async function getRecentEvents(env: Env, repo: string, issueNumber: number, limit = 5): Promise<Array<{ created_at: string; event_type: string; agent: string }>> {
  const rows = await env.DB.prepare(
    "SELECT created_at, event_type, agent FROM events WHERE repo = ? AND issue_number = ? ORDER BY created_at DESC LIMIT ?"
  ).bind(repo, issueNumber, limit).all();
  return (rows.results || []) as any[];
}

function renderRelayStatusMarkdown(input: {
  issue: any;
  repo: string;
  issueNumber: number;
  provenance: { pr?: number; commit?: string; verified: boolean | null; prHead?: string | null; environment?: string | null };
  latestDev?: RelayEvent | null;
  latestQa?: RelayEvent | null;
  recent: Array<{ created_at: string; event_type: string; agent: string }>;
}) {
  const labels = normalizeLabels(input.issue);
  const owner = extractOwner(input.issue);
  const status = pickStatus(labels);

  const pr = input.provenance.pr ? `#${input.provenance.pr}` : "n/a";
  const commit = formatShortSha(input.provenance.commit);
  const env = input.provenance.environment || "unknown";

  const prov =
    input.provenance.verified === null ? "n/a" :
    input.provenance.verified ? "VERIFIED (matches PR head)" :
    `UNVERIFIED (PR head: ${formatShortSha(input.provenance.prHead)})`;

  const qaVerdict = input.latestQa?.overall_verdict || "n/a";
  const qaScope = input.latestQa?.scope_results || [];
  const qaEvidence = input.latestQa?.evidence_urls || [];

  const devSummary = input.latestDev?.summary ? input.latestDev.summary : "";

  const scopeLines = qaScope.length
    ? qaScope.map(s => `  - ${s.id} — ${s.status}${s.notes ? ` (${s.notes})` : ""}`).join("\n")
    : "  - n/a";

  const evidenceLines = qaEvidence.length
    ? qaEvidence.map(u => `  - ${u}`).join("\n")
    : "  - n/a";

  const recentLines = input.recent.length
    ? input.recent.map(r => `- ${r.created_at.slice(11, 16)}Z — ${r.event_type} — ${r.agent}`).join("\n")
    : "- n/a";

  return [
    RELAY_STATUS_MARKER,
    "",
    `## Relay Status — ISSUE #${input.issueNumber}`,
    "",
    "### Current State",
    `- Status: \`${status}\``,
    `- Labels: ${labels.length ? labels.map(l => `\`${l}\``).join(", ") : "n/a"}`,
    `- Owner: ${owner}`,
    "",
    "### Build Provenance",
    `- Environment: \`${env}\``,
    `- PR: ${pr}`,
    `- Commit: ${commit}`,
    `- Provenance: ${prov}`,
    "",
    "### Latest Dev Update",
    devSummary ? `- Summary: ${devSummary}` : "- Summary: n/a",
    "",
    "### Latest QA Result",
    `- Verdict: \`${qaVerdict}\``,
    "- Scope:",
    scopeLines,
    "- Evidence:",
    evidenceLines,
    "",
    "### Recent Activity",
    recentLines,
    ""
  ].join("\n");
}

// ============================================================================
// EVIDENCE HANDLERS (Phase 2)
// ============================================================================

async function handleEvidenceUpload(req: Request, env: Env): Promise<Response> {
  const authErr = requireAuth(req, env);
  if (authErr) return authErr;

  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return badRequest("Expected multipart/form-data");
  }

  const url = new URL(req.url);
  const form = await req.formData();

  const repo = String(form.get("repo") || "").trim();
  const issueNumber = safeInt(String(form.get("issue_number") || ""));
  const eventId = String(form.get("event_id") || "").trim() || null;

  const file = form.get("file");
  if (!repo || !isRepoSlug(repo) || !issueNumber) {
    return badRequest("Missing required fields: repo (org/repo), issue_number");
  }
  if (!file || typeof file === 'string') {
    return badRequest("Missing file field (multipart 'file')");
  }

  const id = crypto.randomUUID();
  const createdAt = nowIso();

  const fileBlob = file as File;
  const filename = fileBlob.name || "upload.bin";
  const fileType = fileBlob.type || "application/octet-stream";
  const sizeBytes = fileBlob.size;

  const r2Key = `evidence/${repo}/issue-${issueNumber}/${id}/${filename}`;

  await env.EVIDENCE_BUCKET.put(r2Key, fileBlob.stream(), {
    httpMetadata: { contentType: fileType },
    customMetadata: {
      repo,
      issue_number: String(issueNumber),
      event_id: eventId ?? "",
      uploaded_at: createdAt
    }
  });

  await env.DB.prepare(
    `INSERT INTO evidence_assets
     (id, repo, issue_number, event_id, filename, content_type, size_bytes, r2_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, repo, issueNumber, eventId, filename, fileType, sizeBytes, r2Key, createdAt
  ).run();

  const evidenceUrl = `${url.origin}/v2/evidence/${id}`;

  return v2Json({
    id,
    repo,
    issue_number: issueNumber,
    event_id: eventId,
    filename,
    content_type: fileType,
    size_bytes: sizeBytes,
    url: evidenceUrl
  }, 201);
}

async function handleEvidenceGet(req: Request, env: Env, evidenceId: string): Promise<Response> {
  const authErr = requireAuth(req, env);
  if (authErr) return authErr;

  const row = await env.DB.prepare(
    "SELECT r2_key, filename, content_type FROM evidence_assets WHERE id = ?"
  ).bind(evidenceId).first<{ r2_key: string; filename: string; content_type: string | null }>();

  if (!row) return new Response("Not found", { status: 404 });

  const obj = await env.EVIDENCE_BUCKET.get(row.r2_key);
  if (!obj) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  headers.set("content-type", row.content_type || "application/octet-stream");
  headers.set("content-disposition", `inline; filename="${row.filename.replace(/"/g, "")}"`);
  obj.writeHttpMetadata(headers);

  return new Response(obj.body, { headers });
}

// ============================================================================
// EVENTS HANDLER (Phase 1)
// ============================================================================

async function handlePostEvents(req: Request, env: Env, getGhToken: () => Promise<string>): Promise<Response> {
  const authErr = requireAuth(req, env);
  if (authErr) return authErr;

  let payload: any;
  try { payload = await req.json(); } catch { return badRequest("Invalid JSON body"); }

  const validated = validateEvent(payload);
  if (!validated.ok) return badRequest(validated.message);

  const event = validated.event;

  const payloadJson = JSON.stringify(event);
  const payloadHash = await sha256Hex(payloadJson);

  // Idempotency check
  const existing = await env.DB.prepare(
    "SELECT payload_hash FROM events WHERE event_id = ?"
  ).bind(event.event_id).first<{ payload_hash: string }>();

  if (existing) {
    if (existing.payload_hash !== payloadHash) {
      return conflict("event_id already exists with different payload", {
        event_id: event.event_id,
        existing_hash: existing.payload_hash,
        new_hash: payloadHash
      });
    }
    return v2Json({ ok: true, idempotent: true, event_id: event.event_id });
  }

  const ghToken = await getGhToken();

  // Provenance check
  let provenanceVerified: boolean | null = null;
  let prHeadSha: string | null = null;

  let effectiveVerdict: Verdict | undefined = event.overall_verdict;

  if (event.build?.pr && event.build.commit_sha) {
    prHeadSha = await getPullRequestHeadSha(env, ghToken, event.repo, event.build.pr);
    provenanceVerified = (prHeadSha === event.build.commit_sha.toLowerCase());

    if (!provenanceVerified && effectiveVerdict === "PASS") {
      effectiveVerdict = "PASS_UNVERIFIED";
    }
  }

  // Persist event
  await env.DB.prepare(
    `INSERT INTO events
     (event_id, repo, issue_number, event_type, role, agent, environment, overall_verdict, created_at, payload_hash, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    event.event_id,
    event.repo,
    event.issue_number,
    event.event_type,
    event.role,
    event.agent,
    event.environment ?? null,
    effectiveVerdict ?? null,
    nowIso(),
    payloadHash,
    payloadJson
  ).run();

  // Fetch issue for rendering
  const issue = await getIssueDetails(env, ghToken, event.repo, event.issue_number);

  // Pull latest dev/qa events
  const latestDevRow = await getLatestEventByType(env, event.repo, event.issue_number, "dev.update");
  const latestQaRow = await getLatestEventByType(env, event.repo, event.issue_number, "qa.result_submitted");
  const latestDev = latestDevRow ? safeParseEvent(latestDevRow.payload_json) : null;
  const latestQa = latestQaRow ? safeParseEvent(latestQaRow.payload_json) : null;

  const recent = await getRecentEvents(env, event.repo, event.issue_number, 5);

  const provenance = {
    pr: event.build?.pr,
    commit: event.build?.commit_sha,
    verified: provenanceVerified,
    prHead: prHeadSha,
    environment: event.environment ?? null
  };

  const body = renderRelayStatusMarkdown({
    issue,
    repo: event.repo,
    issueNumber: event.issue_number,
    provenance,
    latestDev,
    latestQa,
    recent
  });

  const commentId = await upsertRollingComment(env, ghToken, event.repo, event.issue_number, body);

  // Apply label transitions
  await applyLabelRules(env, ghToken, event.repo, event.issue_number, event.event_type, effectiveVerdict);

  return v2Json({
    ok: true,
    event_id: event.event_id,
    stored: true,
    rolling_comment_id: commentId,
    verdict: effectiveVerdict,
    provenance_verified: provenanceVerified
  }, 201);
}

// ============================================================================
// EXPORTS (for integration)
// ============================================================================

export {
  handlePostEvents,
  handleEvidenceUpload,
  handleEvidenceGet,
  getInstallationToken,
  requireAuth,
  v2Json,
  badRequest,
  conflict,
  unauthorized
};
