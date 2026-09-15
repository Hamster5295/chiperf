/**
 * 数值视图 —— 保持型阶梯波形与变化事件（spec §9.3）
 *
 * 三条必须守住的口径：
 *  - 数值轨是**保持型**：一次采样后保持到下一次采样，画成阶梯（`stepPath`）
 *  - 含 `x`/`z` 的采样（`hasXZ`，如 `4'b10xz`、裸词 `x`）不是数字：空心/斜纹标记 + 原始字面量
 *  - `async=1` 的采样不在时钟沿上，必须画在所在周期的区间**内部**（spec §6.7）
 *  - 字符串/符号（`str`/`sym`）不做强行坐标化：改成事件条 + 历史列表
 */
import type { DomainInfo, ScalarValue, Timed, Trace, ValueTrack } from '../../../parser/src/index.ts';
import { comparePosition } from '../../../parser/src/index.ts';
import {
  card,
  clear,
  colorFor,
  countLabel,
  cycleAxis,
  dataTable,
  el,
  emptyState,
  hoverTarget,
  linearScale,
  numericAxis,
  statTile,
  stepPath,
  svgEl,
  svgRoot,
} from '../charts.ts';
import { cycleTime, fmtInt, fmtValue, type Selection, type View, type ViewContext } from '../view.ts';

/** 保持型信号的一个采样点 */
interface Item {
  sample: Timed<ScalarValue>;
  cycle: number;
  /** 数值表示；null = 含未知位或不是数字 */
  num: number | null;
  async: boolean;
  changed: boolean;
}

/** 未知（含 `x`/`z`）区间 */
interface Gap {
  start: number;
  end: number;
  items: Item[];
  prev: Item | null;
  next: Item | null;
}

/** 单张波形最多画这么多采样（超出按周期分桶抽稀，变化点与未知点始终保留） */
const MAX_STEPS = 3000;
const HISTORY_ROWS = 200;

// ------------------------------------------------------------------ 取值

/** 采样值的数值表示：`int`/`real`/`bits`（无 x/z）/`scaled` 可坐标化，含 x/z 或字符串则不可 */
function numericOf(value: ScalarValue): number | null {
  if (value.num !== undefined) return value.num;
  if (value.big !== undefined) return Number(value.big);
  if (value.scale !== undefined) return value.scale;
  return null;
}

function kindLabel(value: ScalarValue): string {
  if (value.kind === 'bits') return value.hasXZ ? 'bits（含未知位 x/z）' : `bits${value.width !== undefined ? `(${value.width} 位)` : ''}`;
  return value.kind;
}

/** `Timed` 不带行号：按记录序号建一次索引（seq 全局唯一，spec §6.3） */
let lineIndex: { trace: Trace; lines: Map<number, number> } | null = null;

function lineOf(trace: Trace, seq: number): number {
  if (lineIndex === null || lineIndex.trace !== trace) {
    const lines = new Map<number, number>();
    for (const record of trace.records) lines.set(record.seq, record.line);
    lineIndex = { trace, lines };
  }
  return lineIndex.lines.get(seq) ?? 0;
}

/** 值 → 图上用的短文本 */
function shortText(value: ScalarValue): string {
  const text = fmtValue(value);
  return text.length > 22 ? `${text.slice(0, 21)}…` : text;
}

// ------------------------------------------------------------------ 横轴

interface XGeom {
  x: number;
  y: number;
  width: number;
  height: number;
  from: number;
  to: number;
  domain: DomainInfo | undefined;
}

interface XAxis {
  px(cycle: number): number;
  unit(cycle: number): number;
}

/**
 * 横轴一律是**周期数**，不是时刻：每条数值轨跟的是它自己时钟域的周期，
 * 多域并排时标 ns 会被误读成同一条时间轴。时刻仍在悬停标签里给（`sampleLines`）。
 */
