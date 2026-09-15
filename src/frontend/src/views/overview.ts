/** 数据总览：周期、事件、追踪对象、条目、延迟、气泡、警告（规范里叫诊断） */
import type { Trace } from '../../../parser/src/index.ts';
import { latencyStats } from '../../../parser/src/index.ts';
import {
  barRect,
  card,
  clear,
  colorFor,
  countLabel,
  cycleAxis,
  el,
  emptyState,
  hoverTarget,
  legend,
  linearScale,
  numericAxis,
  statTile,
  svgEl,
  svgRoot,
  tableRow,
} from '../charts.ts';
import { fmtBytes, fmtCompact, fmtInt, fmtNs, type View, type ViewContext } from '../view.ts';

const KINDS = ['clk', 'cnt', 'val', 'pip', 'fsm', 'evt', 'msg'] as const;

function recordKindCounts(trace: Trace): { label: string; value: number; color: string }[] {
  const counts = new Map<string, number>(KINDS.map((k) => [k, 0]));
  for (const record of trace.records) counts.set(record.kind, (counts.get(record.kind) ?? 0) + 1);
  return [...counts]
    .filter(([, value]) => value > 0)
    .map(([label, value]) => ({ label, value, color: colorFor(label) }));
}

function donut(items: { label: string; value: number; color: string }[], size = 168): SVGSVGElement {
  const total = items.reduce((sum, item) => sum + item.value, 0) || 1;
  const radius = size / 2 - 10;
  const inner = radius * 0.62;
  const svg = svgRoot(size, size);
  const cx = size / 2;
  const cy = size / 2;
  let angle = -Math.PI / 2;
  for (const item of items) {
    const sweep = (item.value / total) * Math.PI * 2;
    const x0 = cx + radius * Math.cos(angle);
    const y0 = cy + radius * Math.sin(angle);
    const x1 = cx + radius * Math.cos(angle + sweep);
    const y1 = cy + radius * Math.sin(angle + sweep);
    const xi1 = cx + inner * Math.cos(angle + sweep);
    const yi1 = cy + inner * Math.sin(angle + sweep);
    const xi0 = cx + inner * Math.cos(angle);
    const yi0 = cy + inner * Math.sin(angle);
    const large = sweep > Math.PI ? 1 : 0;
    const path = svgEl('path', {
      d: `M${x0},${y0}A${radius},${radius} 0 ${large} 1 ${x1},${y1}L${xi1},${yi1}A${inner},${inner} 0 ${large} 0 ${xi0},${yi0}Z`,
      fill: item.color,
      stroke: 'var(--surface)',
      'stroke-width': 1,
    });
    hoverTarget(path, () => `${item.label}\n${fmtInt(item.value)} 条（${((item.value / total) * 100).toFixed(1)}%）`);
    svg.append(path);
    angle += sweep;
  }
  svg.append(
    svgEl('text', {
      x: cx,
      y: cy + 4,
      'text-anchor': 'middle',
      class: 'axis-label',
      style: 'font-size:13px',
      text: fmtCompact(total),
    }),
  );
  return svg;
}

/**
 * 每周期事件数。
 *
 * 柱宽由画布宽度决定（上限 1600px），所以周期数一多，"每周期一根柱"就会细到看不见、
 * 而且要为每一根建一个 DOM 节点与一个悬停目标 —— 20 万周期的轨迹在这里就能堆出 20 万个节点。
 * 因此超过 `MAX_BARS` 根时按周期**分桶**：桶高 = 桶内记录总数，提示里仍然给区间与峰值。
 */
const MAX_BARS = 400;

