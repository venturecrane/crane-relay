# /eod - End of Day Handoff

Update handoff file at session end with work accomplished and guidance for next session.

## Usage

```
/eod
```

## Execution Steps

### 1. Detect Repository

```bash
# Get repo from git remote
REPO=$(git remote get-url origin | sed -E 's/.*github\.com[:\/]([^\/]+\/[^\/]+)(\.git)?$/\1/')
REPO_NAME=$(echo "$REPO" | cut -d'/' -f2)

echo "## 🌙 End of Day: $REPO_NAME"
echo ""
```

### 2. Prompt for Session Summary

Ask the user to provide:

```
Please provide a brief summary of this session:

1. **What was accomplished?**
   (Issues worked on, PRs created/merged, problems solved)

2. **What's in progress?**
   (Unfinished work, where you left off)

3. **What's blocked or needs attention?**
   (Blockers, questions for PM, decisions needed)

4. **Recommended next steps?**
   (What the next session should focus on)
```

### 3. Read Current Handoff File

```bash
HANDOFF_FILE="docs/handoffs/DEV.md"

if [ -f "$HANDOFF_FILE" ]; then
  CURRENT_CONTENT=$(cat "$HANDOFF_FILE")
else
  CURRENT_CONTENT=""
fi
```

### 4. Generate Updated Handoff

Create/update the handoff file with structure:

```markdown
# Dev Team Handoff

**Last Updated:** [TODAY'S DATE]
**Repository:** [REPO]

---

## Current State

### In Progress
[List of status:in-progress issues with brief notes]

### Ready to Pick Up
[List of status:ready issues]

### Blocked
[List of blocked items with blocker description]

---

## Session Summary ([DATE])

### Accomplished
[From user input]

### Left Off
[From user input]

### Needs Attention
[From user input]

---

## Next Session Guidance

[From user input - recommended next steps]

---

## Quick Reference

| Command | When to Use |
|---------|-------------|
| `/sod` | Start of session |
| `/handoff <issue>` | PR ready for QA |
| `/question <issue> <text>` | Need PM clarification |
| `/merge <issue>` | After `status:verified` |
```

### 5. Write Handoff File

```bash
# Write the updated content
cat > "$HANDOFF_FILE" << 'EOF'
[Generated handoff content]
EOF
```

### 6. Commit and Push (Optional)

```bash
# Only if there are changes
if git diff --quiet "$HANDOFF_FILE"; then
  echo "No changes to handoff file"
else
  git add "$HANDOFF_FILE"
  git commit -m "docs: update Dev handoff for $(date +%Y-%m-%d)"
  git push
  echo "✅ Handoff committed and pushed"
fi
```

### 7. Clean Up Session Files

```bash
# Check for session files
SESSION_FILES=$(ls /home/claude/session-*.md 2>/dev/null || true)

if [ -n "$SESSION_FILES" ]; then
  echo ""
  echo "### Session Files"
  echo ""
  echo "Found session tracking files:"
  for f in $SESSION_FILES; do
    echo "- $f"
  done
  echo ""
  echo "Options:"
  echo "1. Delete (work complete)"
  echo "2. Keep (work continues next session)"
  echo "3. Archive to /home/claude/archive/"
fi
```

### 8. Report Completion

```
✅ End of Day complete for $REPO_NAME

Handoff updated: docs/handoffs/DEV.md
[Committed and pushed / Not committed]

Session files: [Deleted / Kept / Archived]

---

Good work today. See you next session! 👋
```

## Handoff File Location

| Repository Type | Handoff Path |
|-----------------|--------------|
| Product repo (dfg, sc-*) | `docs/handoffs/DEV.md` |
| Infrastructure repo (crane-*) | `docs/handoffs/DEV.md` |
| Operations repo (*-operations) | `DEV.md` (root) |

## Notes

- Prompts for structured input rather than free-form
- Preserves previous handoff history (appends, doesn't overwrite)
- Optionally commits and pushes changes
- Handles session file cleanup
- Works with any repository in the Venture Crane ecosystem
- The handoff file becomes the input for next session's `/sod`
