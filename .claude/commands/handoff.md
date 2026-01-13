# /handoff - Signal PR Ready for QA

Signal that a PR is ready for QA verification. Posts a structured handoff comment and updates labels via Crane Relay.

## Usage

```
/handoff <issue_number>
```

## Execution Steps

### 1. Detect Repository

```bash
# Get repo from git remote
REPO=$(git remote get-url origin | sed -E 's/.*github\.com[:\/]([^\/]+\/[^\/]+)(\.git)?$/\1/')
echo "Repository: $REPO"
```

### 2. Gather Context

```bash
# Get current branch
BRANCH=$(git branch --show-current)

# Find linked PR
PR_NUMBER=$(gh pr list --head "$BRANCH" --json number --jq '.[0].number')

# Get latest commit SHA
COMMIT_SHA=$(git rev-parse --short HEAD)

# Get CI status
CI_STATUS=$(gh pr checks "$PR_NUMBER" --json state --jq '.[].state' | sort -u | grep -q "FAILURE" && echo "❌ Failing" || echo "✅ Passing")
```

### 3. Construct Preview URL

```bash
# Try to get from PR comments first, otherwise construct from Vercel pattern
PREVIEW_URL=$(gh pr view "$PR_NUMBER" --json comments --jq '.comments[].body' | grep -oE 'https://[a-z0-9-]+\.vercel\.app' | head -1)

if [ -z "$PREVIEW_URL" ]; then
  # Construct from branch name (Vercel pattern)
  SAFE_BRANCH=$(echo "$BRANCH" | tr '/' '-' | tr '_' '-')
  PROJECT_NAME=$(basename "$REPO")
  PREVIEW_URL="https://${PROJECT_NAME}-git-${SAFE_BRANCH}-*.vercel.app"
fi
```

### 4. Validate Prerequisites

- PR must exist and be open
- CI should be passing (warn if not, don't block)

If no PR found:
```
❌ No PR found for branch '$BRANCH'
   Create a PR first: gh pr create
```

### 5. Post Handoff Comment

```bash
RELAY_URL="https://crane-relay.automation-ab6.workers.dev"
RELAY_TOKEN="056b6f9859f5f315c704e9cebfd1bc88f3e1c0a74b904460a2de96ec9bceac2f"

curl -s -X POST "$RELAY_URL/comment" \
  -H "Authorization: Bearer $RELAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "'"$REPO"'",
    "issue": '"$ISSUE_NUMBER"',
    "body": "## 🚀 Handoff: Ready for QA\n\n| Item | Value |\n|------|-------|\n| PR | #'"$PR_NUMBER"' |\n| Preview | '"$PREVIEW_URL"' |\n| Commit | `'"$COMMIT_SHA"'` |\n| CI | '"$CI_STATUS"' |\n\nAll acceptance criteria addressed. Ready for verification."
  }'
```

### 6. Update Labels

```bash
curl -s -X POST "$RELAY_URL/labels" \
  -H "Authorization: Bearer $RELAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "'"$REPO"'",
    "issue": '"$ISSUE_NUMBER"',
    "add": ["status:qa", "needs:qa"],
    "remove": ["status:in-progress"]
  }'
```

### 7. Report Success

```
✅ Handoff complete for #<issue_number>
   Repository: <repo>
   Labels: status:qa, needs:qa
   Comment posted with PR #<pr_number>, commit <commit_sha>
   → https://github.com/<repo>/issues/<issue_number>
```

## Error Handling

| Error | Response |
|-------|----------|
| No git remote | "Not a git repository or no remote configured" |
| No PR found | "No PR found for branch. Create one first: gh pr create" |
| Relay unreachable | "Relay unavailable. Manual update needed: [instructions]" |
| Issue not found | "Issue #X not found in repository" |

## Environment

| Variable | Source | Purpose |
|----------|--------|---------|
| RELAY_TOKEN | Hardcoded | Crane Relay authentication |
| REPO | Auto-detected | Target GitHub repository |

## Notes

- Auto-detects repository from git remote (no manual configuration needed)
- Works with any repository that Crane Relay has access to
- Posts comment even if preview URL can't be determined (with warning)
- CI status is informational only — doesn't block handoff