function drawXAxis(svg: SVGSVGElement, g: XGeom): XAxis {
  const scale = cycleAxis(svg, { x: g.x, y: g.y, width: g.width, height: g.height, from: g.from, to: g.to });
  svg.append(
    svgEl('text', { x: g.x + g.width, y: g.y + g.height + 14, class: 'axis-label axis-title', 'text-anchor': 'end', text: '周期' }),
  );
  return { px: (cycle) => scale(cycle), unit: (cycle) => scale(cycle + 1) - scale(cycle) };
}

// ------------------------------------------------------------------ 公共小件

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

/** 空心/斜纹标记：含未知位（x/z）的采样用这个形状，与实心实测点一眼区分 */
function unknownMarker(x: number, y: number): SVGGElement {
  const group = svgEl('g', {});
  group.append(
    svgEl('polygon', {
      points: `${x},${y - 4.5} ${x + 4.5},${y} ${x},${y + 4.5} ${x - 4.5},${y}`,
      fill: 'var(--surface)',
      stroke: 'var(--warn)',
      'stroke-width': 1.6,
    }),
    svgEl('line', { x1: x - 3, y1: y + 3, x2: x + 3, y2: y - 3, stroke: 'var(--warn)', 'stroke-width': 1.1 }),
  );
  return group;
}

/** 未知区间的斜纹底：整段阴影 + 45° 斜线（x/z 的"值未知"是区间语义） */
function unknownBand(parent: SVGSVGElement, g: Gap, plot: { x: number; y: number; width: number; height: number }): void {
  const left = Math.max(plot.x, g.start);
  const right = Math.min(plot.x + plot.width, g.end);
  const width = right - left;
  if (width <= 0.5) return;
  const group = svgEl('g', {});
  group.append(
    svgEl('rect', {
      x: left,
      y: plot.y,
      width,
      height: plot.height,
      fill: 'var(--surface-2)',
      stroke: 'var(--border-strong)',
      'stroke-dasharray': '3 3',
      opacity: 0.7,
    }),
  );
  // 45° 斜线 x = left + o + s、y = plot.y + height - s，按矩形边界裁剪参数 s
  const step = Math.max(9, (width + plot.height) / 60);
  for (let o = -plot.height; o <= width; o += step) {
    const s1 = Math.max(0, -o);
    const s2 = Math.min(plot.height, width - o);
    if (s2 - s1 < 1) continue;
    group.append(
      svgEl('line', {
        x1: left + o + s1,
        y1: plot.y + plot.height - s1,
        x2: left + o + s2,
        y2: plot.y + plot.height - s2,
        stroke: 'var(--border-strong)',
        'stroke-width': 1,
      }),
    );
  }
  parent.append(group);
}

/** 图宽：至少占满卡片列宽，周期跨度大时再放宽（由 .chart-scroll 横向滚动） */
function chartWidth(span: number, available: number): number {
  return Math.max(available, Math.min(3000, span * 12 + 100));
}

/** 卡片列宽：先放同样数量的占位卡片让 auto-fit 定下真实列数，再量列宽（图表至少占满一列） */
function columnWidth(grid: HTMLElement, count: number): number {
  const probes = Array.from({ length: Math.max(1, count) }, () => el('div', { class: 'card', style: 'visibility:hidden;height:0;border:0' }));
  for (const probe of probes) grid.append(probe);
  const width = probes[0]!.clientWidth - 32;
  for (const probe of probes) probe.remove();
  return Math.max(300, width);
}

/** 采样点的统一提示文本（未知点、变化点、事件条共用同一口径） */
function sampleLines(track: ValueTrack, item: Item, prev: Timed<ScalarValue> | null, ctx: ViewContext, useTime: boolean, note?: string): string {
  const lines = [cycleTime(ctx.trace.domains.get(track.domain), item.cycle, useTime)];
  if (prev) lines.push(`${fmtValue(prev.value)} → ${fmtValue(item.sample.value)}`);
  else lines.push(`值 ${fmtValue(item.sample.value)}（${kindLabel(item.sample.value)}）`);
  if (item.sample.value.hasXZ) lines.push(`含未知位 x/z，不是数字：原始字面量 ${item.sample.value.raw}`);
  if (item.changed) lines.push('取值发生变化（与上一次采样不同）');
  if (note) lines.push(note);
  lines.push(item.async ? '异步记录：不在时钟沿上，画在周期区间内部（spec §6.7）' : '时钟沿采样');
  lines.push(`源文件第 ${lineOf(ctx.trace, item.sample.pos.seq)} 行`);
  return lines.join('\n');
}