function recordsPerCycleChart(trace: Trace, domain: string, height = 120): SVGSVGElement {
  const info = trace.domains.get(domain)!;
  const to = Math.max(1, info.lastCycle);
  const width = Math.max(320, Math.min(1600, to * 10 + 60));
  const svg = svgRoot(width, height + 22);
  const counts = new Map<number, number>();
  let maxPerCycle = 0;
  for (const record of trace.records) {
    if (record.pos.domain !== domain) continue;
    const next = (counts.get(record.pos.cycle) ?? 0) + 1;
    counts.set(record.pos.cycle, next);
    if (next > maxPerCycle) maxPerCycle = next;
  }
  const bucket = Math.max(1, Math.ceil(to / MAX_BARS));
  const slots = new Map<number, { sum: number; peak: number }>();
  for (const [cycle, value] of counts) {
    const key = Math.floor((cycle - 1) / bucket) * bucket + 1;
    const slot = slots.get(key) ?? { sum: 0, peak: 0 };
    slot.sum += value;
    slot.peak = Math.max(slot.peak, value);
    slots.set(key, slot);
  }
  const max = bucket === 1 ? Math.max(1, maxPerCycle) : Math.max(1, ...[...slots.values()].map((s) => s.sum));
  const pad = { left: 34, right: 8, top: 8, bottom: 18 };
  const x = linearScale(1, to + 1, pad.left, width - pad.right);
  const y = linearScale(0, max, height - pad.bottom, pad.top);
  numericAxis(svg, { x: pad.left, y: pad.top, width: width - pad.left - pad.right, height: height - pad.top - pad.bottom, min: 0, max });
  const bar = (from: number, value: number, tip: () => string): void => {
    const rect = svgEl('rect', {
      x: x(from) + 0.5,
      y: y(value),
      width: Math.max(1, x(from + bucket) - x(from) - 1),
      height: Math.max(0, height - pad.bottom - y(value)),
      fill: 'var(--accent)',
      opacity: 0.75,
      rx: 1.5,
    });
    hoverTarget(rect, tip);
    svg.append(rect);
  };
  if (bucket === 1) {
    for (let cycle = 1; cycle <= to; cycle++) {
      const value = counts.get(cycle) ?? 0;
      bar(cycle, value, () => `周期 ${cycle}\n${value} 条记录`);
    }
  } else {
    for (let from = 1; from <= to; from += bucket) {
      const end = Math.min(to, from + bucket - 1);
      const slot = slots.get(from) ?? { sum: 0, peak: 0 };
      bar(from, slot.sum, () =>
        [`周期 ${from}${end > from ? ` – ${end}` : ''}（${end - from + 1} 个周期合并成一根柱）`, `合计 ${fmtInt(slot.sum)} 条记录`, `其中最多的一个周期 ${fmtInt(slot.peak)} 条`].join('\n'),
      );
    }
  }
  cycleAxis(svg, { x: pad.left, y: pad.top, width: width - pad.left - pad.right, height: height - pad.top - pad.bottom, from: 1, to });
  return svg;
}

function totals(trace: Trace) {
  let items = 0;
  let closed = 0;
  let open = 0;
  let bubbles = 0;
  const latencies: number[] = [];
  for (const track of trace.tracks.values()) {
    items += track.items.length;
    closed += track.closed;
    open += track.open;
    bubbles += track.bubbles.length;
    latencies.push(...track.latencies);
  }
  const avg = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const max = latencies.length > 0 ? Math.max(...latencies) : 0;
  return { items, closed, open, bubbles, avg, max, latencyCount: latencies.length };
}

