/**
 * 光栅后端 —— 把波形的"形状"从 DOM 里搬进画布
 *
 * 为什么：时间轴原来一个块/一段就是一个 SVG 节点，4 万个节点时**缩放一次要 1.7 秒** ——
 * 瓶颈是 DOM 树本身（样式重算 + 布局 + 合成），不是绘制算法。改成：形状（切角矩形、阶梯折线）
 * 交给 GPU/Canvas2D 一帧画完，节点数不再随数据量增长；**文字与悬停高亮仍留在 SVG 里**，
 * 布局、命中测试、可访问性都还靠 DOM。
 *
 * 本文件只放：公共类型、纯函数（顶点构造 / 颜色解析 / 轮廓）、后端选择。
 * 具体实现见 raster-webgpu.ts 与 raster-canvas2d.ts。
 * 模块顶层不做任何事（不建 canvas、不请求 adapter、不读 location），import 无副作用。
 *
 * 坐标系：一律是**设备像素**（调用方按 DPR 设好 canvas.width/height 后传 scene.width/height），
 * y 轴向下。本模块不读 DPR，也不改 canvas 尺寸。
 */
import { parseCssColor } from './contrast.ts';
import { createCanvas2DBackend } from './raster-canvas2d.ts';
// 后端模块反过来 import 本文件（类型 + 纯函数），构成循环引用：
// 两个后端都**只在函数体内**用本文件的绑定，顶层不碰，所以求值顺序不影响结果。
import { createWebGpuBackend } from './raster-webgpu.ts';

// ------------------------------------------------------------------ 契约类型

/** 一个"切角矩形"：正矩形 + 两端斜切宽度 chamfer（0 = 普通矩形）。用于流水线条目/数值块/气泡 */
export interface RasterBox { x: number; y: number; w: number; h: number; color: string; alpha: number; chamfer: number; }
/** 一条折线（设备像素坐标），例如阶梯波形；width = 线宽 */
export interface RasterPath { points: number[]; width: number; color: string; alpha: number; }
/**
 * 一帧要画的东西。**画布是视口大小的**，所以坐标有两套：
 * 形状坐标仍是"绘图坐标系"（与 SVG 用户坐标一致），`offsetX/offsetY` 表示这块可见区域
 * 在绘图坐标系里的左上角 —— 即滚动位置。滚动时只要改偏移重画，顶点数据可以原样留着。
 */
export interface RasterScene {
  /** 视口尺寸（设备像素） */
  width: number;
  height: number;
  /** 可见区左上角在绘图坐标系里的位置（默认 0,0） */
  offsetX?: number;
  offsetY?: number;
  boxes: RasterBox[];
  paths: RasterPath[];
}
export interface RasterBackend {
  readonly kind: 'webgpu' | 'canvas2d';
  /** 把整个场景重画一遍（调用方每帧构造新 scene，不做增量） */
  draw(scene: RasterScene): void;
  destroy(): void;
}

// ------------------------------------------------------------------ 顶点布局

/** 切角四边形的顶点数：左右两个尖点 + 四个角，正好用 6 个顶点的三角带画完 */
export const BOX_QUAD_VERTEX_COUNT = 6;
/** 顶点属性：(unitX 0|1, unitY 0|0.5|1, end -1|0|+1)，共 3 个 float */
export const BOX_TEMPLATE_FLOATS = 3;
/** 实例属性：cx, cy, halfW, halfH, chamfer, r, g, b, a（直通 alpha，预乘在着色器里做） */
export const BOX_INSTANCE_FLOATS = 9;
/** 折线顶点属性：x, y, r, g, b, a（同上，直通 alpha） */
export const LINE_VERTEX_FLOATS = 6;
/** 折线每个线段展开成 2 个三角形（一个四边形） */
export const LINE_TRIANGLES_PER_SEGMENT = 2;

/**
 * 切角矩形的 6 个顶点，**边界顺序**（y 向下，顺时针）：
 * 0 左尖点、1 左上、2 右上、3 右尖点、4 右下、5 左下。
 *
 * `unitX/unitY` 是未切角的单位坐标（x ∈ 0|1、y ∈ 0|0.5|1），`end` 表示这个顶点挂在哪一端：
 * -1 = 左端（要往右收）、+1 = 右端（要往左收）、0 = 尖点（不收）。
 * 顶点着色器、Canvas2D 轮廓、本文件的 `boxOutline` 都用这张表，保证两边画的形状一致。
 */
const BOX_CORNERS: readonly (readonly [number, number, number])[] = [
  [0, 0.5, 0], // 0 左尖点
  [0, 0, -1], // 1 左上
  [1, 0, 1], // 2 右上
  [1, 0.5, 0], // 3 右尖点
  [1, 1, 1], // 4 右下
  [0, 1, -1], // 5 左下
];

