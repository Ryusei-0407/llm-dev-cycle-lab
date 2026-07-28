{ pkgs, ... }:

{
  # Node.js + pnpm — devenv shell 以外で pnpm を用意する必要はない
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_22;
    pnpm.enable = true;
  };

  # ffmpeg: PRメディアの GIF 変換(scripts/pr-media-comment.mjs)で使用
  packages = [ pkgs.ffmpeg ];

  # pre-commit: フォーマットとリントのみ(速さ優先)。
  # テストのゲートは CI と Claude Code の Stop hook が担う
  git-hooks.hooks = {
    oxfmt = {
      enable = true;
      name = "oxfmt (format check)";
      entry = "pnpm exec vp fmt --check";
      files = "\\.(ts|tsx|js|jsx|mjs)$";
      pass_filenames = true;
    };
    oxlint = {
      enable = true;
      name = "oxlint";
      entry = "pnpm exec vp lint";
      files = "\\.(ts|tsx|js|jsx|mjs)$";
      pass_filenames = true;
    };
    verify-conventions = {
      enable = true;
      name = "verify-conventions (POLICY rules)";
      entry = "node scripts/verify-conventions.mjs";
      files = "\\.(ts|tsx)$";
      pass_filenames = false;
    };
  };
}
