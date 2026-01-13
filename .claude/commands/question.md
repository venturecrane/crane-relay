# /question - Ask PM for Clarification

Ask PM for clarification when blocked on requirements. Posts question as comment and adds `needs:pm` label so PM sees it in their filter.

## Usage

```
/question <issue_number> <question text>
```

## Example

```
/question 146 Should buyerImpact be required or optional when analyst confidence is low?
```

## Execution Steps

### 1. Detect Repository

```bash
# Get repo from git remote
REPO=$(git remote get-url origin | sed -E 's/.*github\.com[:\/]([^\/]+\/[^\/]+)(\.git)?$/\1/')
echo "Repository: $REPO"
```

### 2. Parse Input

```bash
# First argument is issue number
ISSUE_NUMBER=$1
shift

# Remaining text is the question
QUESTION_TEXT="$*"

if [ -z "$QUESTION_TEXT" ]; then
  echo "❌ No question provided"
  echo "Usage: /question <issue_number> <question text>"
  exit 1
fi
```

### 3. Post Question Comment

```bash
RELAY_URL="https://crane-relay.automation-ab6.workers.dev"
RELAY_TOKEN="056b6f9859f5f315c704e9cebfd1bc88f3e1c0a74b904460a2de96ec9bceac2f"

curl -s -X POST "$RELAY_URL/comment" \
  -H "Authorization: Bearer $RELAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "'"$REPO"'",
    "issue": '"$ISSUE_NUMBER"',
    "body": "## ❓ Question for PM\n\n'"$QUESTION_TEXT"'\n\n---\n*Dev is blocked pending answer.*"
  }'
```

### 4. Add needs:pm Label

```bash
curl -s -X POST "$RELAY_URL/labels" \
  -H "Authorization: Bearer $RELAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "'"$REPO"'",
    "issue": '"$ISSUE_NUMBER"',
    "add": ["needs:pm"]
  }'
```

### 5. Report Success

```
✅ Question posted to #<issue_number>
   Repository: <repo>
   - needs:pm label added
   - PM will respond in issue comments
   - Continue other work or wait for answer
   → https://github.com/<repo>/issues/<issue_number>
```

## Error Handling

| Error | Response |
|-------|----------|
| No git remote | "Not a git repository or no remote configured" |
| No question text | "No question provided. Usage: /question <issue> <text>" |
| Relay unreachable | "Relay unavailable. Post question manually in GitHub" |
| Issue not found | "Issue #X not found in repository" |

## Notes

- Auto-detects repository from git remote
- Question text can include spaces and punctuation
- PM Team monitors `needs:pm` filter in Command Center
- Dev can continue other work while waiting for answer
