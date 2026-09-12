// 把测试入口与 mock 打包成 CJS（alias 把 obsidian 指向 mock）
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 真实 Vault 路径不写进代码，打包时以常量注入给两个测试入口：
 *   1. 环境变量 VISUAL_FEED_VAULT
 *   2. test/vault.local（本地文件，已 gitignore）
 *
 *   VISUAL_FEED_VAULT="/path/to/your/vault" npm test
 */
function resolveVaultRoot() {
  const fromEnv = (process.env.VISUAL_FEED_VAULT || "").trim();
  if (fromEnv) return fromEnv;
  const local = join(here, "vault.local");
  if (existsSync(local)) return readFileSync(local, "utf8").trim();
  return "";
}

const common = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  alias: { obsidian: "./test/obsidian-mock.ts" },
  define: { __VAULT_ROOT__: JSON.stringify(resolveVaultRoot()) },
  logLevel: "warning",
};

await esbuild.build({ ...common, entryPoints: ["test/run-test.ts"], outfile: "test/run-test.cjs" });
await esbuild.build({
  ...common,
  entryPoints: ["test/run-dom-test.ts"],
  outfile: "test/run-dom-test.cjs",
  external: ["jsdom"],
});
console.log("测试打包完成: test/run-test.cjs, test/run-dom-test.cjs");
