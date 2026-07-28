#!/usr/bin/env bash
# Claude Code Stop hook: while the TDD gate is armed (.claude/tdd-gate exists),
# block ending the turn until unit tests pass. Arm/disarm with:
#   touch .claude/tdd-gate   /   rm .claude/tdd-gate
set -u

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# Not armed: allow stopping.
[ -f .claude/tdd-gate ] || exit 0

# Avoid infinite loops: if we already blocked once this stop, let it through.
input="$(cat 2>/dev/null || true)"
case "$input" in
  *'"stop_hook_active":true'*) exit 0 ;;
esac

if ! npm run test:unit --silent >/tmp/tdd-gate.log 2>&1; then
  echo "TDD gate: unit tests are failing. Fix them before finishing (tail of output below)." >&2
  tail -n 20 /tmp/tdd-gate.log >&2
  exit 2
fi
exit 0