/**
 * 三角带里这 6 个顶点的顺序（= 上表的下标）。
 *
 * 三角带的第 i 个三角形取第 (i, i+1, i+2) 个顶点，所以**不能直接照抄边界顺序**：
 * 按边界顺序连出来的带会自相交/漏画。这里重排成「左尖 → 左上 → 左下 → 右上 → 右下 → 右尖」，
 * 四个三角形正好是「左楔形 + 矩形上半 + 矩形下半 + 右楔形」，不重叠也不留缝。
 * 为什么在乎重叠：半透明块的叠合处颜色会加深（premultiplied alpha 也是叠一次深一次），
 * 波形里半透明推断段挨在一起时会出现一条条深色带。
 */
export const BOX_STRIP_ORDER: readonly number[] = [0, 1, 5, 2, 4, 3];

/** 静态顶点缓冲内容：按 `BOX_STRIP_ORDER` 排好的 (unitX, unitY, end)，共 18 个 float */
export const BOX_QUAD_TEMPLATE: Float32Array = buildQuadTemplate();

function buildQuadTemplate(): Float32Array {
  const out = new Float32Array(BOX_QUAD_VERTEX_COUNT * BOX_TEMPLATE_FLOATS);
  for (let i = 0; i < BOX_STRIP_ORDER.length; i++) {
    const corner = BOX_CORNERS[BOX_STRIP_ORDER[i]!]!;
    out[i * BOX_TEMPLATE_FLOATS] = corner[0];
    out[i * BOX_TEMPLATE_FLOATS + 1] = corner[1];
    out[i * BOX_TEMPLATE_FLOATS + 2] = corner[2];
  }
  return out;
}

// ------------------------------------------------------------------ 纯函数

export type Rgb01 = [number, number, number];

/**
 * CSS 颜色 → 0..1 的 rgb + 颜色自带的 alpha；解析不了返回 null。
 * 复用 contrast.ts 的解析器（`#rgb`/`#rrggbb`/`#rrggbbaa`/`rgb()`/`rgba()` 都认），不再写第二套。
 * `#rrggbbaa` 这种自带 alpha 的颜色，alpha 由调用方乘进 box/path 自己的 alpha。
 */
export function parseColor(color: string): { rgb: Rgb01; alpha: number } | null {
  const parsed = parseCssColor(color);
  if (parsed === null) return null;
  return { rgb: [parsed.rgb[0] / 255, parsed.rgb[1] / 255, parsed.rgb[2] / 255], alpha: parsed.alpha };
}

/**
 * 归一化切角宽度（0..0.5，以 box 宽度为单位）。
 * chamfer 是设备像素：先夹到不超过半宽（否则左右两端会互相穿过去、形状翻面），
 * 再除以宽度。宽度不足 1px 时按 1px 折算，顺带避开除零 —— 着色器里是**同一条公式**。
 */
function normalizedCut(chamfer: number, width: number): number {
  return Math.min(Math.max(chamfer, 0), width * 0.5) / Math.max(width, 1);
}

/**
 * 把 box 的 6 个切角顶点按**边界顺序**写进 `out`（xy 扁平，共 12 个数，设备像素）。
 * chamfer = 0 时退化成矩形：左右尖点落在矩形左右边中点上、四个角重合到矩形角上。
 * 复用外部缓冲是为了 Canvas2D 那条路：一帧几万个块，不能每个块新建一个数组。
 */
export function writeBoxOutline(box: RasterBox, out: Float32Array): void {
  const cut = normalizedCut(box.chamfer, box.w) * box.w;
  const left = box.x;
  const right = box.x + box.w;
  const top = box.y;
  const bottom = box.y + box.h;
  const middle = box.y + box.h * 0.5;
  out[0] = left;
  out[1] = middle; // 左尖点
  out[2] = left + cut;
  out[3] = top; // 左上
  out[4] = right - cut;
  out[5] = top; // 右上
  out[6] = right;
  out[7] = middle; // 右尖点
  out[8] = right - cut;
  out[9] = bottom; // 右下
  out[10] = left + cut;
  out[11] = bottom; // 左下
}

/** `writeBoxOutline` 的便利包装（可读性 / 测试用；热路径请用上面那个免分配的） */
export function boxOutline(box: RasterBox): number[] {
  const out = new Float32Array(12);
  writeBoxOutline(box, out);
  return [...out];
}

/**
 * 折线展开成多少个三角形：每段 2 个；点数 < 2（含奇数尾巴被截掉后）返回 0。
 * 顶点数 = 三角形数 * 3，调用方据此算缓冲长度。
 */