// ------------------------------------------------------------------ 阶梯波形

function waveformCard(track: ValueTrack, ctx: ViewContext, useTime: boolean, available: number): HTMLElement {
  const color = colorFor(track.key);
  const sorted = [...track.samples].sort((a, b) => comparePosition(a.pos, b.pos));
  // derive.ts 为 changes 另建了对象，不能按引用比较：用位置序号匹配
  const changeSeqs = new Set(track.changes.map((change) => change.pos.seq));
  const items: Item[] = sorted.map((sample) => ({
    sample,
    cycle: sample.pos.cycle,
    num: numericOf(sample.value),
    async: sample.async,
    changed: changeSeqs.has(sample.pos.seq),
  }));
  const kinds = [...new Set(sorted.map((s) => kindLabel(s.value)))];
  const numeric = items.filter((item) => item.num !== null);
  const unknown = items.filter((item) => item.num === null && item.sample.value.hasXZ);

  const node = card(
    track.name,
    `${track.domain} · ${fmtInt(sorted.length)} 条采样 · ${fmtInt(track.changes.length)} 次变化 · ${kinds.join(' / ')}`,
    [
      (() => {
        const btn = el('button', { class: 'btn btn-ghost', text: '详情' });
        btn.addEventListener('click', () => inspectTrack(track, ctx));
        return btn;
      })(),
    ],
  );

  if (sorted.length === 0) {
    node.body.append(emptyState('该数值轨没有采样'));
    return node.root;
  }

  if (numeric.length === 0) {
    node.body.append(el('div', { class: 'chart-scroll' }, [eventBar(track, items, color, useTime, ctx, available)]));
    node.body.append(historyTable(track, items, ctx));
    return node.root;
  }

  const first = items[0]!.cycle;
  const last = items[items.length - 1]!.cycle;
  const height = 168;
  const pad = { left: 58, right: 18, top: 14, bottom: 20 };
  const width = chartWidth(last - first + 1, available);
  const svg = svgRoot(width, height);
  const plot = { x: pad.left, y: pad.top, width: width - pad.left - pad.right, height: height - pad.top - pad.bottom };
  const x = drawXAxis(svg, { ...plot, from: first, to: last, domain: ctx.trace.domains.get(track.domain) });

  let min = Infinity;
  let max = -Infinity;
  for (const item of numeric) {
    min = Math.min(min, item.num!);
    max = Math.max(max, item.num!);
  }
  if (min === max) {
    const slack = Math.max(1, Math.abs(max) * 0.05);
    min -= slack;
    max += slack;
  }
  numericAxis(svg, { ...plot, min, max, label: '值' });
  const ys = linearScale(min, max, plot.y + plot.height, plot.y);
  /** 同步采样贴沿刻度；异步采样落到周期区间内部（spec §6.7） */
  const at = (item: Item) => x.px(item.cycle) + (item.async ? 0.5 * x.unit(item.cycle) : 0);

  const hit = svgEl('rect', { x: plot.x, y: plot.y, width: plot.width, height: plot.height, fill: 'transparent', 'pointer-events': 'all' });
  clickable(hit, () => ctx.selection.set({ kind: 'value', key: track.key }));
  svg.append(hit);

  // 分段：连续已知段画实线阶梯，未知段画斜纹底 + 虚线跨接
  const drawn = numeric.length > MAX_STEPS ? downsample(items, last - first + 1) : items;
  const runs: Item[][] = [];
  const gaps: Gap[] = [];
  let run: Item[] = [];
  let gap: Gap | null = null;
  let lastKnown: Item | null = null;
  for (const item of drawn) {
    if (item.num === null) {
      if (run.length > 0) {
        runs.push(run);
        run = [];
      }
      const px = at(item);
      if (gap === null) gap = { start: px, end: px, items: [item], prev: lastKnown, next: null };
      else {
        gap.end = px;
        gap.items.push(item);
      }
      continue;
    }
    if (gap !== null) {
      gap.end = at(item);
      gap.next = item;
      gaps.push(gap);
      gap = null;
    }
    run.push(item);
    lastKnown = item;
  }
  if (run.length > 0) runs.push(run);
  if (gap !== null) {
    gap.end = plot.x + plot.width;
    gaps.push(gap);
  }

  for (const g of gaps) unknownBand(svg, g, plot);
  for (const g of gaps) {
    if (!g.prev || !g.next) continue;
    svg.append(
      svgEl('path', {
        // 虚线跨接：说明"未知期间保持成什么值不可知"（spec §9.3 的保持语义在此处失效）
        d: stepPath([
          [at(g.prev), ys(g.prev.num!)],
          [g.end, ys(g.prev.num!)],
          [g.end, ys(g.next.num!)],
        ]),
        fill: 'none',
        stroke: 'var(--text-muted)',
        'stroke-width': 1.3,
        'stroke-dasharray': '4 3',
      }),
    );
  }
  for (const segment of runs) {
    if (segment.length === 0) continue;
    svg.append(
      svgEl('path', {
        d: stepPath(segment.map((item): [number, number] => [at(item), ys(item.num!)])),
        fill: 'none',
        stroke: color,
        'stroke-width': 1.7,
        'stroke-linejoin': 'round',
      }),
    );
  }

  for (const g of gaps) {
    for (const item of g.items) {
      const y = g.prev ? ys(g.prev.num!) : plot.y + plot.height / 2;
      const marker = unknownMarker(at(item), y);
      const note = g.next ? `未知保持到周期 ${g.next.cycle}` : '未知保持到轨迹末尾';
      bindHover(marker, ctx, { kind: 'value', key: track.key }, () => sampleLines(track, item, g.prev?.sample ?? null, ctx, useTime, note));
      clickable(marker, () => {
        ctx.selection.set({ kind: 'value', key: track.key });
        inspectSample(track, item, g.prev?.sample ?? null, ctx);
      });
      svg.append(marker);
    }
  }

  // 变化事件打点（spec §9.3 的 changes）+ 异步采样打点（spec §6.7 必须能看出不在沿上）
  const prevOf = new Map<Timed<ScalarValue>, Timed<ScalarValue> | null>();
  let previous: Timed<ScalarValue> | null = null;
  for (const sample of sorted) {
    prevOf.set(sample, previous);
    previous = sample;
  }
  for (const item of items) {
    if (item.num === null || (!item.changed && !item.async)) continue;
    const from = prevOf.get(item.sample) ?? null;
    const marker = item.async
      ? svgEl('circle', {
          // 异步：空心 + 虚线，且 x 已落在周期区间内部（spec §6.7）
          cx: at(item),
          cy: ys(item.num),
          r: item.changed ? 3.6 : 2.7,
          fill: 'var(--surface)',
          stroke: item.changed ? 'var(--warn)' : color,
          'stroke-width': 1.7,
          'stroke-dasharray': '2 1.6',
        })
      : svgEl('circle', { cx: at(item), cy: ys(item.num), r: 3, fill: 'var(--warn)', stroke: 'var(--surface)', 'stroke-width': 1 });
    bindHover(marker, ctx, { kind: 'value', key: track.key }, () => sampleLines(track, item, from, ctx, useTime));
    clickable(marker, () => {
      ctx.selection.set({ kind: 'value', key: track.key });
      inspectSample(track, item, from, ctx);
    });
    svg.append(marker);
  }

  node.body.append(el('div', { class: 'chart-scroll' }, [svg]));
  node.body.append(
    el('div', { class: 'row muted', style: 'font-size:11px;gap:12px' }, [
      el('span', { text: `${fmtInt(sorted.length)} 条采样（图上抽稀到 ${fmtInt(drawn.length)} 点）` }),
      el('span', { text: '实线阶梯 = 保持型取值（采样后保持到下一次采样）' }),
      unknown.length > 0 ? el('span', { text: `◇ 空心斜纹标记 + 斜纹底 = 含未知位 x/z（${fmtInt(unknown.length)} 次）` }) : null,
      el('span', { text: '● 橙点 = 取值发生变化' }),
      items.some((item) => item.async) ? el('span', { text: '虚线空心点 = 异步采样（画在周期区间内部，spec §6.7）' }) : null,
      el('span', { text: '虚线阶梯 = 未知区间（保持值不可知）' }),
    ]),
  );
  return node.root;
}

