/**
 * 计数器视图 —— 累计曲线、每周期增量、终值占比与区间差工具（spec §9.2）
 *
 * 数据来源：`Trace.counters`（追踪键 = (域, 名字)）+ `eventCounters()`：`[evt]` 轨
 * 按"每条 +1"折算成计数器一起展示（显示名带 `[evt]` 前缀，键带 `evt:` 前缀，
 * 所以同名的 `[cnt]`/`[evt]` 是两条独立轨道）。四条必须守住的口径：
 *  - `abs=` 回读记录只置总量、不贡献增量（`samples[].delta === null`，spec §9.2）
 *  - 累计值取"该周期末"的取值（`counterTotalAt` 的判据是 position ≤ (cycle, n)）
 *  - `async=1` 的记录不在时钟沿上，必须画在所在周期的区间**内部**（spec §6.7）
 *  - 横轴是周期数；每张图窗口式缩放/平移（Ctrl/⌘ + 滚轮缩放、横向滚轮平移），最小值 = 整条铺满
 */
import type { CounterTrack, DomainInfo, Trace } from '../../../parser/src/index.ts';
import { counterDeltaBetween, counterTotalAt, eventCounters, ratioBetween } from '../../../parser/src/index.ts';
import {
  barRect,
  card,
  clear,
  colorFor,
  countLabel,
  cycleAxis,
  dataTable,
  el,
  emptyState,
  hoverTarget,
  legend,
  linearScale,
  numericAxis,
  statTile,
  svgEl,
  svgRoot,
} from '../charts.ts';
import { abortable, runChunked } from '../chunk.ts';
import { cycleTime, fmtInt, type Selection, type View, type ViewContext } from '../view.ts';
import { clampWindow, installChartViewport, type CycleWindow } from './viewport.ts';

/** 绘图区左右边距 */
const AXIS_PAD = { left: 54, right: 16 };
/** 低于这个每周期像素数就把 [evt] 折算轨退化成功密度带 */
const LOD_LINE_PX = 4;
/** 每张图各自的可见窗口；换文件整批清掉 */
const windowByChart = new Map<string, CycleWindow>();
let windowTrace: Trace | null = null;
/** 正在进行的渲染（分片），换文件/重新渲染时取消上一轮 */
let renderToken: { signal: AbortSignal; abort: () => void } | null = null;

function fullWindow(from: number, to: number): CycleWindow {
  return { from, to: to + 1 };
}

function windowFor(key: string, full: CycleWindow): CycleWindow {
  const view = clampWindow(windowByChart.get(key) ?? full, full);
  windowByChart.set(key, view);
  return view;
}

/** 窗口内的采样点（含左端一条，保证折线不断）；`points` 按周期升序 */
function pointsInWindow(points: Point[], view: CycleWindow): Point[] {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.cycle < view.from) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0) lo--;
  const out: Point[] = [];
  for (let i = lo; i < points.length; i++) {
    const point = points[i]!;
    if (point.cycle > view.to) break;
    out.push(point);
  }
  return out;
}

