/**
 * 产物测试：dist/index.html（独立单文件）与 dist/app.js（HTTP 服务器）
 *
 * 这两个文件是交付形态本身，所以这里断言的是它们的**可观察契约**：
 *  - 页面不引用任何外部资源（能双击打开 / 能直接托管）
 *  - 服务器提供页面、/healthz、404、405，且提供的内容与 dist/index.html 完全一致
 */
import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FRONTEND = join(import.meta.dir, '..');
const DIST = join(FRONTEND, '..', '..', 'dist');
const PORT = 4400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;

let server: Bun.Subprocess | null = null;

/** 等服务器自己打印启动行（真实信号，不靠猜时长） */
async function waitForStartupLine(child: Bun.Subprocess): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const line = buffer.split('\n').find((l) => l.includes('chiperf 可视化服务'));
    if (line !== undefined) return line.trim();
  }
  throw new Error(`服务器未打印启动行就退出了：${buffer}`);
}

beforeAll(async () => {
  const build = Bun.spawnSync({ cmd: ['bun', 'build.ts'], cwd: FRONTEND, stdout: 'pipe', stderr: 'pipe' });
  if (build.exitCode !== 0) throw new Error(`构建失败：${build.stderr.toString()}`);
  const child = Bun.spawn({
    cmd: ['bun', join(DIST, 'app.js'), '-p', String(PORT), '-q'],
    cwd: DIST,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  server = child;
  const line = await waitForStartupLine(child);
  expect(line).toContain(String(PORT));
});

afterAll(() => {
  server?.kill();
});

describe('dist/index.html（独立单文件）', () => {
  test('存在、内联了 CSS 与 JS，且不引用任何外部资源', async () => {
    const html = await Bun.file(join(DIST, 'index.html')).text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    // 内联样式与脚本都真的在文件里（脚本体积即"应用已被打包进来"的可观察证据）
    const styleBody = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));
    const scriptBody = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
    expect(styleBody.length).toBeGreaterThan(2000);
    expect(scriptBody.length).toBeGreaterThan(20000);
    expect(scriptBody).toContain('chiperf');
    const external = [...html.matchAll(/(?:href|src)="([^"]+)"/g)]
      .map((m) => m[1]!)
      .filter((url) => !url.startsWith('data:'));
    expect(external).toEqual([]);
    // 占位标记必须已经被替换掉
    expect(html).not.toContain('__CHIPERF_STYLES__');
    expect(html).not.toContain('__CHIPERF_SCRIPT__');
  });

  test('内联脚本里没有会被浏览器当成结束标签的 </script>', async () => {
    const html = await Bun.file(join(DIST, 'index.html')).text();
    const scriptBody = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
    expect(scriptBody).not.toContain('</script>');
  });
});

describe('dist/app.js（HTTP 服务器）', () => {
  test('/ 返回与 dist/index.html 完全一致的页面', async () => {
    const response = await fetch(`${BASE}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const served = await response.text();
    const file = await Bun.file(join(DIST, 'index.html')).text();
    expect(served).toBe(file);
  });

  test('/index.html 与 /healthz 可用', async () => {
    const index = await fetch(`${BASE}/index.html`);
    expect(index.status).toBe(200);
    const health = await fetch(`${BASE}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('ok');
  });

  test('未知路径 404、非 GET/HEAD 405', async () => {
    expect((await fetch(`${BASE}/nope`)).status).toBe(404);
    expect((await fetch(`${BASE}/`, { method: 'POST' })).status).toBe(405);
    const head = await fetch(`${BASE}/`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  test('页面脚本在服务端渲染前不依赖任何网络请求（自包含）', async () => {
    const html = await (await fetch(`${BASE}/`)).text();
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href="(?!data:)/);
  });

  test('与 app.js 同目录有 index.html 时优先用它（改完源码重新 build 即刻生效）', async () => {
    const line = await Bun.file(join(DIST, 'index.html')).text();
    const response = await fetch(`${BASE}/`);
    expect(await response.text()).toBe(line);
  });

  test('重新 build 后无需重启：服务器按请求重读页面文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chiperf-live-'));
    try {
      const pagePath = join(dir, 'index.html');
      const appPath = join(dir, 'app.js');
      await copyFile(join(DIST, 'app.js'), appPath);
      await writeFile(pagePath, '<!doctype html><title>v1</title>');
      const port = PORT + 2;
      const child = Bun.spawn({ cmd: ['bun', appPath, '-p', String(port), '-q'], cwd: dir, stdout: 'pipe', stderr: 'pipe' });
      try {
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.includes('chiperf 可视化服务')) break;
        }
        expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toContain('v1');
        await writeFile(pagePath, '<!doctype html><title>v2</title>');
        expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toContain('v2');
      } finally {
        child.kill();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('app.js 被单独拷到没有 index.html 的目录时，仍然提供内嵌页面', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chiperf-portable-'));
    try {
      const standalone = join(dir, 'app.js');
      await copyFile(join(DIST, 'app.js'), standalone);
      const port = PORT + 1;
      const child = Bun.spawn({ cmd: ['bun', standalone, '-p', String(port), '-q'], cwd: dir, stdout: 'pipe', stderr: 'pipe' });
      try {
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.includes('chiperf 可视化服务')) break;
        }
        const served = await (await fetch(`http://127.0.0.1:${port}/`)).text();
        expect(served).toBe(await Bun.file(join(DIST, 'index.html')).text());
      } finally {
        child.kill();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
