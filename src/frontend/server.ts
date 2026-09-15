/**
 * chiperf 可视化 HTTP 服务器（产物 dist/app.js 的本体）
 *
 * 用法：
 *   bun app.js                  # 默认 127.0.0.1:4173
 *   bun app.js -p 8080          # 换端口
 *   bun app.js --host 0.0.0.0   # 对外网卡开放（会列出可访问地址）
 *   bun app.js --html other.html# 换成外部页面文件
 *
 * 页面内容在构建时就内嵌进本文件（`__CHIPERF_HTML__`），因此 app.js 单独拷走也能跑；
 * 直接运行源码（`bun src/frontend/server.ts`）时则回退去读构建产物。
 */
import { networkInterfaces } from 'node:os';
import type { Server } from 'bun';

declare const __CHIPERF_HTML_B64__: string | undefined;

const DEFAULT_PORT = 4173;
const DEFAULT_HOST = '127.0.0.1';

/** 构建时内嵌的页面（base64，避免被二次转义）；非内嵌运行时返回 null */
function embeddedHtml(): string | null {
  if (typeof __CHIPERF_HTML_B64__ !== 'string' || __CHIPERF_HTML_B64__.length === 0) return null;
  return Buffer.from(__CHIPERF_HTML_B64__, 'base64').toString('utf8');
}

export interface ServerConfig {
  port: number;
  host: string;
  /** 页面来源描述（用于启动日志） */
  htmlSource: string;
  html: string;
  quiet: boolean;
}

export interface ParsedArgs {
  port?: number;
  host?: string;
  htmlPath?: string;
  help?: boolean;
  quiet?: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => argv[++i];
    if (arg === '-p' || arg === '--port') {
      const value = next();
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`端口不合法：${value}`);
      out.port = port;
    } else if (arg === '--host') {
      out.host = next();
    } else if (arg === '--html') {
      out.htmlPath = next();
    } else if (arg === '-q' || arg === '--quiet') {
      out.quiet = true;
    } else if (arg === '-h' || arg === '--help') {
      out.help = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return out;
}

const HELP = `chiperf 可视化服务器

用法： bun app.js [选项]

选项：
  -p, --port <端口>   监听端口（默认 ${DEFAULT_PORT}，也可用环境变量 PORT）
      --host <地址>   绑定地址（默认 ${DEFAULT_HOST}；用 0.0.0.0 对外网卡开放）
      --html <路径>   改为提供指定的 HTML 文件（默认使用内嵌页面）
  -q, --quiet         只输出一行启动信息
  -h, --help          显示本帮助

路由：
  GET /            页面
  GET /index.html  页面
  GET /healthz     "ok"（给探活用）
  其它路径          404
`;

/** 内嵌页面优先；直接跑源码时回退读构建产物 */
export async function resolveHtml(explicitPath?: string): Promise<{ html: string; source: string }> {
  if (explicitPath !== undefined) {
    const file = Bun.file(explicitPath);
    if (!(await file.exists())) throw new Error(`找不到 --html 指定的文件：${explicitPath}`);
    return { html: await file.text(), source: explicitPath };
  }
  if (typeof __CHIPERF_HTML_B64__ === 'string' && __CHIPERF_HTML_B64__.length > 0) {
    const html = embeddedHtml()!;
    return { html, source: `内嵌页面（${formatBytes(html.length)}）` };
  }
  const fallback = new URL('../../dist/index.html', import.meta.url);
  const file = Bun.file(fallback);
  if (!(await file.exists())) {
    throw new Error('没有内嵌页面，也找不到 dist/index.html；请先在 src/frontend 运行 `bun run build`');
  }
  const html = await file.text();
  return { html, source: `${fallback.pathname}（${formatBytes(html.length)}）` };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

/** 绑定 0.0.0.0 时列出实际可访问的地址，方便"对外提供" */
export function lanUrls(port: number): string[] {
  const out: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && address.internal === false) out.push(`http://${address.address}:${port}`);
    }
  }
  return out;
}

export function startServer(config: ServerConfig): Server {
  const page = new TextEncoder().encode(config.html);
  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    development: false,
    fetch(request) {
      const url = new URL(request.url);
      const method = request.method.toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return new Response(method === 'HEAD' ? null : page, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-length': String(page.byteLength),
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          },
        });
      }
      if (url.pathname === '/healthz') {
        return new Response('ok', { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
      }
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    },
  });

  if (!config.quiet) {
    const lines = [
      '',
      '  chiperf 可视化服务已启动',
      `    地址    http://${formatHost(config.host)}:${server.port}`,
      ...(config.host === '0.0.0.0' || config.host === '::' ? lanUrls(server.port).map((u) => `            ${u}（对外网卡）`) : []),
      `    页面    ${config.htmlSource}`,
      '    路由    /  ·  /index.html  ·  /healthz',
      '    停止    Ctrl+C',
      '',
    ];
    console.log(lines.join('\n'));
  } else {
    console.log(`chiperf 可视化服务：http://${formatHost(config.host)}:${server.port}`);
  }
  return server;
}

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`参数错误：${(err as Error).message}\n`);
    console.error(HELP);
    process.exit(2);
    return;
  }
  if (args.help === true) {
    console.log(HELP);
    return;
  }
  const portFromEnv = process.env.PORT !== undefined ? Number(process.env.PORT) : undefined;
  const port = args.port ?? (Number.isInteger(portFromEnv) ? portFromEnv! : DEFAULT_PORT);
  const host = args.host ?? process.env.HOST ?? DEFAULT_HOST;
  const { html, source } = await resolveHtml(args.htmlPath);
  const server = startServer({ port, host, html, htmlSource: source, quiet: args.quiet ?? false });
  const shutdown = () => {
    server.stop(true);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** 打包成 IIFE（无 top-level await），所以用显式的 promise 链启动 */
main().catch((err: unknown) => {
  console.error(`启动失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
