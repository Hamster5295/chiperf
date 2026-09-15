/**
 * 光栅后端的纯函数测试：顶点构造与颜色解析。
 *
 * 这里**不碰 GPU、也不碰 DOM**（`createRasterBackend` 要真 canvas 和 adapter，测不了也不该测）：
 * 真正容易算错、而且错了很难看出来的恰恰是几何 —— 切角顶点位置、三角带的铺法、
 * 折线三角形数量、颜色直通 alpha 的约定。这些错了的表现分别是：块画歪、半透明处颜色变深、
 * 线宽不对、透明段发黑。
 */
import { describe, expect, test } from 'bun:test';
import type { RasterBox, RasterPath, RasterScene } from '../src/raster.ts';
import {
  BOX_INSTANCE_FLOATS,
  BOX_QUAD_TEMPLATE,
  BOX_QUAD_VERTEX_COUNT,
  BOX_STRIP_ORDER,
  LINE_VERTEX_FLOATS,
  boxOutline,
  buildVertices,
  parseColor,
  pathTriangleCount,
} from '../src/raster.ts';

/** 边界顺序的 6 个顶点里，每个顶点属于哪一端：-1 左端、+1 右端、0 尖点 */
const CORNER_ENDS = [0, -1, 1, 0, 1, -1];

const BOX: RasterBox = { x: 10, y: 20, w: 100, h: 40, color: '#3b82f6', alpha: 0.5, chamfer: 10 };

const LINE: RasterPath = { points: [0, 0, 10, 0, 10, 10], width: 2, color: '#ffffff', alpha: 1 };

