import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const out = await build({
  entryPoints: ["src/hash.ts"],
  bundle: true, format: "esm", write: false, target: "es2020",
});
const mod = await import("data:text/javascript;base64," +
  Buffer.from(out.outputFiles[0].text).toString("base64"));

const files = process.argv.slice(2);
let ok = 0, bad = 0;

for (const f of files) {
  const buf = readFileSync(f);
  const expected = execFileSync("git", ["hash-object", "--", f]).toString().trim();

  // 1) 既定経路（node には WebCrypto があるのでそちら）
  const viaDefault = await mod.gitBlobSha(new Uint8Array(buf));

  // 2) WebCrypto を隠して JS フォールバックを強制
  const savedSubtle = globalThis.crypto.subtle;
  Object.defineProperty(globalThis.crypto, "subtle", { value: undefined, configurable: true });
  const viaFallback = await mod.gitBlobSha(new Uint8Array(buf));
  Object.defineProperty(globalThis.crypto, "subtle", { value: savedSubtle, configurable: true });

  if (viaDefault === expected && viaFallback === expected) ok++;
  else {
    bad++;
    console.log(`MISMATCH ${f}\n  git      ${expected}\n  default  ${viaDefault}\n  fallback ${viaFallback}`);
  }
}
console.log(`\n${ok} 一致 / ${bad} 不一致 （計 ${files.length} ファイル）`);
process.exit(bad === 0 ? 0 : 1);
