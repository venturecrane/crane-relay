# DFG Relay Worker

**Purpose:** Enable PM Team (Claude Web) to create GitHub issues directly via curl, eliminating copy-paste handoffs.

---

## Architecture

```
PM Team (Claude Web)
        │
        │ curl POST /directive
        ▼
┌─────────────────────────┐
│  dfg-relay Worker       │
│  - Auth validation      │
│  - GitHub API call      │
│  - Response formatting  │
└─────────────────────────┘
        │
        │ GitHub REST API
        ▼
GitHub Issue Created
```

---

## Endpoints

### POST /directive

Creates a GitHub issue from PM directive.

**Request:**
```json
{
  "to": "dev",
  "title": "PRE-006: CI Gating",
  "labels": ["needs:dev", "prio:P0", "sprint:n+1", "type:tech-debt"],
  "body": "## Directive\n\nFull markdown content..."
}
```

**Response (success):**
```json
{
  "success": true,
  "issue": 11,
  "url": "https://github.com/durganfieldguide/dfg-console/issues/11"
}
```

**Response (error):**
```json
{
  "success": false,
  "error": "Unauthorized"
}
```

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-01-02T12:00:00Z"
}
```

---

## Setup

### 1. Create Worker

```bash
cd workers
mkdir dfg-relay
cd dfg-relay
npm init -y
```

### 2. Configure wrangler.toml

See `wrangler.toml` in this package.

### 3. Set Secrets

```bash
# GitHub Personal Access Token (needs repo scope)
wrangler secret put GITHUB_TOKEN

# Shared secret for relay auth (generate random string)
wrangler secret put RELAY_TOKEN
```

### 4. Deploy

```bash
wrangler deploy
```

### 5. Provide URL to PM Team

After deploy, provide Captain with:
- Worker URL: `https://dfg-relay.<your-subdomain>.workers.dev`
- RELAY_TOKEN value (for PM Team to use in auth header)

---

## Security

- **RELAY_TOKEN:** Prevents unauthorized issue creation
- **GITHUB_TOKEN:** Never exposed to client, stays in Worker secrets
- **No sensitive data in issues:** Directives are work instructions only

---

## Files in This Package

| File | Purpose |
|------|---------|
| README.md | This file |
| wrangler.toml | Worker configuration |
| src/index.ts | Worker implementation |
| package.json | Dependencies |
| tsconfig.json | TypeScript config |
