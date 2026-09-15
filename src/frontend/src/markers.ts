/**
 * 标记（marker）：波形上最多两个竖线，两个标记之间的区间就是"统计区间"。
 *
 * 为什么要放在共享状态里：标记是在**时间轴**上打的，但要用它筛的是**流水线**与**状态机**
 * 两个视图的统计 —— 于是它不能是时间轴的私有变量，得像 `selection` 那样能被订阅。
 *
 * 约定：
 * - 最多两个；再打一个不会覆盖已有的（调用方据此提示用户先删）；
 * - 两个标记必须落在**同一个域**才算区间（跨域的周期数不可比，spec §6.5）；
 * - 位置用周期号表示，闭区间 `[from, to]`；
 * - 拖拽过程中**不**通知订阅者（`move` 只在松手时调用），否则每移动一像素都要重算统计。
 */

export interface Marker {
  domain: string;
  cycle: number;
}

export interface MarkerRange {
  domain: string;
  from: number;
  to: number;
}

export interface MarkerBus {
  /** 当前标记（按周期从小到大），0~2 个 */
  list(): Marker[];
  /** 打一个标记；已经有 2 个时返回 false（不覆盖） */
  add(marker: Marker): boolean;
  /** 拖拽结束时提交新位置（内部重新排序，允许越过另一个标记） */
  move(index: number, cycle: number): void;
  /** 右键删除某一个 */
  remove(index: number): void;
  clear(): void;
  /** 两个同域标记齐全时给出闭区间；否则 null（统计视图据此决定是否筛选） */
  range(): MarkerRange | null;
  subscribe(listener: (markers: Marker[]) => void): () => void;
}

export const MAX_MARKERS = 2;

export function createMarkerBus(): MarkerBus {
  let markers: Marker[] = [];
  const listeners = new Set<(markers: Marker[]) => void>();

  const sort = (): void => {
    markers = [...markers].sort((a, b) => a.cycle - b.cycle);
  };
  const emit = (): void => {
    for (const listener of listeners) listener(markers.slice());
  };

  return {
    list: () => markers.slice(),

    add(marker) {
      if (markers.length >= MAX_MARKERS) return false;
      markers = [...markers, { domain: marker.domain, cycle: marker.cycle }];
      sort();
      emit();
      return true;
    },

    move(index, cycle) {
      const current = markers[index];
      if (current === undefined || current.cycle === cycle) return;
      markers = markers.map((marker, i) => (i === index ? { domain: marker.domain, cycle } : marker));
      sort();
      emit();
    },

    remove(index) {
      if (markers[index] === undefined) return;
      markers = markers.filter((_, i) => i !== index);
      emit();
    },

    clear() {
      if (markers.length === 0) return;
      markers = [];
      emit();
    },

    range() {
      if (markers.length !== MAX_MARKERS) return null;
      const [first, second] = markers as [Marker, Marker];
      // 跨域没有可比性：宁可返回 null（统计退回全量），也不要拿两条时间轴相减
      if (first.domain !== second.domain) return null;
      return { domain: first.domain, from: first.cycle, to: second.cycle };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
