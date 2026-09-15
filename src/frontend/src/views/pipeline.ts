/**
 * 流水线视图 —— 气泡区间、逐周期占用度、延迟分布与条目明细。
 *
 * 数据口径：
 *  - 占用度是**半开区间** `[enter, close)`（spec §9.4），气泡 = 活跃区间内占用度为 0 的周期
 *  - 延迟只统计**同域完成**条目；跨域条目不给周期延迟（spec §6.5），单独一张卡片列出
 *  - 横轴是周期；域声明了 period/freq 且开启了"时间轴"时，刻度换算成 ns
 */
import type { DomainInfo, PipelineItem, Position, TrackInfo } from '../../../parser/src/index.ts';
import { latencyStats } from '../../../parser/src/index.ts';
import {
  axisTicks,
  card,
  countLabel,
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
import { cycleTime, fmtInt, fmtNs, fmtPosition, fmtValue, type Selection, type View, type ViewContext } from '../view.ts';

// ------------------------------------------------------------------ 小工具

/** 选中态高亮：默认切 `is-selected` 类，SVG 元素可自定义（类选择器管不到 svg） */
interface Highlight {
  node: Element;
  match: (selection: Selection) => boolean;
  apply?: (node: Element, active: boolean) => void;
}

interface PipelineState {
  container: HTMLElement;
  ctx: ViewContext;
  highlights: Highlight[];
  unsubscribe: (() => void) | null;
}

let active: PipelineState | null = null;

function visibleTracks(ctx: ViewContext): TrackInfo[] {
  const tracks = [...ctx.trace.tracks.values()];
  const domains = ctx.options.domains;
  return domains.length === 0 ? tracks : tracks.filter((track) => domains.includes(track.domain));
}

function posText(pos: Position): string {
  return `${pos.domain}#${pos.cycle}${pos.phase === '-' ? '' : `.${pos.phase}`}`;
}

function outcomeText(item: PipelineItem): string {
  if (item.closed === 'O') return '完成';
  if (item.closed === 'X') return item.orphan ? '撤销·孤儿' : '撤销';
  return item.orphan ? '未闭合·孤儿' : '未闭合';
}

function asyncText(item: PipelineItem): string {
  if (item.async && item.closeAsync) return '入/出';
  if (item.async) return '入';
  if (item.closeAsync) return '出';
  return '—';
}

function closePosText(item: PipelineItem): string {
  if (item.exit) return posText(item.exit);
  if (item.abort) return posText(item.abort);
  return '—';
}

function timeHint(domain: DomainInfo | undefined, cycle: number, useTime: boolean): string {
  const text = cycleTime(domain, cycle, useTime);
  return text.startsWith('周期') ? `周期 ${cycle}` : text;
}

/** 延迟最大的 n 条（线性扫描 + 小数组插入，避免为整个轨迹排序） */
function topByLatency(entries: { track: TrackInfo; item: PipelineItem }[], limit: number): { track: TrackInfo; item: PipelineItem }[] {
  const out: { track: TrackInfo; item: PipelineItem }[] = [];
  for (const entry of entries) {
    const key = entry.item.latencyCycles ?? -1;
    if (out.length === limit && (out[out.length - 1]!.item.latencyCycles ?? -1) >= key) continue;
    let index = out.length;
    while (index > 0 && (out[index - 1]!.item.latencyCycles ?? -1) < key) index--;
    out.splice(index, 0, entry);
    if (out.length > limit) out.pop();
  }
  return out;
}

// ------------------------------------------------------------------ 气泡区间

interface BubbleRow {
  track: string;
  domain: string;
  start: number;
  end: number;
  length: number;
}

function allBubbleRanges(tracks: TrackInfo[]): BubbleRow[] {
  const rows: BubbleRow[] = [];
  for (const track of tracks) {
    for (const range of track.bubbleRanges) {
      rows.push({
        track: track.name,
        domain: track.domain,
        start: range.start,
        end: range.end,
        length: range.end - range.start + 1,
      });
    }
  }
  rows.sort((a, b) => b.length - a.length || a.track.localeCompare(b.track) || a.start - b.start);
  return rows;
}

function countBubbles(tracks: TrackInfo[]): number {
  let total = 0;
  for (const track of tracks) total += track.bubbles.length;
  return total;
}

// ------------------------------------------------------------------ 占用度曲线

const OCCUPANCY_HEIGHT = 96;
const MAX_BUCKETS = 600;

/** 周期轴：默认用周期刻度，开启时间轴且域声明了 period 时用 ns 标签 */
function drawCycleLabels(
  svg: SVGSVGElement,
  geo: { x: number; y: number; width: number; height: number; from: number; to: number },
  domain: DomainInfo | undefined,
  useTime: boolean,
): void {
  const periodNs = domain?.periodNs;
  const timeMode = useTime && periodNs !== undefined;
  const scale = linearScale(geo.from, geo.to + 1, geo.x, geo.x + geo.width);
  for (const value of axisTicks(geo.from, geo.to, Math.max(2, Math.floor(geo.width / 70)))) {
    const x = scale(value);
    svg.append(
      svgEl('line', { x1: x, x2: x, y1: geo.y, y2: geo.y + geo.height, class: 'grid-line' }),
      svgEl('text', {
        x,
        y: geo.y + geo.height + 12,
        class: 'axis-label',
        'text-anchor': 'middle',
        text: timeMode ? (value < 1 ? '时钟前' : fmtNs((value - 1) * periodNs!)) : String(value),
      }),
    );
  }
}

/** 单条轨道的占用度柱状图：每根柱 = 一个（聚合后的）周期区段 */
function occupancyChart(
  track: TrackInfo,
  stats: { count: number; avg: number },
  ctx: ViewContext,
  highlights: Highlight[],
): HTMLElement {
  const domain = ctx.trace.domains.get(track.domain);
  const from = track.firstCycle;
  const to = Math.max(track.lastCycle, from);
  const span = to - from + 1;
  const bucketCount = Math.max(1, Math.min(span, MAX_BUCKETS));
  const bucketSize = span / bucketCount;
  const plotWidth = Math.max(260, Math.min(1200, bucketCount * 2));
  const pad = { left: 38, right: 10, top: 12, bottom: 18 };
  const plotHeight = OCCUPANCY_HEIGHT - pad.top - pad.bottom;
  const width = plotWidth + pad.left + pad.right;
  const svg = svgRoot(width, OCCUPANCY_HEIGHT);

  const maxOcc = new Array<number>(bucketCount).fill(0);
  const bubbleCount = new Array<number>(bucketCount).fill(0);
  let peak = 0;
  for (const [cycle, count] of track.occupancy) {
    if (cycle < from || cycle > to) continue;
    const index = Math.min(bucketCount - 1, Math.max(0, Math.floor((cycle - from) / bucketSize)));
    if (count > maxOcc[index]!) maxOcc[index] = count;
    if (count > peak) peak = count;
  }
  for (const cycle of track.bubbles) {
    if (cycle < from || cycle > to) continue;
    bubbleCount[Math.min(bucketCount - 1, Math.max(0, Math.floor((cycle - from) / bucketSize)))]! += 1;
  }

  const { scale: yScale } = numericAxis(svg, {
    x: pad.left,
    y: pad.top,
    width: plotWidth,
    height: plotHeight,
    min: 0,
    max: Math.max(1, peak),
    label: '占用',
  });
  const baseline = pad.top + plotHeight;
  const barWidth = Math.max(1, plotWidth / bucketCount - 0.6);

  for (let index = 0; index < bucketCount; index++) {
    const occ = maxOcc[index]!;
    const bubbles = bubbleCount[index]!;
    const startCycle = from + Math.floor(index * bucketSize);
    const endCycle = Math.min(to, from + Math.floor((index + 1) * bucketSize) - 1);
    const x = pad.left + (index * plotWidth) / bucketCount;
    const y = occ > 0 ? yScale(occ) : baseline - 1;
    const fill = occ > 0 ? 'var(--accent)' : bubbles > 0 ? 'var(--warn)' : 'var(--border)';
    svg.append(
      svgEl('rect', {
        x: x + 0.3,
        y,
        width: barWidth,
        height: Math.max(1, baseline - y),
        fill,
        opacity: occ > 0 ? 0.82 : 0.75,
        rx: 1,
      }),
    );
    const hit = svgEl('rect', {
      x,
      y: pad.top,
      width: Math.max(1, plotWidth / bucketCount),
      height: plotHeight,
      fill: 'transparent',
      style: 'cursor:pointer',
    });
    hoverTarget(
      hit,
      () => {
        const lines = [
          `轨道 ${track.name}（${track.domain}）`,
          startCycle === endCycle ? timeHint(domain, startCycle, ctx.options.useTimeAxis) : `周期 ${startCycle} – ${endCycle}`,
          `占用 最大 ${occ}`,
          bubbles > 0 ? `气泡 ${bubbles} 周期` : '无气泡',
        ];
        return lines.join('\n');
      },
      () => {
        ctx.selection.set({ kind: 'cycle', domain: track.domain, cycle: startCycle });
        ctx.inspect(`周期 ${startCycle}（${track.domain}）`, [
          ['轨道', track.name],
          ['时钟域', track.domain],
          ['周期区间', startCycle === endCycle ? String(startCycle) : `${startCycle} – ${endCycle}`],
          ['最大占用', String(occ)],
          ['气泡周期', String(bubbles)],
          ['时间', timeHint(domain, startCycle, ctx.options.useTimeAxis)],
        ]);
      },
    );
    highlights.push({
      node: hit,
      match: (selection) =>
        selection?.kind === 'cycle' &&
        selection.domain === track.domain &&
        selection.cycle >= startCycle &&
        selection.cycle <= endCycle,
      apply: (node, isActive) => {
        node.setAttribute('fill', isActive ? 'var(--accent-soft)' : 'transparent');
        node.setAttribute('opacity', isActive ? '0.9' : '1');
      },
    });
    svg.append(hit);
  }

  drawCycleLabels(
    svg,
    { x: pad.left, y: pad.top, width: plotWidth, height: plotHeight, from, to },
    domain,
    ctx.options.useTimeAxis,
  );

  const head = el('div', { class: 'row' }, [
    el('code', { class: 'mono', text: track.name }),
    el('span', { class: 'badge', text: track.domain }),
    el('span', { class: 'muted', text: `${fmtInt(track.firstCycle)} – ${fmtInt(track.lastCycle)} 周期` }),
    el('span', { class: 'muted', text: `条目 ${countLabel(track.items.length)}` }),
    el('span', { class: 'muted', text: `完成 ${countLabel(track.completed)} · 撤销 ${countLabel(track.aborted)} · 未闭合 ${countLabel(track.open)}` }),
    el('span', { class: 'muted', text: `气泡 ${countLabel(track.bubbles.length)} 周期 / ${countLabel(track.bubbleRanges.length)} 段` }),
    stats.count > 0 ? el('span', { class: 'muted', text: `平均延迟 ${stats.avg.toFixed(2)} 周期` }) : null,
  ]);

  const scroll = el('div', { class: 'chart-scroll' }, [svg]);
  return el('div', { style: 'display:flex;flex-direction:column;gap:4px' }, [head, scroll]);
}

// ------------------------------------------------------------------ 延迟分布

interface LatencyBin {
  lo: number;
  hi: number;
  count: number;
}

/** 直方图分箱：取值少时一值一柱，取值多时合并成 40 个等宽箱 */
function latencyBins(stats: { min: number; max: number; histogram: { latency: number; count: number }[] }): LatencyBin[] {
  if (stats.histogram.length <= 60) {
    return stats.histogram.map((bin) => ({ lo: bin.latency, hi: bin.latency, count: bin.count }));
  }
  const width = Math.max(1, Math.ceil((stats.max - stats.min + 1) / 40));
  const merged = new Map<number, number>();
  for (const bin of stats.histogram) {
    const lo = stats.min + Math.floor((bin.latency - stats.min) / width) * width;
    merged.set(lo, (merged.get(lo) ?? 0) + bin.count);
  }
  return [...merged.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([lo, count]) => ({ lo, hi: lo + width - 1, count }));
}

function latencyChart(bins: LatencyBin[], height = 116): SVGSVGElement {
  const pad = { left: 38, right: 12, top: 12, bottom: 30 };
  const width = 420;
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const svg = svgRoot(width, height);
  const lo = bins[0]!.lo;
  const hi = bins[bins.length - 1]!.hi;
  const max = Math.max(1, ...bins.map((bin) => bin.count));
  const x = linearScale(lo - 0.5, hi + 0.5, pad.left, pad.left + plotWidth);
  const { scale: y } = numericAxis(svg, {
    x: pad.left,
    y: pad.top,
    width: plotWidth,
    height: plotHeight,
    min: 0,
    max,
    label: '条目数',
  });
  const baseline = pad.top + plotHeight;

  for (const bin of bins) {
    const x0 = x(bin.lo - 0.5);
    const x1 = x(bin.hi + 0.5);
    const rect = svgEl('rect', {
      x: x0 + 0.5,
      y: y(bin.count),
      width: Math.max(1, x1 - x0 - 1),
      height: Math.max(bin.count > 0 ? 1 : 0, baseline - y(bin.count)),
      fill: 'var(--accent)',
      opacity: 0.8,
      rx: 1.5,
    });
    hoverTarget(rect, () => {
      const label = bin.lo === bin.hi ? `${bin.lo} 周期` : `${bin.lo} – ${bin.hi} 周期`;
      return `延迟 ${label}\n${fmtInt(bin.count)} 条`;
    });
    svg.append(rect);
  }

  for (const value of axisTicks(lo, hi, Math.max(2, Math.floor(plotWidth / 60)))) {
    svg.append(
      svgEl('text', {
        x: x(value),
        y: baseline + 13,
        class: 'axis-label',
        'text-anchor': 'middle',
        text: String(Math.round(value)),
      }),
    );
  }
  svg.append(
    svgEl('text', { x: pad.left + plotWidth / 2, y: height - 3, class: 'axis-label', 'text-anchor': 'middle', text: '延迟（周期）' }),
  );
  return svg;
}

// ------------------------------------------------------------------ 挂载

function renderPipeline(state: PipelineState): void {
  const { container, ctx } = state;
  container.replaceChildren();
  state.highlights = [];

  const tracks = visibleTracks(ctx);
  if (tracks.length === 0) {
    const empty = card('流水线', '没有可显示的 pip 轨道');
    empty.body.append(emptyState(ctx.trace.tracks.size === 0 ? '这份轨迹没有 pip 轨道' : '当前时钟域筛选下没有轨道'));
    container.append(empty.root);
    return;
  }

  const bubbleRows = allBubbleRanges(tracks);
  const widest = bubbleRows[0] ?? null;

  // ---------------------------------------------------------------- 概览
  let items = 0;
  let completed = 0;
  let aborted = 0;
  let open = 0;
  let orphan = 0;
  let crossDomain = 0;
  for (const track of tracks) {
    items += track.items.length;
    completed += track.completed;
    aborted += track.aborted;
    open += track.open;
    orphan += track.orphan;
    for (const item of track.items) if (item.crossDomain) crossDomain += 1;
  }
  const bubbles = countBubbles(tracks);

  const overview = card('流水线概览', '占用度是半开区间 [enter, close)；气泡 = 活跃区间内占用为 0 的周期');
  overview.body.append(
    el('div', { class: 'stat-row' }, [
      statTile('轨道', countLabel(tracks.length), `域 ${[...new Set(tracks.map((t) => t.domain))].join(' · ')}`),
      statTile('在飞条目', countLabel(items), `${completed} 完成 · ${aborted} 撤销 · ${open} 未闭合`),
      statTile('气泡周期', countLabel(bubbles), `${countLabel(bubbleRows.length)} 段连续区间`),
      widest
        ? statTile('最长气泡', `${countLabel(widest.length)} 周期`, `${widest.track} · ${widest.start}–${widest.end}`)
        : statTile('最长气泡', '—', '没有气泡'),
      statTile('跨域条目', countLabel(crossDomain), '不计入周期延迟分布（§6.5）'),
      statTile('孤儿条目', countLabel(orphan), '没有匹配的在飞条目'),
    ]),
  );
  container.append(overview.root);

  // ---------------------------------------------------------------- 气泡区间
  const bubbleCard = card('气泡区间', '连续气泡合并成区间；点击区间把周期广播给其它视图');
  if (widest) {
    bubbleCard.body.append(
      el('div', { class: 'row' }, [
        el('span', { class: 'badge', style: 'background:var(--warn-soft);color:var(--warn)', text: '全局最长' }),
        el('span', { text: `${widest.track} · 周期 ${widest.start} – ${widest.end} · ${widest.length} 周期` }),
      ]),
    );
  }
  const maxRanges = 200;
  const bubbleTable = el('div', { class: 'table-wrap' }, [
    el('table', { class: 'table' }, [
      el('thead', {}, [
        el('tr', {}, ['轨道', '域', '区间', '长度（周期）', '时间'].map((h) => el('th', { text: h }))),
      ]),
      el(
        'tbody',
        {},
        (bubbleRows.length > maxRanges ? bubbleRows.slice(0, maxRanges) : bubbleRows).map((row) => {
          const isWidest = widest !== null && row.track === widest.track && row.start === widest.start && row.end === widest.end;
          const tr = el('tr', { style: 'cursor:pointer' }, [
            el('td', {}, [el('code', { class: 'mono', text: row.track })]),
            el('td', { text: row.domain }),
            el('td', { class: 'num' }, [
              el('span', { text: `${row.start} – ${row.end}` }),
              isWidest
                ? el('span', {
                    class: 'badge',
                    style: 'margin-left:6px;background:var(--warn-soft);color:var(--warn);font-weight:600',
                    text: '最长',
                  })
                : null,
            ]),
            el('td', { class: 'num', text: fmtInt(row.length) }),
            el('td', { class: 'muted', text: timeHint(ctx.trace.domains.get(row.domain), row.start, ctx.options.useTimeAxis) }),
          ]);
          tr.addEventListener('click', () => {
            ctx.selection.set({ kind: 'cycle', domain: row.domain, cycle: row.start });
            ctx.inspect(`气泡区间 ${row.start} – ${row.end}`, [
              ['轨道', row.track],
              ['时钟域', row.domain],
              ['区间', `${row.start} – ${row.end}（含两端）`],
              ['长度', `${row.length} 周期`],
              ['起始时间', timeHint(ctx.trace.domains.get(row.domain), row.start, ctx.options.useTimeAxis)],
            ]);
          });
          state.highlights.push({
            node: tr,
            match: (selection) =>
              selection?.kind === 'cycle' &&
              selection.domain === row.domain &&
              selection.cycle >= row.start &&
              selection.cycle <= row.end,
          });
          return tr;
        }),
      ),
    ]),
  ]);
  bubbleCard.body.append(
    el('div', { style: 'display:flex;flex-direction:column;gap:10px' }, [
      bubbleRows.length > 0 ? bubbleTable : emptyState('没有气泡：活跃区间内占用度始终大于 0'),
      bubbleRows.length > maxRanges
        ? el('p', { class: 'muted', text: `共 ${fmtInt(bubbleRows.length)} 段，按长度降序显示前 ${maxRanges} 段` })
        : null,
    ]),
  );
  container.append(bubbleCard.root);

  // ---------------------------------------------------------------- 占用度
  const occupancyCard = card('占用度曲线', '柱高 = 该周期（或聚合区段）的在飞条目最大值；黄色柱是气泡周期');
  occupancyCard.body.append(
    legend([
      { label: '占用', color: 'var(--accent)' },
      { label: '气泡（占用 0）', color: 'var(--warn)' },
      { label: '无占用且非气泡', color: 'var(--border)' },
    ]),
  );
  const occupancyList = el('div', { style: 'display:flex;flex-direction:column;gap:14px' });
  const statsByTrack = new Map<TrackInfo, ReturnType<typeof latencyStats>>();
  for (const track of tracks) {
    const stats = latencyStats(track);
    statsByTrack.set(track, stats);
    occupancyList.append(occupancyChart(track, stats, ctx, state.highlights));
  }
  occupancyCard.body.append(occupancyList);
  container.append(occupancyCard.root);

  // ---------------------------------------------------------------- 延迟分布
  const latencyCard = card('延迟分布', '只统计同域完成条目；跨域条目另见下一张卡片（spec §6.5）');
  const latencyGrid = el('div', { class: 'grid grid-2' });
  for (const track of tracks) {
    const stats = statsByTrack.get(track)!;
    let crossCount = 0;
    for (const item of track.items) if (item.crossDomain) crossCount += 1;
    const panel = card(
      `延迟分布 · ${track.name}`,
      stats.count > 0
        ? `完成 ${fmtInt(stats.count)} 条 · 最小 ${stats.min} · 平均 ${stats.avg.toFixed(2)} · 最大 ${stats.max} 周期`
        : `条目 ${fmtInt(track.items.length)} · 没有同域完成条目`,
    );
    if (stats.count > 0) {
      panel.body.append(el('div', { class: 'chart-scroll' }, [latencyChart(latencyBins(stats))]));
    } else {
      panel.body.append(
        emptyState(crossCount > 0 ? `没有完成的同域条目；${fmtInt(crossCount)} 条跨域条目见下方卡片` : '没有完成的同域条目'),
      );
    }
    latencyGrid.append(panel.root);
  }
  latencyCard.body.append(tracks.length > 0 ? latencyGrid : emptyState('没有可统计的轨道'));
  container.append(latencyCard.root);

  // ---------------------------------------------------------------- 跨域条目
  const crossCard = card('跨域条目', 'enter 与 close 不在同一时钟域：没有周期延迟，只给出两端位置与时间延迟（spec §6.5）');
  const crossItems: { track: TrackInfo; item: PipelineItem }[] = [];
  for (const track of tracks) {
    for (const item of track.items) if (item.crossDomain) crossItems.push({ track, item });
  }
  const maxCross = 200;
  crossCard.body.append(
    el('div', { style: 'display:flex;flex-direction:column;gap:10px' }, [
      crossItems.length > 0
      ? el('div', { class: 'table-wrap' }, [
          el('table', { class: 'table' }, [
            el('thead', {}, [
              el('tr', {}, ['轨道', '标记', '入口位置', '出口位置', '时间延迟', '结局', '异步'].map((h) => el('th', { text: h }))),
            ]),
            el(
              'tbody',
              {},
              crossItems.slice(0, maxCross).map(({ track, item }) => {
                const tr = el('tr', { style: 'cursor:pointer' }, [
                  el('td', {}, [el('code', { class: 'mono', text: track.name })]),
                  el('td', { class: 'mono', text: fmtValue(item.tag) }),
                  el('td', { class: 'mono', text: posText(item.enter) }),
                  el('td', { class: 'mono', text: closePosText(item) }),
                  el('td', { class: 'num', text: item.latencyNs !== null ? fmtNs(item.latencyNs) : '—' }),
                  el('td', { text: outcomeText(item) }),
                  el('td', { text: asyncText(item) }),
                ]);
                tr.addEventListener('click', () => {
                  ctx.selection.set({ kind: 'item', track: track.name, enterSeq: item.enterSeq });
                  ctx.inspect(`跨域条目 ${track.name}`, itemRows(track, item, ctx));
                });
                state.highlights.push({
                  node: tr,
                  match: (selection) =>
                    selection?.kind === 'item' && selection.track === track.name && selection.enterSeq === item.enterSeq,
                });
                return tr;
              }),
            ),
          ]),
        ])
      : emptyState('没有跨域条目'),
      crossItems.length > maxCross
        ? el('p', { class: 'muted', text: `共 ${fmtInt(crossItems.length)} 条，显示前 ${maxCross} 条` })
        : null,
    ]),
  );
  container.append(crossCard.root);

  // ---------------------------------------------------------------- 条目表
  const itemCard = card('条目明细', '按延迟降序（跨域与未闭合的条目延迟为空，排在最后）');
  const all: { track: TrackInfo; item: PipelineItem }[] = [];
  for (const track of tracks) for (const item of track.items) all.push({ track, item });
  const top = topByLatency(all, 50);
  itemCard.body.append(
    el('div', { style: 'display:flex;flex-direction:column;gap:10px' }, [
      all.length > 0
      ? el('div', { class: 'table-wrap' }, [
          el('table', { class: 'table' }, [
            el('thead', {}, [
              el('tr', {}, ['轨道', '标记', '入周期', '出周期', '延迟', '结局', '异步'].map((h) => el('th', { text: h }))),
            ]),
            el(
              'tbody',
              {},
              top.map(({ track, item }) => {
                const tr = el('tr', { style: 'cursor:pointer' }, [
                  el('td', {}, [el('code', { class: 'mono', text: track.name })]),
                  el('td', { class: 'mono', text: fmtValue(item.tag) }),
                  el('td', { class: 'mono', text: posText(item.enter) }),
                  el('td', { class: 'mono', text: closePosText(item) }),
                  el('td', {
                    class: 'num',
                    text: item.latencyCycles !== null ? `${fmtInt(item.latencyCycles)} 周期` : item.crossDomain ? '跨域' : '—',
                  }),
                  el('td', { text: outcomeText(item) }),
                  el('td', { text: asyncText(item) }),
                ]);
                tr.addEventListener('click', () => {
                  ctx.selection.set({ kind: 'item', track: track.name, enterSeq: item.enterSeq });
                  ctx.inspect(`条目 ${track.name} · seq ${item.enterSeq}`, itemRows(track, item, ctx));
                });
                state.highlights.push({
                  node: tr,
                  match: (selection) =>
                    selection?.kind === 'item' && selection.track === track.name && selection.enterSeq === item.enterSeq,
                });
                return tr;
              }),
            ),
          ]),
        ])
      : emptyState('没有在飞条目'),
      all.length > top.length
        ? el('p', { class: 'muted', text: `共 ${fmtInt(all.length)} 条，按延迟降序显示前 ${top.length} 条` })
        : null,
    ]),
  );
  container.append(itemCard.root);

  applySelection(state);
}

function itemRows(track: TrackInfo, item: PipelineItem, ctx: ViewContext): [string, string][] {
  const rows: [string, string][] = [
    ['轨道', track.name],
    ['时钟域', track.domain],
    ['标记', fmtValue(item.tag)],
    ['入口', fmtPosition(item.enter)],
    ['出口', item.exit ? fmtPosition(item.exit) : '—'],
    ['撤销', item.abort ? fmtPosition(item.abort) : '—'],
    ['结局', outcomeText(item)],
    ['同域延迟', item.latencyCycles !== null ? `${item.latencyCycles} 周期` : item.crossDomain ? '跨域，不给周期延迟' : '未闭合'],
    ['时间延迟', item.latencyNs !== null ? fmtNs(item.latencyNs) : '—'],
    ['跨域', item.crossDomain ? '是' : '否'],
    ['异步', asyncText(item)],
    ['源行', `${item.enterLine}${item.closeLine !== null ? ` → ${item.closeLine}` : ''}`],
  ];
  const domain = ctx.trace.domains.get(item.enter.domain);
  const time = timeHint(domain, item.enter.cycle, ctx.options.useTimeAxis);
  rows.push(['入口时间', time]);
  return rows;
}

// ------------------------------------------------------------------ 选中联动

function applySelection(state: PipelineState): void {
  const selection = state.ctx.selection.get();
  for (const highlight of state.highlights) {
    const isActive = highlight.match(selection);
    if (highlight.apply) highlight.apply(highlight.node, isActive);
    else highlight.node.classList.toggle('is-selected', isActive);
  }
}

function mountView(container: HTMLElement, ctx: ViewContext): void {
  active?.unsubscribe?.();
  const state: PipelineState = { container, ctx, highlights: [], unsubscribe: null };
  renderPipeline(state);
  state.unsubscribe = ctx.selection.subscribe(() => applySelection(state));
  active = state;
}

export const pipelineView: View = {
  id: 'pipeline',
  title: '流水线',
  hint: '占用度、延迟分布、气泡区间',
  mount(container, ctx) {
    mountView(container, ctx);
  },
  refresh(ctx, reason) {
    if (!active) return;
    if (reason === 'options') {
      mountView(active.container, ctx);
      return;
    }
    active.ctx = ctx;
    applySelection(active);
  },
  unmount() {
    active?.unsubscribe?.();
    active = null;
  },
};

export default pipelineView;
