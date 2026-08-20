#!/usr/bin/env bash
# Claude Code PreToolUse hook: メイン作業ディレクトリ(primary worktree)での
# ブランチ切り替えを禁止する。メインは常に main に留め、ブランチ作業はすべて
# `git worktree add` 配下で行う(CLAUDE.md 作業スタイル)。
#
# 対象はこのフックを実行しているセッションの cwd が primary worktree のときのみ:
# linked worktree(エージェントの隔離 worktree 含む)内のセッションは対象外。
# コマンド文字列が別 worktree を明示している場合(cd / git -C)も対象外。
set -u

input=$(cat 2>/dev/null || true)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$cmd" ] && exit 0

# ブランチを動かし得るコマンドでなければ即許可(以降の git 呼び出しを省く)。
printf '%s' "$cmd" | grep -qE 'git (checkout|switch)|gh stack' || exit 0

# linked worktree のセッションは対象外(primary は git-dir == git-common-dir)。
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
if [ -n "$cwd" ]; then
  gitdir=$(git -C "$cwd" rev-parse --absolute-git-dir 2>/dev/null || true)
  common=$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  if [ -n "$gitdir" ] && [ "$gitdir" != "$common" ]; then
    exit 0
  fi
fi

# 別ディレクトリ(worktree)を明示して操作するコマンドは許可。
case "$cmd" in
  *"/aaa-"* | *".claude/worktrees"*) exit 0 ;;
esac

deny() {
  jq -n --arg r "$1" \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
  exit 0
}

reason="メイン作業ディレクトリのブランチ切り替えは禁止(常に main に留める)。git worktree add ../aaa-<topic> [-b <branch>] で worktree を作り、その中で作業する。gh stack のブランチ操作系も worktree 内から実行する。"

# gh stack のうちブランチを動かすサブコマンドを遮断(view/list/submit 等の
# push 系は現ブランチを動かさないが、init/sync 等はメインを切り替える)。
if printf '%s' "$cmd" | grep -qE 'gh stack (init|checkout|switch|sync|rebase|restack|modify|top|bottom|up|down|trunk|merge)\b'; then
  deny "$reason"
fi

# git checkout / switch: 出現箇所を1つずつ検査し、全てが
#   (a) ファイル復元(` -- ` を含む) or (b) main への復帰(引数が main のみ)
# のときだけ許可。1つでもブランチ切替があれば拒否。
occurrences=$(printf '%s' "$cmd" | grep -oE 'git (checkout|switch)[^;&|]*' || true)
if [ -n "$occurrences" ]; then
  while IFS= read -r occ; do
    printf '%s' "$occ" | grep -qE ' -- ' && continue
    printf '%s' "$occ" | grep -qE '^git (checkout|switch)( -q| --quiet)* main[[:space:]]*$' && continue
    deny "$reason"
  done <<EOF
$occurrences
EOF
fi

exit 0