/** 周期分桶抽稀：每桶只保留桶内最后一条采样（保持型信号画法不失真），变化点与未知点全保留 */
function downsample(items: Item[], span: number): Item[] {
  const bucket = Math.max(1, Math.ceil(span / MAX_STEPS));
  const out: Item[] = [];
  let bucketKey = Math.floor(items[0]!.cycle / bucket);
  let final: Item | null = null;
  for (const item of items) {
    const key = Math.floor(item.cycle / bucket);
    if (key !== bucketKey) {
      if (final) out.push(final);
      final = null;
      bucketKey = key;
    }
    final = item;
    if (item.changed || item.num === null) out.push(item);
  }
  if (final) out.push(final);
  return [...new Set(out)].sort((a, b) => comparePosition(a.sample.pos, b.sample.pos));
}

/** 字符串/符号轨：不坐标化，改成事件条（采样处打标记 + 文本） */
function eventBar(track: ValueTrack, items: Item[], color: string, useTime: boolean, ctx: ViewContext, available: number): SVGSVGElement {
  const first = items[0]!.cycle;
  const last = items[items.length - 1]!.cycle;
  const height = 92;
  const pad = { left: 18, right: 18, top: 10, bottom: 22 };
  const width = chartWidth(last - first + 1, available);
  const svg = svgRoot(width, height);
  const plot = { x: pad.left, y: pad.top, width: width - pad.left - pad.right, height: height - pad.top - pad.bottom };
  const x = drawXAxis(svg, { ...plot, from: first, to: last, domain: ctx.trace.domains.get(track.domain) });
  const base = plot.y + plot.height / 2;
  const at = (item: Item) => x.px(item.cycle) + (item.async ? 0.5 * x.unit(item.cycle) : 0);

  svg.append(svgEl('line', { x1: plot.x, x2: plot.x + plot.width, y1: base, y2: base, stroke: 'var(--border-strong)', 'stroke-width': 1 }));
  svg.append(
    svgEl('text', { x: plot.x, y: plot.y + 9, class: 'axis-label', text: '事件条：不可坐标化的取值（字符串/符号、或全部为未知位）在采样周期上打标记' }),
  );

  const showLabels = items.length <= 60;
  let flip = 0;
  let previous: Timed<ScalarValue> | null = null;
  for (const item of items) {
    const from = previous;
    previous = item.sample;
    const marker = item.sample.value.hasXZ
      ? unknownMarker(at(item), base)
      : item.async
        ? svgEl('circle', {
            // 异步采样：空心虚线，且落在周期区间内部（spec §6.7）
            cx: at(item),
            cy: base,
            r: item.changed ? 4 : 3.2,
            fill: 'var(--surface)',
            stroke: item.changed ? 'var(--warn)' : color,
            'stroke-width': 1.7,
            'stroke-dasharray': '2 1.6',
          })
        : svgEl('circle', {
            cx: at(item),
            cy: base,
            r: item.changed ? 4 : 3,
            fill: item.changed ? 'var(--warn)' : color,
            stroke: 'var(--surface)',
            'stroke-width': 1,
          });
    bindHover(marker, ctx, { kind: 'value', key: track.key }, () => sampleLines(track, item, from, ctx, useTime));
    clickable(marker, () => {
      ctx.selection.set({ kind: 'value', key: track.key });
      inspectSample(track, item, from, ctx);
    });
    svg.append(marker);
    if (showLabels) {
      svg.append(
        svgEl('text', {
          x: at(item),
          y: flip % 2 === 0 ? base - 10 : base + 18,
          'text-anchor': 'middle',
          class: 'axis-label',
          style: item.sample.value.hasXZ ? 'fill:var(--warn)' : '',
          text: shortText(item.sample.value),
        }),
      );
    }
    flip++;
  }
  return svg;
}

