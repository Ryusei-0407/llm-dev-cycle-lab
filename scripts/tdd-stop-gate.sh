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

# Hook 環境は非ログインシェルで PATH が最小構成 — この環境の pnpm は devenv
# (nix)供給なので素の PATH には無い。nix の定位置を足した上で pnpm →
# devenv 経由の順に解決し、どちらも無ければ「ゲートが検証できない」ことを
# 明示して止める(黙って素通しにするとゲートの存在意義が消える)。
export PATH="$PATH:$HOME/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/opt/homebrew/bin:/usr/local/bin"
if command -v pnpm >/dev/null 2>&1; then
  run_unit() { pnpm run test:unit; }
elif command -v devenv >/dev/null 2>&1; then
  run_unit() { devenv shell -- bash -c "pnpm run test:unit"; }
else
  echo "TDD gate: pnpm も devenv も PATH に無く unit テストを実行できない。環境を直すか、手動で pnpm test:unit を green にしてから rm .claude/tdd-gate で外すこと。" >&2
  exit 2
fi

if ! run_unit >/tmp/tdd-gate.log 2>&1; then
  echo "TDD gate: unit tests are failing. Fix them before finishing (tail of output below)." >&2
  tail -n 20 /tmp/tdd-gate.log >&2
  exit 2
fi
exit 0
