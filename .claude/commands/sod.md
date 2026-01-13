# /sod - Start of Day Orientation

Orient Dev Team at session start. Reads handoff, checks GitHub for ready work, summarizes state, shows available commands.

## Usage

```
/sod
```

## Execution Steps

### 1. Detect Repository and Context

```bash
# Get repo from git remote
REPO=$(git remote get-url origin | sed -E 's/.*github\.com[:\/]([^\/]+\/[^\/]+)(\.git)?$/\1/')
ORG=$(echo "$REPO" | cut -d'/' -f1)
REPO_NAME=$(echo "$REPO" | cut -d'/' -f2)

echo "## 🌅 Start of Day: $REPO_NAME"
echo ""
```

### 2. Check for In-Progress Session Files

```bash
# Check for abandoned session files
SESSION_FILES=$(ls /home/claude/session-*.md 2>/dev/null || true)

if [ -n "$SESSION_FILES" ]; then
  echo "### ⚠️ Found In-Progress Session"
  echo ""
  echo "Session files from previous work:"
  for f in $SESSION_FILES; do
    echo "- $f"
  done
  echo ""
  echo "**Decision needed:** Continue previous session or archive and start fresh?"
  echo ""
fi
```

### 3. Read Handoff File (if exists)

```bash
HANDOFF_FILE="docs/handoffs/DEV.md"

if [ -f "$HANDOFF_FILE" ]; then
  echo "### 📋 Handoff Notes"
  echo ""
  cat "$HANDOFF_FILE"
  echo ""
else
  echo "### 📋 Handoff Notes"
  echo ""
  echo "*No handoff file found at $HANDOFF_FILE*"
  echo ""
fi
```

### 4. Check for P0 Issues (Drop Everything)

```bash
echo "### 🚨 P0 Issues (Drop Everything)"
echo ""

P0_ISSUES=$(gh issue list --repo "$REPO" --label "prio:P0" --state open --json number,title --jq '.[] | "- #\(.number): \(.title)"')

if [ -n "$P0_ISSUES" ]; then
  echo "$P0_ISSUES"
  echo ""
  echo "**⚠️ P0 issues require immediate attention**"
else
  echo "*None — no fires today* ✅"
fi
echo ""
```

### 5. Check Ready Work

```bash
echo "### 📥 Ready for Development"
echo ""

READY_ISSUES=$(gh issue list --repo "$REPO" --label "status:ready" --state open --json number,title,labels --jq '.[] | "- #\(.number): \(.title)"')

if [ -n "$READY_ISSUES" ]; then
  echo "$READY_ISSUES"
else
  echo "*No issues in status:ready*"
fi
echo ""
```

### 6. Check In-Progress Work

```bash
echo "### 🔧 Currently In Progress"
echo ""

IN_PROGRESS=$(gh issue list --repo "$REPO" --label "status:in-progress" --state open --json number,title --jq '.[] | "- #\(.number): \(.title)"')

if [ -n "$IN_PROGRESS" ]; then
  echo "$IN_PROGRESS"
else
  echo "*Nothing currently in progress*"
fi
echo ""
```

### 7. Check Blocked Items

```bash
echo "### 🛑 Blocked"
echo ""

BLOCKED=$(gh issue list --repo "$REPO" --label "status:blocked" --state open --json number,title --jq '.[] | "- #\(.number): \(.title)"')

if [ -n "$BLOCKED" ]; then
  echo "$BLOCKED"
  echo ""
  echo "*Review blockers — can any be unblocked?*"
else
  echo "*Nothing blocked* ✅"
fi
echo ""
```

### 8. Show Self-Serve Commands Reference

```bash
echo "### 🛠️ Self-Serve Commands"
echo ""
echo "| Command | When to Use |"
echo "|---------|-------------|"
echo "| \`/handoff <issue>\` | PR is ready for QA |"
echo "| \`/question <issue> <text>\` | Need PM clarification |"
echo "| \`/merge <issue>\` | After \`status:verified\` |"
echo "| \`/eod\` | End of session handoff |"
echo ""
```

### 9. Prompt for Focus

```bash
echo "---"
echo ""
echo "**What would you like to focus on this session?**"
echo ""
echo "Options:"
echo "1. Pick an issue from Ready queue"
echo "2. Continue in-progress work"
echo "3. Review blocked items"
echo "4. Something else"
```

## Output Format

The command produces a structured orientation report:

```
## 🌅 Start of Day: crane-relay

### ⚠️ Found In-Progress Session
(if applicable)

### 📋 Handoff Notes
(contents of DEV.md)

### 🚨 P0 Issues (Drop Everything)
- #123: Critical bug in production

### 📥 Ready for Development
- #145: Add retry logic to scout
- #146: Implement caching layer

### 🔧 Currently In Progress
- #144: Refactor adapter interface

### 🛑 Blocked
*Nothing blocked* ✅

### 🛠️ Self-Serve Commands
| Command | When to Use |
|---------|-------------|
| `/handoff <issue>` | PR is ready for QA |
| `/question <issue> <text>` | Need PM clarification |
| `/merge <issue>` | After `status:verified` |
| `/eod` | End of session handoff |

---

**What would you like to focus on this session?**
```

## Notes

- Auto-detects repository from git remote
- Checks for abandoned session files first (prevents lost work)
- P0 issues shown prominently — these override normal priorities
- Command reference reminds Dev of self-serve options
- Works with any repository in the Venture Crane ecosystem
