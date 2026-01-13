# /merge - Merge Verified PR and Close Issue

Merge PR after QA verification. **Requires `status:verified` label** as safety check.

## Usage

```
/merge <issue_number>
```

## Execution Steps

### 1. Detect Repository

```bash
# Get repo from git remote
REPO=$(git remote get-url origin | sed -E 's/.*github\.com[:\/]([^\/]+\/[^\/]+)(\.git)?$/\1/')
echo "Repository: $REPO"
```

### 2. Find Linked PR

```bash
# Get PR linked to issue
PR_NUMBER=$(gh pr list --search "closes:#$ISSUE_NUMBER" --json number --jq '.[0].number')

# Alternative: get from current branch if in worktree
if [ -z "$PR_NUMBER" ]; then
  BRANCH=$(git branch --show-current)
  PR_NUMBER=$(gh pr list --head "$BRANCH" --json number --jq '.[0].number')
fi

if [ -z "$PR_NUMBER" ]; then
  echo "❌ No PR found linked to issue #$ISSUE_NUMBER"
  exit 1
fi
```

### 3. Validate Prerequisites

```bash
# Get current labels
LABELS=$(gh issue view "$ISSUE_NUMBER" --json labels --jq '.labels[].name')

# Check for status:verified
if ! echo "$LABELS" | grep -q "status:verified"; then
  echo "❌ Cannot merge #$ISSUE_NUMBER"
  echo "   Missing: status:verified label"
  echo "   Current labels: $LABELS"
  echo ""
  echo "   QA must pass before merge."
  exit 1
fi

# Check PR is mergeable
PR_STATE=$(gh pr view "$PR_NUMBER" --json mergeable --jq '.mergeable')
if [ "$PR_STATE" != "MERGEABLE" ]; then
  echo "❌ PR #$PR_NUMBER is not mergeable"
  echo "   State: $PR_STATE"
  echo "   Check for merge conflicts or failing CI"
  exit 1
fi

# Check CI status
CI_FAILING=$(gh pr checks "$PR_NUMBER" --json state --jq '.[].state' | grep -c "FAILURE" || true)
if [ "$CI_FAILING" -gt 0 ]; then
  echo "⚠️  Warning: CI has failing checks"
  echo "   Proceeding anyway (status:verified present)"
fi
```

### 4. Merge PR

```bash
gh pr merge "$PR_NUMBER" --squash --delete-branch
```

### 5. Update Labels

```bash
RELAY_URL="https://crane-relay.automation-ab6.workers.dev"
RELAY_TOKEN="056b6f9859f5f315c704e9cebfd1bc88f3e1c0a74b904460a2de96ec9bceac2f"

curl -s -X POST "$RELAY_URL/labels" \
  -H "Authorization: Bearer $RELAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "'"$REPO"'",
    "issue": '"$ISSUE_NUMBER"',
    "add": ["status:done"],
    "remove": ["status:verified"]
  }'
```

### 6. Close Issue

```bash
curl -s -X POST "$RELAY_URL/close" \
  -H "Authorization: Bearer $RELAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "'"$REPO"'",
    "issue": '"$ISSUE_NUMBER"'
  }'
```

### 7. Report Success

```
✅ Merged and closed #<issue_number>
   Repository: <repo>
   PR #<pr_number> merged to main
   Labels: status:done
   Issue closed
   → https://github.com/<repo>/issues/<issue_number>
```

## Safety Checks

| Check | Required? | Behavior if Fails |
|-------|-----------|-------------------|
| `status:verified` label | **Yes** | Block merge, show error |
| PR exists and is open | Yes | Block merge, show error |
| PR is mergeable | Yes | Block merge, show error |
| CI passing | No (warn) | Warn but proceed |

## Error Handling

| Error | Response |
|-------|----------|
| No `status:verified` | "Missing: status:verified label. QA must pass before merge." |
| PR not found | "No PR found linked to issue #X" |
| Merge conflicts | "PR is not mergeable. Check for conflicts." |
| Branch already deleted | "Branch may have been merged already. Check issue status." |

## Notes

- **Never bypasses `status:verified` check** — this is the safety gate
- Uses squash merge to keep history clean
- Deletes feature branch after merge
- Works with any repository Crane Relay has access to
- CI warnings don't block if `status:verified` is present (PM already verified)
