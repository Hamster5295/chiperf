/**
 * 分块执行：把"一次画完/一次算完"的大活切成小片，片间把主线程让给浏览器。
 *
 * 为什么需要它：一个 20 万条记录的轨迹，时间轴一次性要建 4 万个 SVG 节点 ——
 * 主线程会被占满 0.8 秒以上，期间页面无法响应、也没有任何反馈。
 * 切片之后：首屏立刻可见、滚动缩放不被卡住、顶部能显示进度。
 *
 * 约定：每个切片最多占用 `budgetMs`，切片之间让出一帧（`requestAnimationFrame`），
 * 因此单片的规模由**时间**决定而不是条目数 —— 慢机器上自动切得更碎。
 */

export interface ChunkOptions {
  /** 每个切片的时间预算（毫秒），默认 8 —— 一帧 16.7ms 的一半左右 */
  budgetMs?: number;
  /** 每次交给 `chunk` 的最小单元数（默认 1）。按字符/字节推进时给一个较大的批，避免调用过碎 */
  batch?: number;
  /** 进度回调：done/total */
  onProgress?: (done: number, total: number) => void;
  /** 中途取消：每片开始前检查，取消后立刻返回 false */
  signal?: AbortSignal;
}

/** 让出一帧，让浏览器有机会绘制与响应输入 */
export function nextFrame(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
  else setTimeout(resolve, 0);
  return promise;
}

/**
 * 把 `0..total` 切成若干区间依次交给 `chunk(from, to)`，每片按时间预算收手。
 * 返回 false 表示被取消（调用方应当丢弃这一轮的产物）。
 */
export async function runChunked(total: number, chunk: (from: number, to: number) => void, options: ChunkOptions = {}): Promise<boolean> {
  const budgetMs = options.budgetMs ?? 8;
  const batch = Math.max(1, Math.floor(options.batch ?? 1));
  let from = 0;
  while (from < total) {
    if (options.signal?.aborted) return false;
    const started = now();
    // 每片至少处理一批，避免"批本身超预算 ⇒ 永远不前进"
    let to = Math.min(total, from + batch);
    chunk(from, to);
    while (to < total && now() - started < budgetMs) {
      from = to;
      to = Math.min(total, from + batch);
      chunk(from, to);
    }
    from = to;
    options.onProgress?.(from, total);
    if (from < total) {
      await nextFrame();
      if (options.signal?.aborted) return false;
    }
  }
  options.onProgress?.(total, total);
  return true;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** 可取消令牌：视图重建/卸载时用它终止上一轮还没画完的分块任务 */
export function abortable(): { signal: AbortSignal; abort: () => void } {
  if (typeof AbortController === 'undefined') {
    // 极端环境（老浏览器）下退化为"永不取消"，行为仍正确，只是不会提前收手
    const never = { aborted: false } as AbortSignal;
    return { signal: never, abort: () => {} };
  }
  const controller = new AbortController();
  return { signal: controller.signal, abort: () => controller.abort() };
}