function overviewBody(root: HTMLElement, ctx: ViewContext): void {
  const trace = ctx.trace;
  const domains = [...trace.domains.values()].filter((d) => ctx.options.domains.length === 0 || ctx.options.domains.includes(d.name));
  const primary = domains[0];
  const totalsInfo = totals(trace);
  const periodKnown = domains.find((d) => d.periodNs !== undefined);
  const maxCycle = Math.max(0, ...domains.map((d) => d.cycles));
  const spanNs = periodKnown?.periodNs !== undefined ? maxCycle * periodKnown.periodNs : null;

  const stats = el('div', { class: 'stat-row' }, [
    statTile('周期数', countLabel(maxCycle), domains.length > 1 ? `${domains.length} 个时钟域` : primary ? `域 ${primary.name}` : ''),
    spanNs !== null ? statTile('时间跨度', fmtNs(spanNs), `${periodKnown!.periodNs} ns/周期`) : null,
    statTile('事件记录', countLabel(trace.stats.records), `${trace.stats.bytesPerRecord.toFixed(1)} B/记录`),
    statTile('文件大小', fmtBytes(trace.stats.bytes), trace.domains.size > 0 ? `${trace.stats.lines} 行` : ''),
    statTile('追踪对象', countLabel(trace.counters.size + trace.values.size + trace.fsms.size + trace.events.size + trace.tracks.size), `${trace.tracks.size} 轨道 · ${trace.counters.size} 计数器 · ${trace.fsms.size} 状态机`),
    statTile('在飞条目', countLabel(totalsInfo.items), `${totalsInfo.closed} 已结束 · ${totalsInfo.open} 未闭合`),
    statTile('平均延迟', totalsInfo.latencyCount > 0 ? `${totalsInfo.avg.toFixed(2)} 周期` : '—', totalsInfo.latencyCount > 0 ? `最大 ${totalsInfo.max} 周期（${totalsInfo.latencyCount} 条）` : '没有完成的同域条目'),
    statTile('气泡', countLabel(totalsInfo.bubbles), '占用度为 0 的活跃周期'),
    statTile('警告', countLabel(trace.diagnostics.length), trace.diagnostics.length === 0 ? '无异常' : [...trace.diagnosticCounts.keys()].slice(0, 2).join(' · ')),
  ].filter((n): n is HTMLElement => n !== null));
  const summary = card('总览', '文件级统计（按当前时钟域筛选）');
  summary.body.append(stats);
  root.append(summary.root);

  const items = recordKindCounts(trace);
  const kinds = card('记录类型分布', '每条记录只算一次');
  kinds.body.append(legend(items.map((item) => ({ label: item.label, color: item.color, value: countLabel(item.value) }))));
  kinds.body.append(donut(items));

  const perCycle = card('每周期事件数', '事件驱动的轨迹：柱高 = 该周期写了多少条记录');
  if (primary) {
    const scroll = el('div', { class: 'chart-scroll' });
    scroll.append(recordsPerCycleChart(trace, primary.name));
    perCycle.body.append(scroll);
  } else {
    perCycle.body.append(emptyState('没有可显示的时钟域'));
  }

  const grid = el('div', { class: 'grid grid-2' }, [kinds.root, perCycle.root]);
  root.append(grid);

  // 时钟域表
  const domainCard = card('时钟域', '周期只由上升沿推进；`@domain` 的 period/freq 只用于时间换算');
  const rows = [...trace.domains.values()].map((d) => [
    el('code', { text: d.name }),
    String(d.cycles),
    String(d.posEdges),
    String(d.negEdges),
    d.periodNs !== undefined ? `${d.periodNs} ns` : '—',
    d.freqHz !== undefined ? `${fmtCompact(d.freqHz)}Hz` : '—',
    d.declared ? '@domain 已声明' : '隐式建立',
    `${d.firstCycle} – ${d.lastCycle}`,
  ]);
  domainCard.body.append(
    rows.length > 0
      ? el('div', { class: 'table-wrap' }, [
          el('table', { class: 'table' }, [
            el('thead', {}, [tableRow(['域', '周期', '上升沿', '下降沿', '周期(ns)', '频率', '声明', '记录范围'], 'th')]),
            el('tbody', {}, rows.map((cells) => tableRow(cells))),
          ]),
        ])
      : emptyState('没有时钟域'),
  );

  // 元数据 + 目录
  const metaCard = card('元数据', '来自 @meta 指令');
  const metaRows = Object.entries(trace.meta);
  metaCard.body.append(
    metaRows.length > 0
      ? el('dl', { class: 'kv' }, metaRows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]))
      : emptyState('没有 @meta'),
  );

  root.append(el('div', { class: 'grid grid-2' }, [domainCard.root, metaCard.root]));

  // 延迟概览（各轨道）
  const latencyCard = card('各轨道延迟', '同域完成条目的周期差；跨域条目不给周期延迟');
  const trackRows = [...trace.tracks.values()].map((track) => {
    const stats2 = latencyStats(track);
    return [
      el('code', { text: track.name }),
      track.domain,
      String(track.items.length),
      String(track.closed),
      String(track.open),
      stats2.count > 0 ? `${stats2.min} / ${stats2.avg.toFixed(2)} / ${stats2.max}` : '—',
      String(track.bubbles.length),
    ];
  });
  latencyCard.body.append(
    trackRows.length > 0
      ? el('div', { class: 'table-wrap' }, [
          el('table', { class: 'table' }, [
            el('thead', {}, [tableRow(['轨道', '域', '条目', '已结束', '未闭合', '延迟 最小/平均/最大', '气泡周期'], 'th')]),
            el('tbody', {}, trackRows.map((cells) => tableRow(cells))),
          ]),
        ])
      : emptyState('这份轨迹没有 pip 轨道'),
  );
  root.append(latencyCard.root);
}

let mountedContainer: HTMLElement | null = null;

export const overviewView: View = {
  id: 'overview',
  title: '总览',
  hint: '周期、事件、延迟、气泡、警告',
  mount(container, ctx) {
    mountedContainer = container;
    overviewBody(container, ctx);
  },
  refresh(ctx, reason) {
    if (reason !== 'options' || mountedContainer === null) return;
    clear(mountedContainer);
    overviewBody(mountedContainer, ctx);
  },
};

export default overviewView;