function area(points: [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[(i + 1) % points.length]!;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

describe('parseColor', () => {
  test('#rrggbb → 0..1 的分量', () => {
    expect(parseColor('#3b82f6')).toEqual({ rgb: [59 / 255, 130 / 255, 246 / 255], alpha: 1 });
    expect(parseColor('#000000')).toEqual({ rgb: [0, 0, 0], alpha: 1 });
    expect(parseColor('#ffffff')).toEqual({ rgb: [1, 1, 1], alpha: 1 });
  });

  test('颜色自带的 alpha 单独给出来（#rrggbbaa、rgba()）', () => {
    expect(parseColor('#3b82f680')?.alpha).toBeCloseTo(128 / 255, 6);
    expect(parseColor('rgba(59, 130, 246, 0.5)')?.alpha).toBeCloseTo(0.5, 6);
  });

  test('解析不了返回 null（不猜，也不抛）', () => {
    expect(parseColor('var(--accent)')).toBeNull();
    expect(parseColor('')).toBeNull();
  });
});

describe('切角矩形轮廓', () => {
  test('chamfer = 10：左右两端各收 10，尖点在左右边中点', () => {
    // 6 个顶点按边界顺序：左尖、左上、右上、右尖、右下、左下
    expect(boxOutline(BOX)).toEqual([10, 40, 20, 20, 100, 20, 110, 40, 100, 60, 20, 60]);
  });

  test('chamfer = 0 退化成矩形（没有切角，顶点落在矩形边上）', () => {
    expect(boxOutline({ ...BOX, chamfer: 0 })).toEqual([10, 40, 10, 20, 110, 20, 110, 40, 110, 60, 10, 60]);
  });

  test('chamfer 超过半宽被夹住：左右两端不能互相穿过去', () => {
    const outline = boxOutline({ ...BOX, chamfer: 500 });
    expect(outline).toEqual([10, 40, 60, 20, 60, 20, 110, 40, 60, 60, 60, 60]);
    // 夹住之后仍然是"从左到右"的合法六边形：宽度不能变成负数
    const xs = outline.filter((_, i) => i % 2 === 0);
    expect(Math.max(...xs)).toBe(110);
    expect(Math.min(...xs)).toBe(10);
  });

  test('宽度为 0 的块不产生 NaN', () => {
    expect(boxOutline({ ...BOX, w: 0, chamfer: 4 }).every(Number.isFinite)).toBe(true);
  });
});

describe('三角带模板', () => {
  test('顺序是 6 个边界顶点的一个排列', () => {
    expect(BOX_QUAD_VERTEX_COUNT).toBe(6);
    expect(BOX_QUAD_TEMPLATE.length).toBe(18);
    expect(BOX_STRIP_ORDER).toHaveLength(6);
    expect([...BOX_STRIP_ORDER].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test('四个三角形正好铺满六边形：不重叠（重叠会让半透明块叠出深色带）、也不漏画', () => {
    // 单位方块（w = h = 1）时轮廓坐标就是单位坐标，切角宽度 = chamfer
    const cut = 0.2;
    const outline = boxOutline({ x: 0, y: 0, w: 1, h: 1, color: '#000000', alpha: 1, chamfer: cut });
    const hexagon = Array.from({ length: 6 }, (_, i): [number, number] => [outline[i * 2]!, outline[i * 2 + 1]!]);
    const strip = BOX_STRIP_ORDER.map((corner) => hexagon[corner]!);

    let triangles = 0;
    for (let i = 0; i + 2 < strip.length; i++) triangles += area([strip[i]!, strip[i + 1]!, strip[i + 2]!]);
    expect(area(hexagon)).toBeCloseTo(1 - cut, 6);
    expect(triangles).toBeCloseTo(area(hexagon), 6);
  });

  test('模板 + 切角公式 = 轮廓顶点（顶点着色器就是这条公式）', () => {
    const cut = 0.2;
    const outline = boxOutline({ x: 0, y: 0, w: 1, h: 1, color: '#000000', alpha: 1, chamfer: cut });
    BOX_STRIP_ORDER.forEach((corner, slot) => {
      const unitX = BOX_QUAD_TEMPLATE[slot * 3]!;
      const unitY = BOX_QUAD_TEMPLATE[slot * 3 + 1]!;
      const end = BOX_QUAD_TEMPLATE[slot * 3 + 2]!;
      expect(end).toBe(CORNER_ENDS[corner]!);
      // 着色器里是 unitX - end * cut：左端（-1）往右收、右端（+1）往左收、尖点不动
      expect(unitX - end * cut).toBeCloseTo(outline[corner * 2]!, 6);
      expect(unitY).toBeCloseTo(outline[corner * 2 + 1]!, 6);
    });
  });
});

describe('buildVertices', () => {
  test('空场景不报错，缓冲为空', () => {
    const geometry = buildVertices({ width: 800, height: 600, boxes: [], paths: [] });
    expect(geometry.boxCount).toBe(0);
    expect(geometry.lineVertexCount).toBe(0);
    expect(geometry.boxes.length).toBe(0);
    expect(geometry.lines.length).toBe(0);
  });

  test('块 → 9 个实例浮点：中心、半宽半高、chamfer、直通 rgba', () => {
    const geometry = buildVertices({ width: 800, height: 600, boxes: [BOX], paths: [] });
    expect(geometry.boxCount).toBe(1);
    const instance = [...geometry.boxes.slice(0, BOX_INSTANCE_FLOATS)];
    expect(instance[0]).toBeCloseTo(60, 5); // cx
    expect(instance[1]).toBeCloseTo(40, 5); // cy
    expect(instance[2]).toBeCloseTo(50, 5); // halfW
    expect(instance[3]).toBeCloseTo(20, 5); // halfH
    expect(instance[4]).toBe(10); // chamfer 原样交给着色器
    expect(instance[5]).toBeCloseTo(59 / 255, 5);
    expect(instance[6]).toBeCloseTo(130 / 255, 5);
    expect(instance[7]).toBeCloseTo(246 / 255, 5);
    expect(instance[8]).toBeCloseTo(0.5, 5); // alpha 直通（不预乘，预乘在着色器里做）
  });

  test('折线：每段 2 个三角形，顶点数 = 三角形数 * 3', () => {
    expect(pathTriangleCount(LINE)).toBe(4);
    const geometry = buildVertices({ width: 100, height: 100, boxes: [], paths: [LINE] });
    expect(geometry.lineVertexCount).toBe(12);
    expect(geometry.lineVertexCount).toBe(pathTriangleCount(LINE) * 3);
  });

  test('折线的顶点颜色也是直通 alpha', () => {
    const path: RasterPath = { points: [0, 0, 10, 0], width: 2, color: '#3b82f6', alpha: 0.25 };
    const geometry = buildVertices({ width: 100, height: 100, boxes: [], paths: [path] });
    expect(geometry.lines[2]).toBeCloseTo(59 / 255, 5);
    expect(geometry.lines[3]).toBeCloseTo(130 / 255, 5);
    expect(geometry.lines[4]).toBeCloseTo(246 / 255, 5);
    expect(geometry.lines[5]).toBeCloseTo(0.25, 5);
  });

  test('线宽 2 的水平线：顶点落在 y = ±1（法线方向与长度都对）', () => {
    const path: RasterPath = { points: [0, 0, 10, 0], width: 2, color: '#ffffff', alpha: 1 };
    const geometry = buildVertices({ width: 100, height: 100, boxes: [], paths: [path] });
    // 两个三角形：(P+o, Q+o, Q-o) 与 (P+o, Q-o, P-o)，o = 半宽法线
    const xs: number[] = [];
    const ys: number[] = [];
    for (let v = 0; v < geometry.lineVertexCount; v++) {
      xs.push(geometry.lines[v * LINE_VERTEX_FLOATS]!);
      ys.push(geometry.lines[v * LINE_VERTEX_FLOATS + 1]!);
    }
    expect(xs).toEqual([0, 10, 10, 0, 10, 0]);
    expect(ys).toEqual([-1, -1, 1, -1, 1, 1]);
  });

  test('重复点/零长段：顶点仍然是有限数（NaN 会让整次 draw 看不见）', () => {
    const degenerate: RasterPath = { points: [5, 5, 5, 5, 5, 6], width: 2, color: '#ffffff', alpha: 1 };
    expect(pathTriangleCount({ points: [5, 5], width: 2, color: '#ffffff', alpha: 1 })).toBe(0);
    const geometry = buildVertices({ width: 10, height: 10, boxes: [], paths: [degenerate] });
    expect(geometry.lineVertexCount).toBe(12); // 两段（其中一段零长）→ 4 个三角形
    expect([...geometry.lines].every(Number.isFinite)).toBe(true);
  });

  test('点数不足两条的折线不画', () => {
    const scene: RasterScene = {
      width: 10,
      height: 10,
      boxes: [],
      paths: [{ points: [1, 1], width: 2, color: '#ffffff', alpha: 1 }],
    };
    expect(buildVertices(scene).lineVertexCount).toBe(0);
  });

  test('复用缓冲：场景不变时不重新分配（一帧一次，别每帧给 GC 送几 MB）', () => {
    const scene: RasterScene = { width: 100, height: 100, boxes: [BOX, BOX], paths: [LINE] };
    const first = buildVertices(scene);
    const second = buildVertices(scene, first);
    expect(second.boxes).toBe(first.boxes);
    expect(second.lines).toBe(first.lines);
    // 复用的数组里只有前 boxCount 段有效：别把上一帧多出来的块也画出来
    expect(second.boxCount).toBe(2);
  });

  test('场景变大时缓冲跟着变长，不会截断', () => {
    const first = buildVertices({ width: 10, height: 10, boxes: [BOX], paths: [] });
    const second = buildVertices({ width: 10, height: 10, boxes: [BOX, BOX, BOX], paths: [] }, first);
    expect(second.boxCount).toBe(3);
    expect(second.boxes.length).toBeGreaterThanOrEqual(3 * BOX_INSTANCE_FLOATS);
    expect(second.boxes[2 * BOX_INSTANCE_FLOATS]).toBeCloseTo(60, 5);
  });

  test('解析不了的颜色按黑色画，不抛错', () => {
    const geometry = buildVertices({
      width: 10,
      height: 10,
      boxes: [{ ...BOX, color: 'var(--accent)' }],
      paths: [],
    });
    expect([...geometry.boxes.slice(0, BOX_INSTANCE_FLOATS)].every(Number.isFinite)).toBe(true);
    expect(geometry.boxes[5]).toBe(0);
  });
});