function historyTable(track: ValueTrack, items: Item[], ctx: ViewContext): HTMLElement {
  const rows = items.slice(-HISTORY_ROWS).map((item) => {
    const label = el('span', { class: 'mono', text: fmtValue(item.sample.value) });
    if (item.sample.value.hasXZ) label.style.color = 'var(--warn)';
    const cycle = el('button', { class: 'btn btn-ghost mono', text: String(item.cycle), style: 'padding:0;font-size:12px' });
    cycle.addEventListener('click', () => {
      ctx.selection.set({ kind: 'value', key: track.key });
      inspectSample(track, item, null, ctx);
    });
    return [cycle, label, kindLabel(item.sample.value), item.async ? '异步' : '沿上', item.changed ? '变化' : '', String(lineOf(ctx.trace, item.sample.pos.seq))];
  });
  const wrap = el('div', {}, [
    dataTable(['周期', '值', '类型', '来源', '变化', '行'], rows),
    items.length > HISTORY_ROWS ? el('div', { class: 'muted', style: 'font-size:11px', text: `只列出最后 ${HISTORY_ROWS} 条（共 ${fmtInt(items.length)} 条）` }) : null,
  ]);
  return wrap;
}

// ------------------------------------------------------------------ 详情

function inspectTrack(track: ValueTrack, ctx: ViewContext): void {
  const sorted = [...track.samples].sort((a, b) => comparePosition(a.pos, b.pos));
  const unknown = sorted.filter((s) => s.value.hasXZ).length;
  const numeric = sorted.filter((s) => numericOf(s.value) !== null);
  const body = dataTable(
    ['周期', '值', '类型', '来源', '行'],
    sorted.slice(-60).map((s) => [String(s.pos.cycle), fmtValue(s.value), kindLabel(s.value), s.async ? '异步' : '沿上', String(lineOf(ctx.trace, s.pos.seq))]),
  );
  ctx.inspect(
    `数值轨 · ${track.name}`,
    [
      ['域', track.domain],
      ['追踪键', track.key],
      ['采样条数', fmtInt(sorted.length)],
      ['变化次数', fmtInt(track.changes.length)],
      ['含未知位 x/z', fmtInt(unknown)],
      ['异步采样', fmtInt(sorted.filter((s) => s.async).length)],
      ['周期范围', sorted.length > 0 ? `${sorted[0]!.pos.cycle} – ${sorted[sorted.length - 1]!.pos.cycle}` : '—'],
      ['末值', fmtValue(sorted[sorted.length - 1]?.value ?? null)],
      ['取值是否可坐标化', numeric.length > 0 ? '是（数值轨）' : '否（字符串/符号/未知位，用事件条展示）'],
    ],
    body,
  );
}

