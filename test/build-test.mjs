// 把测试入口与 mock 打包成 CJS（alias 把 obsidian 指向 mock）
import esbuild from "esbuild";

const common = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  alias: { obsidian: "./test/obsidian-mock.ts" },
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
