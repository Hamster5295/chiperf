/**
 * 前端外壳：加载文件 → 解析 → 挂载视图 → 调度刷新
 *
 * 数据流：文件/示例 → parser（@chiperf/parser）→ Trace → ViewContext → 各视图
 */
import { parseChiperf, parseChiperfBytes, UnsupportedVersionError, type Trace } from '../../parser/src/index.ts';
import { el, clear, card, statTile, countLabel } from './charts.ts';
import { fmtBytes, fmtInt, type AppOptions, type Selection, type SelectionBus, type View, type ViewContext } from './view.ts';

interface AppState {
  views: View[];
  currentId: string;
  trace: Trace | null;
  source: { name: string; bytes: number; gzip: boolean };
  options: AppOptions;
  error: string | null;
  retryableText: string | null;
}

const state: AppState = {
  views: [],
  currentId: '',
  trace: null,
  source: { name: '', bytes: 0, gzip: false },
  options: { domains: [], useTimeAxis: true, zoom: 1 },
  error: null,
  retryableText: null,
};

const listeners = new Set<(selection: Selection, kind: 'select' | 'hover') => void>();
let selection: Selection = null;

export const selectionBus: SelectionBus = {
  get: () => selection,
  set(next) {
    selection = next;
    for (const l of listeners) l(next, 'select');
  },
  hover(next) {
    for (const l of listeners) l(next, 'hover');
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function startApp(views: View[], sample: { name: string; text: string }): void {
  state.views = views;
  const hash = location.hash.replace(/^#\/?/, '');
  state.currentId = views.some((v) => v.id === hash) ? hash : views[0]!.id;
  renderShell();
  window.addEventListener('hashchange', () => {
    const id = location.hash.replace(/^#\/?/, '');
    if (views.some((v) => v.id === id) && id !== state.currentId) {
      state.currentId = id;
      renderMain();
      renderNav();
    }
  });
  void loadSample(sample);
}

// ------------------------------------------------------------------ 外壳

function renderShell(): void {
  const app = document.getElementById('app')!;
  clear(app);
  app.append(buildHeader(), el('div', { class: 'layout' }, [buildRail(), buildMain()]));
}

function buildHeader(): HTMLElement {
  const nameNode = el('span', { class: 'file-name', text: state.trace ? state.source.name || '(未命名)' : '未加载文件' });
  const loadBtn = el('button', { class: 'btn btn-primary', text: '打开 .chiperf' });
  const input = el('input', {
    type: 'file',
    accept: '.chiperf,.gz,.chiperf.gz,application/gzip,text/plain',
    style: 'display:none',
  });
  loadBtn.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void loadFile(file);
  });
  const sampleBtn = el('button', { class: 'btn', text: '载入示例' });
  sampleBtn.addEventListener('click', () => void loadSampleInternal());

  const chips = el('div', { class: 'header-chips' });
  if (state.trace) {
    const t = state.trace;
    chips.append(chip(`${countLabel(t.stats.records)} 记录`, 'chip-ok'));
    chips.append(chip(`${fmtBytes(t.stats.bytes)} · ${t.stats.bytesPerRecord.toFixed(1)} B/记录`, ''));
    chips.append(chip(`chiperf ${t.version.major}.${t.version.minor}${t.version.explicit ? '' : '（隐含）'}`, ''));
    chips.append(chip(`${t.domains.size} 时钟域`, ''));
    const diagCount = t.diagnostics.length;
    const diagChip = chip(`诊断 ${diagCount}`, diagCount === 0 ? 'chip-ok' : 'chip-warn');
    diagChip.style.cursor = 'pointer';
    diagChip.addEventListener('click', () => openDiagnostics());
    chips.append(diagChip);
    if (t.truncatedTail !== null) chips.append(chip('文件被截断', 'chip-warn'));
    if (!t.endSeen) chips.append(chip('无 @end', 'chip-warn'));
  }

  return el('header', { class: 'app-header' }, [
    el('div', { class: 'brand' }, [el('span', { class: 'logo', text: '◧' }), el('span', { text: 'chiperf' })]),
    nameNode,
    chips,
    el('div', { class: 'header-actions' }, [loadBtn, sampleBtn, input]),
  ]);
}

function chip(text: string, cls: string): HTMLElement {
  return el('span', { class: `chip ${cls}`.trim(), text });
}

/** 侧边栏图标：内联 12×12 描边图形，统一用 currentColor，避免依赖图标字体 */
const RAIL_ICONS: Record<string, string> = {
  overview: 'M2 2h4v4H2zM8 2h4v7H8zM2 8h4v4H2zM8 11h4v1H8z',
  timeline: 'M1 3h10M1 7h7M1 11h9',
  pipeline: 'M1 3h4v6H1zM7 3h4v3H7zM7 8h4v3H7z',
  fsm: 'M2 3h3v3H2zM7 8h3v3H7zM5 4.5h3.5v5',
  counters: 'M2 10V6M5 10V3M8 10V5M11 10V2',
  values: 'M1 8c2 0 2-5 4-5s2 6 4 6 1-3 2-3',
  table: 'M1 3h10M1 6.5h10M1 10h10M4 3v7.5M8 3v7.5',
};

function viewIcon(id: string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('class', 'rail-icon');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', RAIL_ICONS[id] ?? 'M1 6h10');
  svg.append(path);
  return svg;
}

function buildRail(): HTMLElement {
  const rail = el('nav', { class: 'rail' });
  rail.id = 'rail';
  for (const view of state.views) {
    const link = el('a', { class: 'rail-item', href: `#/${view.id}`, title: view.hint }, [
      viewIcon(view.id),
      el('span', { class: 'rail-title', text: view.title }),
    ]);
    if (view.id === state.currentId) link.classList.add('is-active');
    rail.append(link);
  }
  return rail;
}

function renderNav(): void {
  const rail = document.getElementById('rail');
  if (!rail) return;
  for (const child of rail.children) {
    const link = child as HTMLAnchorElement;
    link.classList.toggle('is-active', link.getAttribute('href') === `#/${state.currentId}`);
  }
}

function buildMain(): HTMLElement {
  const main = el('main', { class: 'main' });
  main.id = 'main';
  return main;
}

function renderMain(): void {
  const main = document.getElementById('main')!;
  clear(main);

  if (state.error) {
    main.append(
      el('div', { class: 'card error-card' }, [
        el('h3', { text: '无法解析该文件' }),
        el('pre', { class: 'error-text', text: state.error }),
        state.retryableText !== null
          ? (() => {
              const btn = el('button', { class: 'btn', text: '忽略版本号并尽力解析' });
              btn.addEventListener('click', () => {
                const text = state.retryableText!;
                state.retryableText = null;
                state.error = null;
                applyTrace(parseChiperf(text, { ignoreVersion: true }), state.source);
              });
              return btn;
            })()
          : null,
      ]),
    );
    return;
  }

  if (!state.trace) {
    main.append(buildDropzone());
    return;
  }

  const view = state.views.find((v) => v.id === state.currentId);
  if (!view) return;
  const container = el('div', { class: 'view' });
  main.append(buildViewHeader(view), buildToolbar(), container);
  view.mount(container, context());
}

function buildViewHeader(view: View): HTMLElement {
  return el('div', { class: 'view-head' }, [el('h2', { text: view.title }), el('p', { class: 'muted', text: view.hint })]);
}

function buildToolbar(): HTMLElement {
  const trace = state.trace!;
  const bar = el('div', { class: 'toolbar' });

  const domainChips = el('div', { class: 'toolbar-group' }, [el('span', { class: 'toolbar-label', text: '时钟域' })]);
  for (const [name, info] of trace.domains) {
    const active = state.options.domains.length === 0 || state.options.domains.includes(name);
    const node = el('button', {
      class: `chip chip-toggle${active ? ' is-on' : ''}`,
      text: `${name} · ${countLabel(info.cycles)} 周期`,
      title: info.periodNs !== undefined ? `周期 ${info.periodNs} ns` : '未声明 period/freq',
    });
    node.addEventListener('click', () => {
      const all = [...trace.domains.keys()];
      const current = state.options.domains.length === 0 ? all : state.options.domains;
      const next = current.includes(name) ? current.filter((d) => d !== name) : [...current, name];
      state.options.domains = next.length === all.length ? [] : next;
      renderMain();
    });
    domainChips.append(node);
  }
  bar.append(domainChips, el('div', { class: 'toolbar-spacer' }));

  // 多域时周期号各自独立计数：这里必须说清楚，否则读者会以为 default#6 与 mem#6 是同一时刻
  const shown = [...trace.domains.keys()].filter((d) => state.options.domains.length === 0 || state.options.domains.includes(d));
  if (shown.length > 1) {
    bar.append(el('span', { class: 'muted nowrap', text: '各域周期号独立计数（≠ 同一时刻）' }));
  }

  const diagBtn = el('button', { class: 'btn btn-ghost', text: `诊断 (${trace.diagnostics.length})` });
  diagBtn.addEventListener('click', () => openDiagnostics());
  bar.append(diagBtn);
  return bar;
}

function context(): ViewContext {
  return {
    trace: state.trace!,
    source: state.source,
    options: state.options,
    selection: selectionBus,
    rerender: () => renderMain(),
    inspect: (title, rows, body) => openInspector(title, rows, body),
  };
}

function refreshViews(reason: 'options' | 'selection' | 'hover'): void {
  const view = state.views.find((v) => v.id === state.currentId);
  if (!view?.refresh || !state.trace) return;
  view.refresh(context(), reason);
}

// ------------------------------------------------------------------ 加载

async function loadFile(file: File): Promise<void> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  const gzip = buffer[0] === 0x1f && buffer[1] === 0x8b;
  const source = { name: file.name, bytes: buffer.byteLength, gzip };
  state.retryableText = null;
  try {
    if (gzip) {
      applyTrace(parseChiperfBytes(buffer), source);
      return;
    }
    const text = new TextDecoder('utf-8').decode(buffer);
    applyTrace(parseChiperf(text), source);
  } catch (err) {
    if (err instanceof UnsupportedVersionError) {
      state.retryableText = gzip ? null : new TextDecoder('utf-8').decode(buffer);
      state.error = `${err.message}\n\n若只想看个大概，可以用下面的按钮强制按 1.x 解析。`;
    } else {
      state.error = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    }
    state.trace = null;
    renderMain();
  }
}

let sampleText = '';

async function loadSample(sample: { name: string; text: string }): Promise<void> {
  sampleText = sample.text;
  await loadSampleInternal();
}

async function loadSampleInternal(): Promise<void> {
  const text = sampleText;
  state.error = null;
  applyTrace(parseChiperf(text), { name: 'sample.chiperf', bytes: new TextEncoder().encode(text).length, gzip: false });
}

function applyTrace(trace: Trace, source: { name: string; bytes: number; gzip: boolean }): void {
  state.trace = trace;
  state.source = source;
  state.error = null;
  const names = [...trace.domains.keys()];
  state.options.domains = state.options.domains.filter((d) => names.includes(d));
  renderShell();
  renderMain();
}

// ------------------------------------------------------------------ 面板

function buildDropzone(): HTMLElement {
  const zone = el('div', { class: 'dropzone' }, [
    el('div', { class: 'dropzone-icon', text: '⌄' }),
    el('h3', { text: '把 .chiperf / .chiperf.gz 拖到这里' }),
    el('p', { class: 'muted', text: '或者点击右上角的"打开 .chiperf"。文件只在本地解析，不会上传。' }),
  ]);
  return zone;
}

export function installGlobalDropzone(): void {
  const zone = document.body;
  const highlight = (on: boolean) => zone.classList.toggle('is-dragging', on);
  // 只对"拖文件进来"反应：页内拖拽（例如时间轴行排序）也会冒泡到这里，
  // 靠 dataTransfer.types 区分，否则拖行时会错误地弹出"松开以载入 .chiperf"
  const carriesFiles = (event: DragEvent): boolean => (event.dataTransfer?.types ?? []).includes('Files');
  zone.addEventListener('dragover', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    highlight(true);
  });
  zone.addEventListener('dragleave', (event) => {
    if (!carriesFiles(event)) return;
    highlight(false);
  });
  zone.addEventListener('drop', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    highlight(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) void loadFile(file);
  });
}

