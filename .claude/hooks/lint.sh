#!/bin/bash
# Post-edit lint hook: auto-fixes formatting, reports remaining errors to Claude.
# Exit 0 = clean, Exit 2 = errors fed back to Claude for self-correction.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [ -z "$FILE_PATH" ] || [ ! -f "$FILE_PATH" ]; then
  exit 0
fi

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"

# --- Python files: ruff ---
if [[ "$FILE_PATH" == *.py ]]; then
  # Auto-fix: format + fixable lint errors
  "$PROJECT_ROOT/.venv/bin/ruff" format "$FILE_PATH" 2>/dev/null
  "$PROJECT_ROOT/.venv/bin/ruff" check --fix --quiet "$FILE_PATH" 2>/dev/null

  # Check for remaining errors
  ERRORS=$("$PROJECT_ROOT/.venv/bin/ruff" check --quiet "$FILE_PATH" 2>&1)
  if [ -n "$ERRORS" ]; then
    echo "$ERRORS" >&2
    exit 2
  fi
  exit 0
fi

# --- TypeScript/JavaScript files: prettier + eslint ---
if [[ "$FILE_PATH" == *.ts || "$FILE_PATH" == *.tsx || "$FILE_PATH" == *.js || "$FILE_PATH" == *.jsx ]]; then
  FRONTEND_DIR="$PROJECT_ROOT/frontend"

  # Only lint frontend files (skip node_modules, generated, etc.)
  if [[ "$FILE_PATH" != "$FRONTEND_DIR"/* ]]; then
    exit 0
  fi

  # Auto-fix: prettier
  npx --prefix "$FRONTEND_DIR" prettier --write "$FILE_PATH" 2>/dev/null

  # Auto-fix: eslint
  npx --prefix "$FRONTEND_DIR" eslint --fix "$FILE_PATH" 2>/dev/null

  # Check for remaining eslint errors
  ERRORS=$(npx --prefix "$FRONTEND_DIR" eslint "$FILE_PATH" 2>&1)
  if [ $? -ne 0 ]; then
    echo "$ERRORS" >&2
    exit 2
  fi
  exit 0
fi

# Other file types: skip
exit 0
