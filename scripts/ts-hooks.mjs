// 讓 Node 直接執行 src/ 的 TypeScript（MIL-91）。給 scripts/seed.mjs 用，應用程式本身仍由 Next.js 建置。
// 做兩件事：
//   1. 解析：補上 .ts、/index.ts，並認得 tsconfig 的 @/ 別名。
//   2. 轉譯：用專案已有的 typescript 套件（devDependency）去掉型別，只轉譯、不做型別檢查。
// 用法：import { registerTsHooks } from './ts-hooks.mjs'; registerTsHooks();
import { existsSync, readFileSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

function resolveFile(base) {
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
  return candidates.find((file) => existsSync(file) && statSync(file).isFile());
}

export function registerTsHooks() {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      let base;
      if (specifier.startsWith('@/')) base = path.join(SRC, specifier.slice(2));
      else if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
        base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
      }
      // 只攔 src 底下與 scripts 的相對匯入，套件與 node: 內建模組照原本的解析
      if (base && (base.startsWith(SRC) || base.startsWith(path.join(ROOT, 'scripts')))) {
        const file = resolveFile(base);
        if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (!url.startsWith('file:')) return nextLoad(url, context);
      // 打包器允許不帶屬性的 JSON 匯入，Node 要求 with { type: 'json' }，所以 src/ 底下的 JSON 由這裡直接讀
      if (url.endsWith('.json') && fileURLToPath(url).startsWith(SRC)) {
        return { format: 'json', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true };
      }
      if (!/\.tsx?$/.test(url)) return nextLoad(url, context);
      const source = readFileSync(fileURLToPath(url), 'utf8');
      const { outputText } = ts.transpileModule(source, {
        fileName: fileURLToPath(url),
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
          isolatedModules: true,
        },
      });
      return { format: 'module', source: outputText, shortCircuit: true };
    },
  });
}