export function pathTriangleCount(path: RasterPath): number {
  const points = Math.floor(path.points.length / 2);
  return points < 2 ? 0 : (points - 1) * LINE_TRIANGLES_PER_SEGMENT;
}

/**
 * 顶点/绘制命令的纯函数产物。
 * 两个数组都是**后备缓冲**：只有前 `boxCount * BOX_INSTANCE_FLOATS` /
 * `lineVertexCount * LINE_VERTEX_FLOATS` 个 float 有效，其余是上次复用留下的垃圾。
 * 把整个返回值当 `reuse` 传回来即可复用缓冲（一帧一次，别每帧给 GC 送几 MB）。
 */
export interface RasterVertices {
  boxes: Float32Array;
  boxCount: number;
  lines: Float32Array;
  lineVertexCount: number;
}

/**
 * `RasterScene` → 顶点数据（纯函数，不碰 GPU/DOM）：
 * - `boxes`：instanced 四边形的实例数据（中心、半宽半高、chamfer、直通 rgba），
 *   形状本身由 6 顶点静态模板 + 顶点着色器里的切角公式生成，所以每个块只占 9 个 float。
 * - `lines`：折线在 CPU 上展开成**三角形列表**（每段 2 个三角形、共享顶点法线），
 *   因为线宽要精确到亚像素，靠光栅器的线宽不可靠，也省得为每条折线单独 draw。
 */
export function buildVertices(scene: RasterScene, reuse?: RasterVertices): RasterVertices {
  const boxFloats = scene.boxes.length * BOX_INSTANCE_FLOATS;
  const lineFloats = scene.paths.reduce((sum, path) => sum + pathTriangleCount(path) * 3 * LINE_VERTEX_FLOATS, 0);
  const boxes = reuse !== undefined && reuse.boxes.length >= boxFloats ? reuse.boxes : new Float32Array(boxFloats);
  const lines = reuse !== undefined && reuse.lines.length >= lineFloats ? reuse.lines : new Float32Array(lineFloats);

  // 颜色解析带"相邻同色"记忆：一帧里绝大多数相邻形状同色（同一轨道的块），省掉重复解析
  let lastColor = '';
  let red = 0;
  let green = 0;
  let blue = 0;
  let colorAlpha = 1;
  const useColor = (color: string): void => {
    if (color === lastColor) return;
    lastColor = color;
    const parsed = parseColor(color);
    // 解析不了（`var(--x)`、`color-mix()` 之类）按黑色画：契约保证 color 是 `#rrggbb`，这里只是不崩
    red = parsed === null ? 0 : parsed.rgb[0];
    green = parsed === null ? 0 : parsed.rgb[1];
    blue = parsed === null ? 0 : parsed.rgb[2];
    colorAlpha = parsed === null ? 1 : parsed.alpha;
  };

  let boxAt = 0;
  for (const box of scene.boxes) {
    useColor(box.color);
    boxes[boxAt] = box.x + box.w * 0.5;
    boxes[boxAt + 1] = box.y + box.h * 0.5;
    boxes[boxAt + 2] = box.w * 0.5;
    boxes[boxAt + 3] = box.h * 0.5;
    boxes[boxAt + 4] = box.chamfer; // 设备像素，换算放在着色器里（跟 Canvas2D 用同一条公式）
    boxes[boxAt + 5] = red;
    boxes[boxAt + 6] = green;
    boxes[boxAt + 7] = blue;
    boxes[boxAt + 8] = colorAlpha * box.alpha;
    boxAt += BOX_INSTANCE_FLOATS;
  }

  let lineAt = 0;
  const vertex = (x: number, y: number, alpha: number): void => {
    lines[lineAt] = x;
    lines[lineAt + 1] = y;
    lines[lineAt + 2] = red;
    lines[lineAt + 3] = green;
    lines[lineAt + 4] = blue;
    lines[lineAt + 5] = colorAlpha * alpha;
    lineAt += LINE_VERTEX_FLOATS;
  };

  // 段方向与点法线的复用缓冲：按场景里最长的那条折线分配一次，之后各条折线共用
  let directions = new Float32Array(0);
  let offsets = new Float32Array(0);

  for (const path of scene.paths) {
    const count = Math.floor(path.points.length / 2);
    const segments = count - 1;
    if (segments < 1) continue;
    useColor(path.color);
    const half = path.width * 0.5;

    if (directions.length < segments * 2) directions = new Float32Array(segments * 2);
    for (let i = 0; i < segments; i++) {
      const dx = path.points[i * 2 + 2]! - path.points[i * 2]!;
      const dy = path.points[i * 2 + 3]! - path.points[i * 2 + 1]!;
      const length = Math.hypot(dx, dy);
      if (length > 1e-6) {
        directions[i * 2] = dx / length;
        directions[i * 2 + 1] = dy / length;
      } else {
        // 零长段（重复点）：沿用上一段的方向；第一段就给个水平方向。
        // 别让 0/0 算成 NaN —— NaN 顶点会污染整次 draw 的输出
        directions[i * 2] = i > 0 ? directions[i * 2 - 2]! : 1;
        directions[i * 2 + 1] = i > 0 ? directions[i * 2 - 1]! : 0;
      }
    }

    // 每个点算一个偏移向量（法线按 miter 放大），相邻两段共用 ⇒ 拐角处无缝、也不重叠
    if (offsets.length < count * 2) offsets = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const before = i > 0 ? i - 1 : 0;
      const after = i < segments ? i : segments - 1;
      const bx = directions[before * 2]!;
      const by = directions[before * 2 + 1]!;
      const ax = directions[after * 2]!;
      const ay = directions[after * 2 + 1]!;
      // 段法线 = 方向转 90°（取哪一侧都行，整条折线一致即可）
      let nx = by + ay;
      let ny = -bx - ax;
      const length = Math.hypot(nx, ny);
      let scale = 1;
      if (length > 1e-6) {
        nx /= length;
        ny /= length;
        // 拐角越尖，miter 越长；限制长度，免得尖角甩出一根长刺
        scale = Math.min(1 / Math.max(nx * ay - ny * ax, 1e-3), 4);
      } else {
        nx = ay;
        ny = -ax; // 180° 折返：退回单段法线
      }
      offsets[i * 2] = nx * half * scale;
      offsets[i * 2 + 1] = ny * half * scale;
    }

    for (let i = 0; i < segments; i++) {
      const px = path.points[i * 2]!;
      const py = path.points[i * 2 + 1]!;
      const qx = path.points[i * 2 + 2]!;
      const qy = path.points[i * 2 + 3]!;
      const ox = offsets[i * 2]!;
      const oy = offsets[i * 2 + 1]!;
      const rx = offsets[i * 2 + 2]!;
      const ry = offsets[i * 2 + 3]!;
      // 两个三角形：(P+o, Q+r, Q-r) 与 (P+o, Q-r, P-o)
      vertex(px + ox, py + oy, path.alpha);
      vertex(qx + rx, qy + ry, path.alpha);
      vertex(qx - rx, qy - ry, path.alpha);
      vertex(px + ox, py + oy, path.alpha);
      vertex(qx - rx, qy - ry, path.alpha);
      vertex(px - ox, py - oy, path.alpha);
    }
  }

  return { boxes, boxCount: scene.boxes.length, lines, lineVertexCount: lineAt / LINE_VERTEX_FLOATS };
}