function inspectSample(track: ValueTrack, item: Item, prev: Timed<ScalarValue> | null, ctx: ViewContext): void {
  ctx.inspect(
    `采样 · ${track.name}`,
    [
      ['位置', `${item.sample.pos.domain} #${item.sample.pos.cycle}.${item.sample.pos.phase}（seq ${item.sample.pos.seq}）`],
      ['值', fmtValue(item.sample.value)],
      ['语义类型', kindLabel(item.sample.value)],
      ['原始字面量', item.sample.value.raw],
      ['数值表示', item.num === null ? '不可坐标化' : String(item.num)],
      ['前一次取值', prev ? fmtValue(prev.value) : '（无更早采样）'],
      ['采样来源', item.async ? '异步（不在时钟沿上，画在周期区间内部，spec §6.7）' : '时钟沿采样'],
      ['源文件行', String(lineOf(ctx.trace, item.sample.pos.seq))],
    ],
  );
}

// ------------------------------------------------------------------ 小卡

function statsRow(tracks: ValueTrack[]): HTMLElement {
  let samples = 0;
  let changes = 0;
  let unknown = 0;
  let asyncCount = 0;
  let categorical = 0;
  for (const track of tracks) {
    changes += track.changes.length;
    let numeric = false;
    for (const sample of track.samples) {
      samples++;
      if (sample.value.hasXZ) unknown++;
      if (sample.async) asyncCount++;
      if (numericOf(sample.value) !== null) numeric = true;
    }
    if (!numeric) categorical++;
  }
  return el('div', { class: 'stat-row' }, [
    statTile('数值轨', countLabel(tracks.length), `${categorical} 条不可坐标化（字符串/符号/未知位）`),
    statTile('采样条数', countLabel(samples), '保持型：采样后保持到下一次采样'),
    statTile('变化次数', countLabel(changes), '相邻取值不同（含 未知↔已知）'),
    statTile('含未知位', countLabel(unknown), 'x/z 采样（spec §4.5）'),
    statTile('异步采样', countLabel(asyncCount), '不在时钟沿上（spec §6.7）'),
  ]);
}

