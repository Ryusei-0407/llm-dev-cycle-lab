import { defineConfig } from "vite-plus";

// ルートは vp check(fmt / lint / 型チェック統合)の設定のみ。
// アプリ本体の設定は各ワークスペースの vite.config.ts が持つ。
export default defineConfig({
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