// ------------------------------------------------------------------ 后端选择

/** `?gpu=` 的三态：默认自动，`?gpu=0` 强制 Canvas2D，`?gpu=1` 强制 WebGPU */
type GpuMode = 'auto' | 'off' | 'on';

function gpuMode(): GpuMode {
  if (typeof globalThis.location === 'undefined') return 'auto';
  const value = new URLSearchParams(globalThis.location.search).get('gpu');
  if (value === '0') return 'off';
  if (value === '1') return 'on';
  return 'auto';
}

/**
 * 优先 WebGPU，不可用/初始化失败时回退 Canvas2D；**默认绝不抛错**。
 *
 * - 默认：`navigator.gpu` 存在 → `requestAdapter()` → `requestDevice()`，任一步失败都静默回退；
 * - `?gpu=0`：直接用 Canvas2D（有 GPU 也不用 —— 对比性能、或是怀疑驱动有问题时排查用）；
 * - `?gpu=1`：只接受 WebGPU，拿不到就抛 —— 用来确认"到底有没有走 GPU"，而不是被静默回退骗了。
 *
 * 注意 `?gpu=1` 下 `requestDevice()` 失败也可能是**异步**的（device lost），
 * 那种情况由 WebGPU 后端自己处理成 draw 空操作，见 raster-webgpu.ts。
 */
export async function createRasterBackend(canvas: HTMLCanvasElement): Promise<RasterBackend> {
  const mode = gpuMode();
  if (mode === 'off') return createCanvas2DBackend(canvas);
  if (mode === 'on') return createWebGpuBackend(canvas);
  try {
    return await createWebGpuBackend(canvas);
  } catch {
    // 静默回退：GPU 只是加速手段，拿不到也得能画
    return createCanvas2DBackend(canvas);
  }
}