function decimatePoints(points: Point[]): Point[] {
  if (points.length <= MAX_POINTS) return points;
  const stride = Math.ceil(points.length / MAX_POINTS);
  const out: Point[] = [];
  for (let i = 0; i < points.length; i += stride) out.push(points[i]!);
  const last = points[points.length - 1]!;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/** 每周期增量的前缀和（低缩放给 [evt] 折算轨画密度带用） */
interface CountPrefix {
  cycles: number[];
  cum: number[];
}
const prefixCache = new WeakMap<CounterTrack, CountPrefix>();
function prefixOf(track: CounterTrack): CountPrefix {
  const cached = prefixCache.get(track);
  if (cached !== undefined) return cached;
  const cycles = [...track.deltaByCycle.keys()].sort((a, b) => a - b);
  const cum = new Array<number>(cycles.length);
  let running = 0;
  for (let i = 0; i < cycles.length; i++) {
    running += track.deltaByCycle.get(cycles[i]!) ?? 0;
    cum[i] = running;
  }
  const prefix: CountPrefix = { cycles, cum };
  prefixCache.set(track, prefix);
  return prefix;
}

function lowerBound(sorted: number[], v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function countInRange(prefix: CountPrefix, from: number, to: number): number {
  const a = lowerBound(prefix.cycles, from);
  const b = lowerBound(prefix.cycles, to);
  if (b <= a) return 0;
  return prefix.cum[b - 1]! - (a > 0 ? prefix.cum[a - 1]! : 0);
}

/** 一条采样在图上画出来的样子 */
interface Point {
  cycle: number;
  total: number;
  async: boolean;
  /** `abs=` 绝对值回读 */
  abs: boolean;
  line: number;
}

/** 单张图最多画这么多点（超出按步长抽稀，`abs=`/异步点始终保留） */
const MAX_POINTS = 2500;
/** 每周期增量柱状图超过这个柱数就按周期分桶求和 */
const MAX_BARS = 1200;

// ------------------------------------------------------------------ 横轴

interface XGeom {
  x: number;
  y: number;
  width: number;
  height: number;
  from: number;
  to: number;
  domain: DomainInfo | undefined;
  useTime: boolean;
}

interface XAxis {
  /** 周期 → 像素（同步采样落在时钟沿刻度上） */
  px(cycle: number): number;
  /** 像素 → 周期（密度带分列时用） */
  invert(px: number): number;
  /** 一个周期占多少像素 */
  unit(cycle: number): number;
  /** 悬停用的位置标签（周期 + 时间） */
  label(cycle: number): string;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * 横轴一律是**周期数**，不是时刻：每个计数器卡片跟的是它自己时钟域的周期，
 * 多域并排时标 ns 会被误读成同一条时间轴。时刻仍在悬停标签里给（`cycleTime`）。
 */
function drawXAxis(svg: SVGSVGElement, g: XGeom): XAxis {
  const scale = cycleAxis(svg, { x: g.x, y: g.y, width: g.width, height: g.height, from: g.from, to: g.to });
  svg.append(
    svgEl('text', { x: g.x + g.width, y: g.y + g.height + 14, class: 'axis-label axis-title', 'text-anchor': 'end', text: '周期' }),
  );
  return {
    px: (cycle) => scale(cycle),
    invert: (px) => scale.invert(px),
    unit: (cycle) => scale(cycle + 1) - scale(cycle),
    label: (cycle) => cycleTime(g.domain, cycle, g.useTime),
  };
}

/** 卡片、图例、下拉里的显示名：evt 折算来的加前缀，免得跟同名 `[cnt]` 看混 */
const labelOf = (track: CounterTrack): string => (track.source === 'evt' ? `[evt] ${track.name}` : track.name);

/** 卡片列宽：先放同样数量的占位卡片让 auto-fit 定下真实列数，再量列宽（图表至少占满一列） */
function columnWidth(grid: HTMLElement, count: number): number {
  const probes = Array.from({ length: Math.max(1, count) }, () => el('div', { class: 'card', style: 'visibility:hidden;height:0;border:0' }));
  for (const probe of probes) grid.append(probe);
  const width = probes[0]!.clientWidth - 32;
  for (const probe of probes) probe.remove();
  return Math.max(300, width);
}

/** 采样点按位置排序（`at=` 允许乱序，spec §6.3） */
function orderedPoints(track: CounterTrack): Point[] {
  const points: Point[] = track.samples.map((s) => ({
    cycle: s.pos.cycle,
    total: s.total,
    async: s.async,
    abs: s.delta === null,
    line: s.line,
  }));
  points.sort((a, b) => a.cycle - b.cycle || a.line - b.line);
  return points;
}

/** 抽稀：保留首尾与所有特殊点 */
function decimate(points: Point[]): Point[] {
  if (points.length <= MAX_POINTS) return points;
  const stride = Math.ceil(points.length / MAX_POINTS);
  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (i % stride === 0 || p.abs || p.async || i === points.length - 1) out.push(p);
  }
  return out;
}

// ------------------------------------------------------------------ 图元

/** 悬停 + 广播 hover 高亮（`hoverTarget` 只做提示，选中态走 selectionBus） */
function bindHover<T extends Element>(node: T, ctx: ViewContext, sel: Selection, render: () => string): T {
  hoverTarget(node, render);
  node.addEventListener('mouseenter', () => ctx.selection.hover(sel));
  node.addEventListener('mouseleave', () => ctx.selection.hover(null));
  return node;
}

function clickable<T extends HTMLElement | SVGElement>(node: T, onClick: () => void): T {
  node.style.cursor = 'pointer';
  node.addEventListener('click', onClick);
  return node;
}

// ------------------------------------------------------------------ 小卡

function statsRow(tracks: CounterTrack[], shown: CounterTrack[]): HTMLElement {
  let samples = 0;
  let absCount = 0;
  let asyncCount = 0;
  let deltaSum = 0;
  let cntTracks = 0;
  let evtTracks = 0;
  for (const track of tracks) {
    if (track.source === 'evt') evtTracks++;
    else cntTracks++;
    for (const sample of track.samples) {
      // 异步是"记录不在时钟沿上"，两种来源都算；其余口径只对真 `[cnt]` 记录有意义
      if (sample.async) asyncCount++;
      if (track.source === 'evt') continue;
      samples++;
      if (sample.delta === null) absCount++;
      else deltaSum += sample.delta;
    }
  }
  return el('div', { class: 'stat-row' }, [
    statTile('计数器', countLabel(cntTracks), '每个 (域, 名字) 一条 cnt 轨道'),
    statTile('事件计数', countLabel(evtTracks), '每个 [evt] 轨道按"每条 +1"折算（spec §9.1）'),
    statTile('cnt 记录', countLabel(samples), '每条 cnt 记录一次采样'),
    statTile('abs= 回读', countLabel(absCount), '只置总量，不贡献增量（spec §9.2）'),
    statTile('Δ 合计', countLabel(deltaSum), '所有 delta 之和（不含 abs= 回读）'),
    statTile('异步记录', countLabel(asyncCount), shown.length === tracks.length ? '不在时钟沿上（spec §6.7），cnt/evt 都算' : `当前筛选显示 ${countLabel(shown.length)} 条轨道`),
  ]);
}

// ------------------------------------------------------------------ 累计曲线

function cumulativeCard(track: CounterTrack, dom: DomainInfo | undefined, useTime: boolean, ctx: ViewContext, available: number): HTMLElement {
  const chartKey = `cum:${track.key}`;
  const points = orderedPoints(track);
  const color = colorFor(track.key);
  const absCount = points.filter((p) => p.abs).length;
  const node = card(labelOf(track), `${track.source === 'evt' ? '[evt] 轨（每条事件算一次 +1）· ' : ''}${track.domain} · ${fmtInt(track.samples.length)} 条采样 · 终值 ${countLabel(track.total)}`, [
    (() => {
      const btn = el('button', { class: 'btn btn-ghost', text: '详情' });
      btn.addEventListener('click', () => inspectCounter(track, ctx));
      return btn;
    })(),
  ]);

  if (points.length === 0) {
    node.body.append(emptyState('该计数器没有采样'));
    return node.root;
  }

  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    min = Math.min(min, p.total);
    max = Math.max(max, p.total);
  }
  if (min === max) {
    const slack = Math.max(1, Math.abs(max) * 0.1);
    min -= slack;
    max += slack;
  }
  const full = fullWindow(points[0]!.cycle, points[points.length - 1]!.cycle);
  const holder = el('div', { class: 'chart-frame', 'data-key': chartKey });
  const draw = (): void => {
    clear(holder);
    holder.append(buildCumulativeSvg(track, points, full, windowFor(chartKey, full), min, max, dom, useTime, available, color, ctx));
  };
  draw();
  installChartViewport(holder, {
    full: () => full,
    get: () => windowFor(chartKey, full),
    set: (w) => windowByChart.set(chartKey, clampWindow(w, full)),
    redraw: draw,
  });
  node.body.append(holder);

  const dotted = el('div', { class: 'row muted', style: 'font-size:11px;gap:12px' }, [
    el('span', { text: `${fmtInt(points.length)} 条采样` }),
    track.source === 'evt' ? el('span', { text: '[evt] 轨：每条事件算一次 +1；缩得很小时画成密度带' }) : null,
    absCount > 0 ? el('span', { text: `○ 空心黄点 = abs= 回读（${fmtInt(absCount)} 次）` }) : null,
    el('span', { text: '虚线空心点 = 异步记录（不在时钟沿上）' }),
    el('span', { text: '横向滚轮平移 · Ctrl/⌘ + 滚轮缩放' }),
  ]);
  node.body.append(dotted);
  return node.root;
}

/**
 * 累计曲线（窗口式，画布宽度 = 列宽）。
 * 低缩放且是 `[evt]` 折算轨时改成**每周期事件频率密度带**；否则画累计折线（窗口内抽稀）。
 */
function buildCumulativeSvg(
  track: CounterTrack,
  points: Point[],
  full: CycleWindow,
  view: CycleWindow,
  min: number,
  max: number,
  dom: DomainInfo | undefined,
  useTime: boolean,
  available: number,
  color: string,
  ctx: ViewContext,
): SVGSVGElement {
  const height = 150;
  const pad = { ...AXIS_PAD, top: 12, bottom: 20 };
  const width = available;
  const svg = svgRoot(width, height);
  const plot = { x: pad.left, y: pad.top, width: width - pad.left - pad.right, height: height - pad.top - pad.bottom };
  const span = Math.max(1e-9, view.to - view.from);
  const x = drawXAxis(svg, { ...plot, from: view.from, to: view.to, domain: dom, useTime });
  const ys = linearScale(min, max, plot.y + plot.height, plot.y);
  const at = (p: Point): number => clamp(p.async ? x.px(p.cycle) + 0.5 * x.unit(p.cycle) : x.px(p.cycle), plot.x - 24, plot.x + plot.width + 24);
  void full;

  const hit = svgEl('rect', { x: plot.x, y: plot.y, width: plot.width, height: plot.height, fill: 'transparent', 'pointer-events': 'all' });
  clickable(hit, () => ctx.selection.set({ kind: 'counter', key: track.key }));
  svg.append(hit);

  const pxPerCycle = plot.width / span;
  if (pxPerCycle < LOD_LINE_PX && track.source === 'evt') {
    // [evt] 折算轨：低缩放画每周期事件频率密度带
    const prefix = prefixOf(track);
    const cols = Math.max(1, Math.min(2000, Math.round(plot.width)));
    const counts = new Array<number>(cols).fill(0);
    let maxCount = 0;
    for (let i = 0; i < cols; i++) {
      const c0 = x.invert(plot.x + (plot.width * i) / cols);
      const c1 = x.invert(plot.x + (plot.width * (i + 1)) / cols);
      const n = countInRange(prefix, c0, c1);
      counts[i] = n;
      if (n > maxCount) maxCount = n;
    }
    if (maxCount > 0) {
      const alphaOf = (n: number): number => clamp(n / maxCount, 0.12, 0.95);
      let i = 0;
      while (i < cols) {
        if (counts[i] === 0) {
          i++;
          continue;
        }
        const alpha = alphaOf(counts[i]!);
        let j = i + 1;
        while (j < cols && counts[j]! > 0 && Math.abs(alphaOf(counts[j]!) - alpha) < 0.04) j++;
        const xa = plot.x + (plot.width * i) / cols;
        const xb = plot.x + (plot.width * j) / cols;
        svg.append(
          svgEl('rect', { x: xa, y: plot.y, width: Math.max(0.5, xb - xa), height: plot.height, fill: color, 'fill-opacity': alpha, 'pointer-events': 'none' }),
        );
        i = j;
      }
    }
    svg.append(svgEl('text', { x: plot.x, y: plot.y + 10, class: 'axis-label', text: '[evt] 密度带：颜色越深 = 该时段事件越密' }));
    return svg;
  }

  numericAxis(svg, { ...plot, min, max, label: '累计值' });
  const windowed = pointsInWindow(points, view);
  const drawn = decimatePoints(windowed);
  if (drawn.length >= 2) {
    svg.append(
      svgEl('path', {
        d: drawn.map((p) => `${at(p)},${ys(p.total)}`).map((s, i) => `${i === 0 ? 'M' : 'L'}${s}`).join(''),
        fill: 'none',
        stroke: color,
        'stroke-width': 1.6,
        'stroke-linejoin': 'round',
      }),
    );
  }
  // 低缩放不画标记（节点预算）；放大后再标 abs=/异步/首尾点
  if (pxPerCycle >= LOD_LINE_PX) {
    for (const p of windowed) {
      if (!p.abs && !p.async && p !== points[0] && p !== points[points.length - 1]) continue;
      const marker = svgEl('circle', {
        cx: at(p),
        cy: ys(p.total),
        r: 3.6,
        fill: 'var(--surface)',
        stroke: p.abs ? 'var(--warn)' : color,
        'stroke-width': 1.8,
        ...(p.async ? { 'stroke-dasharray': '2 1.6' } : {}),
      });
      const text = () =>
        [
          x.label(p.cycle),
          `累计 ${fmtInt(p.total)}`,
          track.source === 'evt'
            ? '事件记录：每条算一次 +1（spec §9.1）'
            : p.abs
              ? `绝对值回读 abs（spec §9.2，不贡献增量）`
              : '增量采样',
          p.async ? '异步记录：不在时钟沿上，画在周期区间内部（spec §6.7）' : '时钟沿采样',
          `源文件第 ${p.line} 行`,
        ].join('\n');
      bindHover(marker, ctx, { kind: 'counter', key: track.key }, text);
      clickable(marker, () => {
        ctx.selection.set({ kind: 'counter', key: track.key });
        ctx.inspect(`计数器采样 · ${track.name}`, [
          ['位置', x.label(p.cycle)],
          ['周期', String(p.cycle)],
          ['该点累计值', fmtInt(p.total)],
          [
            '记录类型',
            track.source === 'evt' ? '事件记录（每条 +1）' : p.abs ? 'abs= 绝对值回读' : p.async ? '异步增量' : '普通增量',
          ],
          ['源文件行', String(p.line)],
        ]);
      });
      svg.append(marker);
    }
  }
  return svg;
}

function inspectCounter(track: CounterTrack, ctx: ViewContext): void {
  const absCount = track.samples.filter((s) => s.delta === null).length;
  const asyncCount = track.samples.filter((s) => s.async).length;
  const first = track.samples[0];
  const last = track.samples[track.samples.length - 1];
  const body = dataTable(
    ['周期', 'Δ', '累计', '来源', '行'],
    track.samples.slice(-60).map((s) => [
      String(s.pos.cycle),
      s.delta === null ? `abs=${fmtInt(s.abs ?? 0)}` : fmtInt(s.delta),
      fmtInt(s.total),
      s.async ? '异步' : '沿上',
      String(s.line),
    ]),
  );
  ctx.inspect(
    `计数器 · ${track.name}`,
    [
      ['域', track.domain],
      ['来源', track.source === 'evt' ? '由 [evt] 轨道折算：每条事件 +1（spec §9.1）' : '[cnt] 记录'],
      ['追踪键', track.key.replace('\u0000', ' / ')],
      ['终值', fmtInt(track.total)],
      ['采样条数', fmtInt(track.samples.length)],
      ['abs= 回读', fmtInt(absCount)],
      ['异步采样', fmtInt(asyncCount)],
      ['总量变化周期', fmtInt(track.changeCycles.length)],
      ['周期范围', first && last ? `${first.pos.cycle} – ${last.pos.cycle}` : '—'],
      ['总量', `Σdelta = ${fmtInt([...track.deltaByCycle.values()].reduce((a, b) => a + b, 0))}`],
    ],
    body,
  );
}

// ------------------------------------------------------------------ 每周期增量

function deltaCard(tracks: CounterTrack[], ctx: ViewContext, useTime: boolean, available: number, jobs: (() => void)[]): HTMLElement {
  const node = card('每周期增量', '柱高 = Σdelta（`abs=` 回读不贡献增量，spec §9.2）');
  const shown = tracks.filter((t) => t.deltaByCycle.size > 0);
  if (shown.length === 0) {
    node.body.append(emptyState('没有增量记录（所有采样都是 abs= 回读）'));
    return node.root;
  }
  const groups = el('div', { class: 'col' });
  for (const track of shown) jobs.push(() => groups.append(deltaChart(track, ctx, useTime, available)));
  node.body.append(groups);
  return node.root;
}

function deltaChart(track: CounterTrack, ctx: ViewContext, useTime: boolean, available: number): HTMLElement {
  const chartKey = `delta:${track.key}`;
  const color = colorFor(track.key);
  const dom = ctx.trace.domains.get(track.domain);
  const cycles = [...track.deltaByCycle.keys()].sort((a, b) => a - b);
  const first = cycles[0]!;
  const last = cycles[cycles.length - 1]!;
  let min = 0;
  let max = 0;
  for (const cycle of cycles) {
    const v = track.deltaByCycle.get(cycle)!;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === 0 && max === 0) max = 1;
  const full = fullWindow(first, last);
  const holder = el('div', { class: 'chart-frame', 'data-key': chartKey });
  const draw = (): void => {
    clear(holder);
    holder.append(buildDeltaSvg(track, cycles, full, windowFor(chartKey, full), min, max, dom, useTime, available, color, ctx));
  };
  draw();
  installChartViewport(holder, {
    full: () => full,
    get: () => windowFor(chartKey, full),
    set: (w) => windowByChart.set(chartKey, clampWindow(w, full)),
    redraw: draw,
  });
  const deltaSum = [...track.deltaByCycle.values()].reduce((a, b) => a + b, 0);
  return el('div', {}, [
    el('div', { class: 'row' }, [
      el('span', { class: 'mono', text: labelOf(track) }),
      el('span', { class: 'badge', text: track.domain }),
      el('span', { class: 'badge', text: `Δ合计 ${countLabel(deltaSum)}` }),
      el('span', { class: 'badge', text: `${fmtInt(cycles.length)} 个周期有增量` }),
    ]),
    holder,
  ]);
}

/** 每周期增量（窗口式）。低缩放时按像素列分桶求和，柱数钉在一屏像素量级 */
function buildDeltaSvg(
  track: CounterTrack,
  cycles: number[],
  full: CycleWindow,
  view: CycleWindow,
  min: number,
  max: number,
  dom: DomainInfo | undefined,
  useTime: boolean,
  available: number,
  color: string,
  ctx: ViewContext,
): SVGSVGElement {
  const height = 118;
  const pad = { ...AXIS_PAD, top: 10, bottom: 20 };
  const width = available;
  const svg = svgRoot(width, height);
  const plot = { x: pad.left, y: pad.top, width: width - pad.left - pad.right, height: height - pad.top - pad.bottom };
  const span = Math.max(1e-9, view.to - view.from);
  const x = drawXAxis(svg, { ...plot, from: view.from, to: view.to, domain: dom, useTime });
  numericAxis(svg, { ...plot, min, max, label: 'Δ/周期' });
  const ys = linearScale(min, max, plot.y + plot.height, plot.y);
  const zero = ys(0);
  void full;

  const hit = svgEl('rect', { x: plot.x, y: plot.y, width: plot.width, height: plot.height, fill: 'transparent', 'pointer-events': 'all' });
  clickable(hit, () => ctx.selection.set({ kind: 'counter', key: track.key }));
  svg.append(hit);

  const pxPerCycle = plot.width / span;
  const bucket = pxPerCycle < 2 ? Math.max(1, Math.ceil(span / Math.max(1, plot.width))) : 1;
  const bars = new Map<number, { sum: number; from: number; to: number; count: number }>();
  const a = lowerBound(cycles, view.from);
  const b = lowerBound(cycles, view.to);
  for (let i = a; i < b; i++) {
    const cycle = cycles[i]!;
    const key = bucket === 1 ? cycle : Math.floor(cycle / bucket) * bucket;
    const slot = bars.get(key) ?? { sum: 0, from: cycle, to: cycle, count: 0 };
    slot.sum += track.deltaByCycle.get(cycle)!;
    slot.from = Math.min(slot.from, cycle);
    slot.to = Math.max(slot.to, cycle);
    slot.count++;
    bars.set(key, slot);
  }

  for (const [key, slot] of [...bars].sort((p, q) => p[0] - q[0])) {
    const xa = x.px(slot.from);
    const w = bucket === 1 ? Math.max(1, x.unit(slot.from) - 1) : Math.max(1, x.px(slot.from + bucket) - xa - 1);
    const y = slot.sum >= 0 ? ys(slot.sum) : zero;
    const rect = svgEl('rect', {
      ...barRect(xa, y, w, Math.max(1, Math.abs(zero - ys(slot.sum)))),
      fill: color,
      opacity: 0.8,
      rx: 1.5,
    });
    const totalAt = counterTotalAt(track, slot.to);
    bindHover(rect, ctx, { kind: 'counter', key: track.key }, () =>
      [
        slot.from === slot.to ? x.label(slot.from) : `${x.label(slot.from)} – 周期 ${slot.to}`,
        `Δ = ${fmtInt(slot.sum)}（${fmtInt(slot.count)} 个周期）`,
        `周期末累计 = ${totalAt === null ? '—' : fmtInt(totalAt)}`,
        'abs= 回读不贡献增量（spec §9.2）',
      ].join('\n'),
    );
    svg.append(rect);
  }
  return svg;
}

// ------------------------------------------------------------------ 终值占比

function pie(items: { key: string; label: string; value: number; color: string }[], size: number, onPick: (key: string) => void): SVGSVGElement {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const svg = svgRoot(size, size);
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 8;
  if (items.length === 1 || total <= 0) {
    const only = items[0];
    const circle = svgEl('circle', { cx, cy, r, fill: only ? only.color : 'var(--border)' });
    if (only) {
      hoverTarget(circle, () => `${only.label}\n${fmtInt(only.value)}（100.0%）`);
      clickable(circle, () => onPick(only.key));
    }
    svg.append(circle);
    return svg;
  }
  let angle = -Math.PI / 2;
  for (const item of items) {
    const sweep = (item.value / total) * Math.PI * 2;
    const x0 = cx + r * Math.cos(angle);
    const y0 = cy + r * Math.sin(angle);
    const x1 = cx + r * Math.cos(angle + sweep);
    const y1 = cy + r * Math.sin(angle + sweep);
    const path = svgEl('path', {
      d: `M${cx},${cy}L${x0.toFixed(2)},${y0.toFixed(2)}A${r},${r} 0 ${sweep > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)}Z`,
      fill: item.color,
      stroke: 'var(--surface)',
      'stroke-width': 1,
    });
    hoverTarget(path, () => `${item.label}\n终值 ${fmtInt(item.value)}\n占比 ${((item.value / total) * 100).toFixed(1)}%\n点击查看详情`);
    clickable(path, () => onPick(item.key));
    svg.append(path);
    angle += sweep;
  }
  return svg;
}

function shareCard(tracks: CounterTrack[], ctx: ViewContext): HTMLElement {
  const node = card('终值占比', '按域分组，饼块 = 计数器终值（只统计终值为正的计数器）');
  const groups = new Map<string, CounterTrack[]>();
  for (const track of tracks) {
    const list = groups.get(track.domain);
    if (list) list.push(track);
    else groups.set(track.domain, [track]);
  }
  if (groups.size === 0) {
    node.body.append(emptyState('没有可统计的计数器'));
    return node.root;
  }
  const grid = el('div', { class: 'grid grid-3' });
  for (const [domain, list] of groups) {
    const items = list
      .filter((t) => t.total > 0)
      .sort((a, b) => b.total - a.total)
      .map((t) => ({ key: t.key, label: labelOf(t), value: t.total, color: colorFor(t.key) }));
    const total = items.reduce((sum, item) => sum + item.value, 0);
    const block = el('div', {}, [
      el('div', { class: 'row' }, [
        el('span', { class: 'badge', text: domain }),
        el('span', { class: 'muted', text: `合计 ${countLabel(total)}` }),
      ]),
      items.length > 0 ? pie(items, 168, (key) => ctx.selection.set({ kind: 'counter', key })) : emptyState('该域没有正终值的计数器'),
      items.length > 0
        ? legend(items.map((item) => ({ label: item.label, color: item.color, value: `${((item.value / total) * 100).toFixed(1)}%` })))
        : null,
    ]);
    grid.append(block);
  }
  node.body.append(grid);
  return node.root;
}

// ------------------------------------------------------------------ 区间差（delta_between）

function intervalCard(tracks: CounterTrack[], ctx: ViewContext, range: { from: number; to: number }): HTMLElement {
  const node = card(
    '区间差 / 比率',
    'delta_between(c1, c2) 与 ratio_between：区间两端都取"该周期末"的累计值（spec §9.2）；默认区间 = 各计数器都有采样的范围',
  );
  const fromInput = el('input', {
    type: 'number',
    value: String(range.from),
    style: 'width:90px;padding:4px 6px;border:1px solid var(--border-strong);border-radius:6px;background:var(--surface);color:var(--text);font:inherit;font-size:12px',
  });
  const toInput = el('input', {
    type: 'number',
    value: String(range.to),
    style: 'width:90px;padding:4px 6px;border:1px solid var(--border-strong);border-radius:6px;background:var(--surface);color:var(--text);font:inherit;font-size:12px',
  });
  const selectStyle = 'padding:4px 6px;border:1px solid var(--border-strong);border-radius:6px;background:var(--surface);color:var(--text);font:inherit;font-size:12px';
  const numSel = el('select', { style: selectStyle });
  const denSel = el('select', { style: selectStyle });
  for (const track of tracks) {
    numSel.append(el('option', { value: track.key, text: labelOf(track) }));
    denSel.append(el('option', { value: track.key, text: labelOf(track) }));
  }
  numSel.value = tracks[0]?.key ?? '';
  denSel.value = tracks[1]?.key ?? tracks[0]?.key ?? '';

  const host = el('div', {});
  const render = () => {
    clear(host);
    const rawFrom = fromInput.value.trim();
    const rawTo = toInput.value.trim();
    const parsedFrom = Number(rawFrom);
    const parsedTo = Number(rawTo);
    if (rawFrom === '' || rawTo === '' || !Number.isFinite(parsedFrom) || !Number.isFinite(parsedTo)) {
      host.append(emptyState('请输入整数周期：区间为左开右闭 (c1, c2]'));
      return;
    }
    const c1 = Math.trunc(parsedFrom);
    const c2 = Math.trunc(parsedTo);
    const deltas = tracks.map((track) => ({ track, delta: counterDeltaBetween(track, c1, c2) }));
    const sum = deltas.reduce((acc, item) => acc + (item.delta ?? 0), 0);
    const rows = deltas.map(({ track, delta }) => {
      const t1 = counterTotalAt(track, c1);
      const t2 = counterTotalAt(track, c2);
      const share = delta !== null && sum !== 0 ? `${((delta / sum) * 100).toFixed(1)}%` : '—';
      const name = el('button', { class: 'btn btn-ghost mono', text: labelOf(track), style: 'padding:0;font-size:12px' });
      name.addEventListener('click', () => {
        ctx.selection.set({ kind: 'counter', key: track.key });
        inspectCounter(track, ctx);
      });
      return [name, track.domain, t1 === null ? '—' : fmtInt(t1), t2 === null ? '—' : fmtInt(t2), delta === null ? '—' : fmtInt(delta), share, fmtInt(track.total)];
    });
    host.append(dataTable(['计数器', '域', `累计@${c1}`, `累计@${c2}`, `Δ(${c1}, ${c2}]`, '占 Δ 合计', '终值'], rows));

    const num = tracks.find((t) => t.key === numSel.value);
    const den = tracks.find((t) => t.key === denSel.value);
    const ratio = num && den ? ratioBetween(num, den, c1, c2) : null;
    host.append(
      el('div', { class: 'row' }, [
        el('span', { class: 'muted', text: '比率' }),
        el('code', { class: 'mono', text: num && den ? `${num.name} / ${den.name}` : '—' }),
        el('b', { text: ratio === null ? '—' : `${ratio.toFixed(4)}（${(ratio * 100).toFixed(2)}%）` }),
        ratio === null ? el('span', { class: 'muted', text: '分母增量为 0 或区间内没有采样' }) : null,
      ]),
    );
  };

  for (const input of [fromInput, toInput]) input.addEventListener('change', render);
  for (const select of [numSel, denSel]) select.addEventListener('change', render);
  node.body.append(
    el('div', { class: 'row' }, [
      el('span', { class: 'toolbar-label', text: '从周期' }),
      fromInput,
      el('span', { class: 'toolbar-label', text: '到周期' }),
      toInput,
      el('span', { class: 'toolbar-label', text: '分子' }),
      numSel,
      el('span', { class: 'toolbar-label', text: '分母' }),
      denSel,
    ]),
    host,
  );
  render();
  return node.root;
}

// ------------------------------------------------------------------ 视图

let containerRef: HTMLElement | null = null;
let unsubscribe: (() => void) | null = null;
/** 追踪键 → 需要随选中态高亮的节点 */
const highlights = new Map<string, HTMLElement[]>();

function highlight(selection: Selection): void {
  const key = selection && selection.kind === 'counter' ? selection.key : null;
  for (const [trackKey, nodes] of highlights) {
    const on = key === trackKey;
    for (const node of nodes) node.style.outline = on ? '2px solid var(--accent)' : '';
  }
}

function render(ctx: ViewContext): void {
  if (!containerRef) return;
  // 取消上一轮还没建完的卡片
  renderToken?.abort();
  const token = abortable();
  renderToken = token;
  clear(containerRef);
  highlights.clear();
  if (windowTrace !== ctx.trace) {
    windowTrace = ctx.trace;
    windowByChart.clear();
  }
  const all = [...ctx.trace.counters.values(), ...eventCounters(ctx.trace)];
  const shown = all
    .filter((t) => ctx.options.domains.length === 0 || ctx.options.domains.includes(t.domain))
    .sort((a, b) => (a.domain === b.domain ? a.name.localeCompare(b.name) : a.domain.localeCompare(b.domain)));

  if (shown.length === 0) {
    const node = card('计数器');
    node.body.append(emptyState(all.length === 0 ? '这份轨迹没有 cnt 记录，也没有 evt 记录' : '当前时钟域筛选下没有计数器'));
    containerRef.append(node.root);
    return;
  }

  // 默认区间：`from` 取"最晚的首个采样周期"（此后每个计数器都有累计值），`to` 取最晚的采样周期。
  // 这段扫描放到分片任务里做，别在首屏同步遍历所有采样。
  const defaultRange = (): { from: number; to: number } => {
    let from = Number.NEGATIVE_INFINITY;
    let to = Number.NEGATIVE_INFINITY;
    let earliest = Number.POSITIVE_INFINITY;
    for (const track of shown) {
      let first = Number.POSITIVE_INFINITY;
      let last = Number.NEGATIVE_INFINITY;
      for (const sample of track.samples) {
        first = Math.min(first, sample.pos.cycle);
        last = Math.max(last, sample.pos.cycle);
        earliest = Math.min(earliest, sample.pos.cycle);
      }
      if (Number.isFinite(first)) from = Math.max(from, first);
      if (Number.isFinite(last)) to = Math.max(to, last);
    }
    if (!Number.isFinite(from) || from > to) from = Number.isFinite(earliest) ? earliest : 0;
    if (!Number.isFinite(to)) to = from;
    return { from, to };
  };
  const useTime = ctx.options.useTimeAxis;

  const summary = card('总览', '按当前时钟域筛选');
  containerRef.append(summary.root);

  const charts = el('div', { class: 'grid grid-2' });
  containerRef.append(charts);
  const available = columnWidth(charts, shown.length);
  const jobs: (() => void)[] = [() => summary.body.append(statsRow(all, shown))];
  for (const track of shown) {
    jobs.push(() => {
      const dom = ctx.trace.domains.get(track.domain);
      const node = cumulativeCard(track, dom, useTime, ctx, available);
      const list = highlights.get(track.key) ?? [];
      list.push(node);
      highlights.set(track.key, list);
      charts.append(node);
    });
  }
  const deltaAvailable = Math.max(300, containerRef.clientWidth - 32);
  containerRef.append(deltaCard(shown, ctx, useTime, deltaAvailable, jobs));
  jobs.push(() => containerRef!.append(shareCard(shown, ctx)));
  jobs.push(() => containerRef!.append(intervalCard(shown, ctx, defaultRange())));

  // 逐条轨分片建卡：卡片多/采样多时不会一次性堵住主线程
  void runChunked(
    jobs.length,
    (from, to) => {
      for (let i = from; i < to; i++) jobs[i]!();
    },
    {
      signal: token.signal,
      budgetMs: 8,
      batch: 1,
      onProgress: (done, total) => {
        if (done === total) highlight(ctx.selection.get());
      },
    },
  );
  highlight(ctx.selection.get());
}

export const countersView: View = {
  id: 'counters',
  title: '计数器',
  hint: '累计曲线、每周期增量、比率；[evt] 按每条 +1 与计数器一起展示，Ctrl/⌘ + 滚轮缩放、横向滚轮平移',
  mount(container, ctx) {
    // app.ts 每次重挂载都会新建容器：先退订上一次，避免监听器累积
    unsubscribe?.();
    unsubscribe = null;
    containerRef = container;
    unsubscribe = ctx.selection.subscribe((selection) => highlight(selection));
    render(ctx);
  },
  refresh(ctx, reason) {
    if (reason === 'options') render(ctx);
    else highlight(ctx.selection.get());
  },
  unmount() {
    unsubscribe?.();
    unsubscribe = null;
    renderToken?.abort();
    renderToken = null;
    containerRef = null;
    highlights.clear();
  },
};

export default countersView;