function changesCard(tracks: ValueTrack[], ctx: ViewContext): HTMLElement {
  const node = card('变化最多的数值轨', '按取值变化次数排序，取前 10 条');
  const ranked = tracks
    .filter((t) => t.changes.length > 0)
    .sort((a, b) => b.changes.length - a.changes.length)
    .slice(0, 10);
  if (ranked.length === 0) {
    node.body.append(emptyState('没有发生过取值变化'));
    return node.root;
  }
  const rows = ranked.map((track) => {
    const name = el('button', { class: 'btn btn-ghost mono', text: track.name, style: 'padding:0;font-size:12px' });
    name.addEventListener('click', () => {
      ctx.selection.set({ kind: 'value', key: track.key });
      inspectTrack(track, ctx);
    });
    const rate = track.samples.length > 0 ? `${((track.changes.length / track.samples.length) * 100).toFixed(1)}%` : '—';
    const last = track.samples[track.samples.length - 1];
    return [name, track.domain, fmtInt(track.changes.length), fmtInt(track.samples.length), rate, last ? fmtValue(last.value) : '—'];
  });
  node.body.append(dataTable(['数值轨', '域', '变化次数', '采样数', '变化率', '末值'], rows));
  return node.root;
}

// ------------------------------------------------------------------ 视图

let containerRef: HTMLElement | null = null;
let unsubscribe: (() => void) | null = null;
const highlights = new Map<string, HTMLElement[]>();

function highlight(selection: Selection): void {
  const key = selection && (selection.kind === 'value' ? selection.key : null);
  for (const [trackKey, nodes] of highlights) {
    const on = key === trackKey;
    for (const node of nodes) node.style.outline = on ? '2px solid var(--accent)' : '';
  }
}

function render(ctx: ViewContext): void {
  if (!containerRef) return;
  clear(containerRef);
  highlights.clear();
  const all = [...ctx.trace.values.values()];
  const shown = all
    .filter((t) => ctx.options.domains.length === 0 || ctx.options.domains.includes(t.domain))
    .sort((a, b) => (a.domain === b.domain ? a.name.localeCompare(b.name) : a.domain.localeCompare(b.domain)));

  if (shown.length === 0) {
    const node = card('数值');
    node.body.append(emptyState(all.length === 0 ? '这份轨迹没有 val 记录' : '当前时钟域筛选下没有数值轨'));
    containerRef.append(node.root);
    return;
  }

  const summary = card('总览', '按当前时钟域筛选');
  summary.body.append(statsRow(shown));
  containerRef.append(summary.root);

  const charts = el('div', { class: 'grid grid-2' });
  containerRef.append(charts);
  const available = columnWidth(charts, shown.length);
  for (const track of shown) {
    const node = waveformCard(track, ctx, ctx.options.useTimeAxis, available);
    const list = highlights.get(track.key) ?? [];
    list.push(node);
    highlights.set(track.key, list);
    charts.append(node);
  }
  containerRef.append(changesCard(shown, ctx));
  highlight(ctx.selection.get());
}

export const valuesView: View = {
  id: 'values',
  title: '数值',
  hint: '保持型阶梯波形与变化事件',
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
    containerRef = null;
    highlights.clear();
  },
};

export default valuesView;
