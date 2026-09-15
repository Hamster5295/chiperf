/**
 * 构建产物（两个文件）：
 *
 *   dist/index.html   独立单文件页面（CSS/JS 内联，双击可开）
 *   dist/app.js       HTTP 服务器（bun app.js 启动后对外提供该页面，页面已内嵌）
 *
 * 运行： cd src/frontend && bun run build
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inlineIntoSingleFile } from './inline.ts';

const HERE = new URL('.', import.meta.url).pathname;
const DIST = join(HERE, '..', '..', 'dist');

async function bundleBrowserApp(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(HERE, 'src', 'main.ts')],
    target: 'browser',
    format: 'iife',
    minify: true,
  });
  if (!result.success) throw new Error(`浏览器端打包失败：${result.logs.map(String).join('\n')}`);
  const output = result.outputs[0];
  if (!output) throw new Error('浏览器端打包没有产出');
  return output.text();
}

async function bundleServer(htmlBase64: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(HERE, 'server.ts')],
    target: 'bun',
    format: 'iife',
    minify: true,
    // 用 base64 内嵌页面：base64 不含引号/反斜杠，因此不会被 JSON/JS 二次转义
    // （若直接内嵌文本，压缩器把中文转成的 \uXXXX 会被再转义一次，产物会胖 3 倍）
    define: { __CHIPERF_HTML_B64__: JSON.stringify(htmlBase64) },
  });
  if (!result.success) throw new Error(`服务器端打包失败：${result.logs.map(String).join('\n')}`);
  const output = result.outputs[0];
  if (!output) throw new Error('服务器端打包没有产出');
  return output.text();
}

export async function build(): Promise<{ html: number; server: number; page: number; script: number; style: number }> {
  const [template, css, js] = await Promise.all([
    Bun.file(join(HERE, 'index.html')).text(),
    Bun.file(join(HERE, 'styles.css')).text(),
    bundleBrowserApp(),
  ]);
  const html = inlineIntoSingleFile(template, { jsBundle: js, css, template });
  const serverCode = await bundleServer(Buffer.from(html, 'utf8').toString('base64'));
  const appJs = `#!/usr/bin/env bun\n${serverCode}`;

  await mkdir(DIST, { recursive: true });
  await writeFile(join(DIST, 'index.html'), html);
  await writeFile(join(DIST, 'app.js'), appJs);
  await chmod(join(DIST, 'app.js'), 0o755);

  return { html: html.length, server: appJs.length, page: html.length, script: js.length, style: css.length };
}

const sizes = await build();
const kb = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
console.log(`dist/index.html   ${kb(sizes.html)}（页面，内联 CSS ${kb(sizes.style)} + JS ${kb(sizes.script)}）`);
console.log(`dist/app.js       ${kb(sizes.server)}（HTTP 服务器，页面已内嵌）`);