function drawer(): { root: HTMLElement; body: HTMLElement; close(): void } {
  let root = document.getElementById('drawer');
  if (root) root.remove();
  const body = el('div', { class: 'drawer-body' });
  const closeBtn = el('button', { class: 'btn btn-ghost', text: '关闭' });
  root = el('aside', { class: 'drawer' }, [el('div', { class: 'drawer-head' }, [el('h3', { text: '' }), closeBtn]), body]);
  document.body.append(root);
  const close = () => root?.remove();
  closeBtn.addEventListener('click', close);
  return { root, body, close };
}

function openInspector(title: string, rows: [string, string][], extra?: HTMLElement): void {
  const panel = drawer();
  panel.root.querySelector('h3')!.textContent = title;
  panel.body.append(
    el(
      'dl',
      { class: 'kv' },
      rows.flatMap(([key, value]) => [el('dt', { text: key }), el('dd', { text: value })]),
    ),
  );
  if (extra) panel.body.append(extra);
}

function openDiagnostics(): void {
  const trace = state.trace;
  if (!trace) return;
  const panel = drawer();
  panel.root.querySelector('h3')!.textContent = `诊断（${trace.diagnostics.length}）`;
  const counts = [...trace.diagnosticCounts].sort((a, b) => b[1] - a[1]);
  panel.body.append(
    el('div', { class: 'stat-row' }, counts.map(([code, n]) => statTile(code, fmtInt(n)))),
    el('h4', { text: '逐条' }),
    el(
      'div',
      { class: 'diag-list' },
      trace.diagnostics.slice(0, 400).map((d) =>
        el('div', { class: 'diag-item' }, [
          el('code', { text: d.code }),
          el('span', { class: 'muted', text: d.line > 0 ? `第 ${d.line} 行` : '文件级' }),
          el('span', { text: d.message }),
        ]),
      ),
    ),
  );
  if (trace.skipped.length > 0) {
    panel.body.append(
      el('h4', { text: `跳过的行（${trace.skipped.length}）` }),
      el(
        'div',
        { class: 'diag-list' },
        trace.skipped.slice(0, 200).map((s) =>
          el('div', { class: 'diag-item' }, [
            el('code', { text: s.reason }),
            el('span', { class: 'muted', text: `第 ${s.line} 行` }),
            el('code', { class: 'mono', text: s.raw.slice(0, 120) }),
          ]),
        ),
      ),
    );
  }
}

/** 视图内部想开卡片时复用的导出，避免各视图重复 import */
export { card, statTile, countLabel };
