/**
 * Canvas2D 后端 —— WebGPU 不可用时的兜底（老浏览器、软件渲染、驱动出问题……）
 *
 * 形状同样是"一帧画完、不建 DOM 节点"：这里的瓶颈是 CPU 光栅化，但节点数不再随数据增长，
 * 几万个块也只是几十万次路径填充，比往 DOM 里塞 4 万个节点（每次缩放 1.7 秒）快得多。
 *
 * 两个实现细节：
 * - 切角自己用 moveTo/lineTo 画：`roundRect` 不是所有环境都有，而且它只支持圆角、不支持切角；
 * - 折线直接 `stroke`：跟原来 SVG 里的阶梯波形一个画法（lineJoin/lineCap = round），
 *   线宽、端点圆头都交给 canvas，不用像 WebGPU 那样在 CPU 上展开三角形。
 *
 * 颜色和 alpha 原样交给 canvas（`fillStyle`/`globalAlpha`）：CSS 颜色它自己认识，
 * `#rrggbbaa` 里的 alpha 也会跟 `globalAlpha` 相乘，这里不用解析。
 */
import type { RasterBackend, RasterScene } from './raster.ts';
import { writeBoxOutline } from './raster.ts';

/** 切角轮廓 12 个 float（xy × 6）的复用缓冲：一帧要画几万个块，不能每个块都新建数组 */
const OUTLINE_FLOATS = 12;

export function createCanvas2DBackend(canvas: HTMLCanvasElement): RasterBackend {
  const context = canvas.getContext('2d');
  // 拿不到 2D context 是真没辙了（canvas 已被别的后端占用之类），这里只能报错
  if (context === null) throw new Error('Canvas2D 后端不可用：canvas.getContext("2d") 返回 null');
  context.lineJoin = 'round';
  context.lineCap = 'round';
  const outline = new Float32Array(OUTLINE_FLOATS);

  return {
    kind: 'canvas2d',

    draw(scene: RasterScene): void {
      context.clearRect(0, 0, scene.width, scene.height);
      // 与 WebGPU 后端同一套坐标：形状坐标减去可见区原点（滚动偏移）
      context.translate(-(scene.offsetX ?? 0), -(scene.offsetY ?? 0));

      for (const box of scene.boxes) {
        if (box.w <= 0 || box.h <= 0) continue; // 退化的块连路径都不用建
        writeBoxOutline(box, outline);
        context.beginPath();
        context.moveTo(outline[0]!, outline[1]!);
        context.lineTo(outline[2]!, outline[3]!);
        context.lineTo(outline[4]!, outline[5]!);
        context.lineTo(outline[6]!, outline[7]!);
        context.lineTo(outline[8]!, outline[9]!);
        context.lineTo(outline[10]!, outline[11]!);
        context.closePath();
        context.globalAlpha = box.alpha;
        context.fillStyle = box.color;
        context.fill();
      }

      for (const path of scene.paths) {
        if (path.points.length < 4 || path.width <= 0) continue;
        context.beginPath();
        context.moveTo(path.points[0]!, path.points[1]!);
        for (let i = 2; i + 1 < path.points.length; i += 2) {
          context.lineTo(path.points[i]!, path.points[i + 1]!);
        }
        context.globalAlpha = path.alpha;
        context.strokeStyle = path.color;
        context.lineWidth = path.width;
        context.stroke();
      }

      // 用完复位：下次画块时不带上这次折线的 alpha，也不用让每个块自己设一遍
      context.globalAlpha = 1;
      context.restore(); // 还原滚动偏移的 translate（2D 变换会累积）
    },

    destroy(): void {
      // Canvas2D 没有要释放的资源；清掉画面，免得调用方换成别的后端时还留着上一帧
      context.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}
