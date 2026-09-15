/**
 * WebGPU 后端 —— instanced 四边形 + CPU 展开的折线三角形
 *
 * 为什么要它：原来每个块/每段波形都是一个 SVG 节点，4 万个节点缩放一次要 1.7 秒（瓶颈在 DOM
 * 树，不在绘制）。这里整个场景一帧 **两次 draw call** 画完：
 *  - 块：一个 6 顶点静态模板 + instanced 实例数据（中心/半宽半高/chamfer/颜色），
 *    切角在顶点着色器里做（`chamfer` 换算成"以宽度为单位"后把左右两端收进去）；
 *  - 折线：顶点已经在 CPU 上展开成三角形（见 raster.ts 的 buildVertices），
 *    线宽要精确到亚像素，靠光栅器的线宽不可靠。
 *
 * 三条容易踩的约定：
 * 1. 顶点数据里的颜色是**直通 alpha**（不预乘），预乘只在片元着色器里做一次，
 *    配合混合模式 one / one-minus-src-alpha —— 两边状态与数据必须成对，否则半透明会发黑或消失。
 * 2. MSAA 4x：先画到 4 倍采样的纹理再 resolve 到画布纹理，形状边缘才不会有锯齿。
 * 3. `device.lost`（驱动重置、页面被回收）之后不再抛错：draw 变成空操作，画布停在最后一帧。
 *    这里没法原地换成 Canvas2D —— 一个 canvas 只能有一种 context，换后端得由调用方重建
 *    （再走一遍 createRasterBackend 即可）。
 *
 * 模块顶层只声明 WGSL 字符串，不请求 adapter/device、不建 canvas。
 */
import type { RasterBackend, RasterScene, RasterVertices } from './raster.ts';
import { BOX_INSTANCE_FLOATS, BOX_QUAD_TEMPLATE, BOX_QUAD_VERTEX_COUNT, BOX_TEMPLATE_FLOATS, LINE_VERTEX_FLOATS, buildVertices } from './raster.ts';

/**
 * 顶点数据全是设备像素，着色器要自己换算成 NDC；屏幕尺寸只随画布尺寸变，所以用一个
 * 16 字节的 uniform（vec2 后补两个 float 对齐）。
 */
const WGSL = /* wgsl */ `
struct Globals {
  screen: vec2<f32>,
  offset: vec2<f32>,
};

@group(0) @binding(0) var<uniform> globals: Globals;

struct Vertex {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
};

// corner: (unitX 0|1, unitY 0|0.5|1, end -1|0|+1)
// rect:   (cx, cy, halfW, halfH)
// cut:    chamfer（设备像素）
// color:  (r, g, b, a)，直通 alpha
@vertex
fn vs_box(
  @location(0) corner: vec3<f32>,
  @location(1) rect: vec4<f32>,
  @location(2) cut: f32,
  @location(3) color: vec4<f32>,
) -> Vertex {
  // chamfer 设备像素 → 以宽度为单位，并夹到半个宽度：再多左右两端会互相穿过去、形状翻面
  // （这条公式与 raster.ts 的 normalizedCut / writeBoxOutline 必须一致，否则两条后端画出来不一样）
  let unit = clamp(cut, 0.0, rect.z * 0.5) / max(rect.z * 2.0, 1.0);
  // end = -1 左端往右收、+1 右端往左收、0 尖点不动
  let localX = (corner.x - corner.z * unit) * (rect.z * 2.0);
  let localY = (corner.y * 2.0 - 1.0) * rect.w;
  var out: Vertex;
  // 形状坐标是"绘图坐标系"，减掉可见区原点（滚动偏移）后才是视口坐标
  let viewX = rect.x + localX - rect.z - globals.offset.x;
  let viewY = rect.y + localY - rect.w - globals.offset.y;
  out.position = vec4<f32>(
    viewX / globals.screen.x * 2.0 - 1.0,
    1.0 - viewY / globals.screen.y * 2.0,
    0.0,
    1.0,
  );
  out.color = color;
  return out;
}

@vertex
fn vs_line(
  @location(0) pos: vec2<f32>,
  @location(1) color: vec4<f32>,
) -> Vertex {
  var out: Vertex;
  let viewX = pos.x - globals.offset.x;
  let viewY = pos.y - globals.offset.y;
  out.position = vec4<f32>(
    viewX / globals.screen.x * 2.0 - 1.0,
    1.0 - viewY / globals.screen.y * 2.0,
    0.0,
    1.0,
  );
  out.color = color;
  return out;
}

@fragment
fn fs(in: Vertex) -> @location(0) vec4<f32> {
  // premultiplied alpha：颜色先乘 alpha，混合模式是 one / one-minus-src-alpha
  return vec4<f32>(in.color.rgb * in.color.a, in.color.a);
}
`;

// ------------------------------------------------------------------ 最小 WebGPU 类型
// 仓库不许加依赖（@webgpu/types 也是依赖），浏览器 lib.dom 里也还没有 WebGPU，
// 所以只声明实际用到的那几个成员。字段名与字面量都照规范写，接上真机不会错。

type GpuBlendFactor = 'zero' | 'one' | 'src-alpha' | 'one-minus-src-alpha' | 'dst-alpha' | 'one-minus-dst-alpha';
type GpuBlendOperation = 'add' | 'subtract' | 'reverse-subtract' | 'min' | 'max';
type GpuVertexFormat = 'float32' | 'float32x2' | 'float32x3' | 'float32x4';

interface GpuBuffer { destroy(): void; }
interface GpuTexture { createView(): GpuTextureView; destroy(): void; }
interface GpuTextureView {}
interface GpuShaderModule {}
interface GpuBindGroupLayout {}
interface GpuPipelineLayout {}
interface GpuBindGroup {}
interface GpuCommandBuffer {}

interface GpuQueue {
  writeBuffer(buffer: GpuBuffer, bufferOffset: number, data: ArrayBufferView, dataOffset?: number, size?: number): void;
  submit(commandBuffers: GpuCommandBuffer[]): void;
}

interface GpuRenderPass {
  setPipeline(pipeline: GpuRenderPipeline): void;
  setBindGroup(index: number, bindGroup: GpuBindGroup): void;
  setVertexBuffer(slot: number, buffer: GpuBuffer, offset?: number, size?: number): void;
  draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void;
  end(): void;
}

interface GpuColorAttachment {
  view: GpuTextureView;
  resolveTarget?: GpuTextureView | undefined;
  clearValue: { r: number; g: number; b: number; a: number };
  loadOp: 'clear' | 'load';
  storeOp: 'store' | 'discard';
}

interface GpuVertexAttribute { shaderLocation: number; offset: number; format: GpuVertexFormat; }
interface GpuVertexBufferLayout {
  arrayStride: number;
  stepMode?: 'vertex' | 'instance';
  attributes: GpuVertexAttribute[];
}
interface GpuBlendState { srcFactor: GpuBlendFactor; dstFactor: GpuBlendFactor; operation: GpuBlendOperation; }

interface GpuRenderPipeline {
  getBindGroupLayout(index: number): GpuBindGroupLayout;
}

interface GpuDevice {
  readonly queue: GpuQueue;
  /** 驱动重置/页面被回收时 resolve（不是 reject）；resolve 之后本后端的 draw 变成空操作 */
  readonly lost: Promise<unknown>;
  createShaderModule(descriptor: { code: string }): GpuShaderModule;
  createBindGroupLayout(descriptor: { entries: { binding: number; visibility: number; buffer: { type: 'uniform' } }[] }): GpuBindGroupLayout;
  createPipelineLayout(descriptor: { bindGroupLayouts: GpuBindGroupLayout[] }): GpuPipelineLayout;
  createBindGroup(descriptor: { layout: GpuBindGroupLayout; entries: { binding: number; resource: { buffer: GpuBuffer } }[] }): GpuBindGroup;
  createRenderPipeline(descriptor: {
    layout: GpuPipelineLayout;
    vertex: { module: GpuShaderModule; entryPoint: string; buffers: GpuVertexBufferLayout[] };
    fragment: { module: GpuShaderModule; entryPoint: string; targets: { format: string; blend: { color: GpuBlendState; alpha: GpuBlendState } }[] };
    primitive: { topology: 'triangle-list' | 'triangle-strip'; cullMode: 'none' | 'front' | 'back' };
    multisample: { count: number };
  }): GpuRenderPipeline;
  createBuffer(descriptor: { size: number; usage: number }): GpuBuffer;
  createTexture(descriptor: { size: { width: number; height: number }; format: string; sampleCount: number; usage: number }): GpuTexture;
  createCommandEncoder(): { beginRenderPass(descriptor: { colorAttachments: GpuColorAttachment[] }): GpuRenderPass; finish(): GpuCommandBuffer };
  destroy(): void;
}

interface GpuAdapter { requestDevice(): Promise<GpuDevice>; }

interface Gpu {
  requestAdapter(options?: { powerPreference?: 'low-power' | 'high-performance' }): Promise<GpuAdapter | null>;
  getPreferredCanvasFormat?(): string;
}

interface GpuCanvasContext {
  configure(configuration: { device: GpuDevice; format: string; alphaMode: 'opaque' | 'premultiplied' }): void;
  getCurrentTexture(): GpuTexture;
}

// 浏览器全局对象（GPUBufferUsage 等）在 lib.dom 里没有，按规范写常量
const BUFFER_USAGE_VERTEX = 0x20;
const BUFFER_USAGE_COPY_DST = 0x08;
const BUFFER_USAGE_UNIFORM = 0x40;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const SHADER_STAGE_VERTEX = 0x01;

const MSAA_SAMPLES = 4;

/**
 * premultiplied alpha 混合：片元着色器输出的颜色已经乘过 alpha，所以 src 是 one、
 * dst 是 one-minus-src-alpha（写成 src-alpha / one-minus-src-alpha 会把半透明压暗两次）。
 */
const PREMULTIPLIED = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
} as const;

/**
 * 建 WebGPU 后端；任何一步不可用都抛错（显式失败）—— 回退策略在 raster.ts 的
 * createRasterBackend 里，那里才知道调用方是"要 GPU"还是"有没有都行"。
 */
export async function createWebGpuBackend(canvas: HTMLCanvasElement): Promise<RasterBackend> {
  const gpu = (navigator as unknown as { readonly gpu?: Gpu | undefined }).gpu;
  if (gpu === undefined) throw new Error('WebGPU 不可用：navigator.gpu 不存在');
  const adapter = await gpu.requestAdapter();
  if (adapter === null) throw new Error('WebGPU 不可用：requestAdapter() 没有返回 adapter');
  let device: GpuDevice;
  try {
    device = await adapter.requestDevice();
  } catch (error) {
    throw new Error(`WebGPU 不可用：requestDevice() 失败（${String(error)}）`);
  }
  // canvas 已经被别的 context 占用（或环境根本不支持）时也是 null
  const context = (canvas.getContext as unknown as (id: string) => GpuCanvasContext | null)('webgpu');
  if (context === null) throw new Error('WebGPU 不可用：canvas 拿不到 webgpu context');

  const format = gpu.getPreferredCanvasFormat?.() ?? 'bgra8unorm';
  // premultiplied：跟管线里的混合模式、片元着色器的预乘对得上
  context.configure({ device, format, alphaMode: 'premultiplied' });

  const module = device.createShaderModule({ code: WGSL });
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: SHADER_STAGE_VERTEX, buffer: { type: 'uniform' } }],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
  const screen = new Float32Array([1, 1, 0, 0]); // [screen.x, screen.y, offset.x, offset.y]
  const uniformBuffer = device.createBuffer({ size: screen.byteLength, usage: BUFFER_USAGE_COPY_DST | BUFFER_USAGE_UNIFORM });
  const bindGroup = device.createBindGroup({ layout: bindGroupLayout, entries: [{ binding: 0, resource: { buffer: uniformBuffer } }] });

  const templateBuffer = device.createBuffer({ size: BOX_QUAD_TEMPLATE.byteLength, usage: BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST });
  device.queue.writeBuffer(templateBuffer, 0, BOX_QUAD_TEMPLATE);

  // 块：静态模板按顶点步进，实例数据每块 9 个 float 按实例步进
  const boxPipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: {
      module,
      entryPoint: 'vs_box',
      buffers: [
        { arrayStride: BOX_TEMPLATE_FLOATS * 4, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
        {
          arrayStride: BOX_INSTANCE_FLOATS * 4,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 1, offset: 0, format: 'float32x4' }, // cx, cy, halfW, halfH
            { shaderLocation: 2, offset: 4 * 4, format: 'float32' }, // chamfer
            { shaderLocation: 3, offset: 5 * 4, format: 'float32x4' }, // r, g, b, a
          ],
        },
      ],
    },
    fragment: { module, entryPoint: 'fs', targets: [{ format, blend: PREMULTIPLIED }] },
    // 6 顶点模板是一条三角带（4 个三角形铺满六边形）；不剔除面：带里的三角形绕向本来就交替
    primitive: { topology: 'triangle-strip', cullMode: 'none' },
    multisample: { count: MSAA_SAMPLES },
  });

  // 折线：顶点已经在 CPU 上展开成三角形列表
  const linePipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: {
      module,
      entryPoint: 'vs_line',
      buffers: [
        {
          arrayStride: LINE_VERTEX_FLOATS * 4,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 2 * 4, format: 'float32x4' },
          ],
        },
      ],
    },
    fragment: { module, entryPoint: 'fs', targets: [{ format, blend: PREMULTIPLIED }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    multisample: { count: MSAA_SAMPLES },
  });

  let width = 0;
  let height = 0;
  let msaa: GpuTexture | null = null;
  let msaaView: GpuTextureView | null = null;
  let instanceBuffer: GpuBuffer | null = null;
  let instanceBytes = 0;
  let lineBuffer: GpuBuffer | null = null;
  let lineBytes = 0;
  let geometry: RasterVertices | undefined;
  let lost = false;
  let disposed = false;
  let warnedSize = false;

  void device.lost.then((info) => {
    if (disposed) return;
    // 画布停在最后一帧，页面其余部分（SVG 文字、悬停）照常可用；不抛错
    lost = true;
    console.warn('[raster] WebGPU device lost，形状层停止重绘', info);
  });

  /** 画布尺寸变了：MSAA 纹理要跟着重建，uniform 里的屏幕尺寸也要更新 */
  const resize = (nextWidth: number, nextHeight: number): void => {
    width = nextWidth;
    height = nextHeight;
    msaa?.destroy();
    msaa = device.createTexture({
      size: { width: nextWidth, height: nextHeight },
      format,
      sampleCount: MSAA_SAMPLES,
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT,
    });
    msaaView = msaa.createView();
    screen[0] = nextWidth;
    screen[1] = nextHeight;
    device.queue.writeBuffer(uniformBuffer, 0, screen);
  };

  /** 视口尺寸上限：超过就整条 GPU 路径不可用（宁可退回 Canvas2D，也不要画出一帧错的） */
  const maxDimension = (device as unknown as { limits?: { maxTextureDimension2D?: number } }).limits?.maxTextureDimension2D ?? 8192;

  /** 场景大了就把缓冲换大的，平时原样复用（每帧重新建 buffer 太浪费） */
  const ensureInstanceBuffer = (bytes: number): void => {
    if (instanceBuffer !== null && instanceBytes >= bytes) return;
    instanceBuffer?.destroy();
    instanceBytes = Math.max(bytes, instanceBytes * 2);
    instanceBuffer = device.createBuffer({ size: instanceBytes, usage: BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST });
  };

  const ensureLineBuffer = (bytes: number): void => {
    if (lineBuffer !== null && lineBytes >= bytes) return;
    lineBuffer?.destroy();
    lineBytes = Math.max(bytes, lineBytes * 2);
    lineBuffer = device.createBuffer({ size: lineBytes, usage: BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST });
  };

  return {
    kind: 'webgpu',

    draw(scene: RasterScene): void {
      if (lost || disposed) return; // 丢了设备就什么都不做，别再往上抛
      const nextWidth = Math.floor(scene.width);
      const nextHeight = Math.floor(scene.height);
      // 画布被折叠成 0 尺寸时 getCurrentTexture() 会抛，直接跳过这一帧
      if (nextWidth <= 0 || nextHeight <= 0) return;
      if (nextWidth > maxDimension || nextHeight > maxDimension) {
        if (!warnedSize) {
          warnedSize = true;
          console.warn(`[raster] 视口 ${nextWidth}×${nextHeight} 超过 GPU 纹理上限 ${maxDimension}，形状层停止绘制`);
        }
        return;
      }
      if (nextWidth !== width || nextHeight !== height) resize(nextWidth, nextHeight);
      const offsetX = scene.offsetX ?? 0;
      const offsetY = scene.offsetY ?? 0;
      if (offsetX !== screen[2] || offsetY !== screen[3]) {
        // 滚动只改这两个数：顶点数据不用重打包，这是"滚动不掉帧"的关键
        screen[2] = offsetX;
        screen[3] = offsetY;
        device.queue.writeBuffer(uniformBuffer, 0, screen);
      }

      const vertices = buildVertices(scene, geometry);
      geometry = vertices; // 数组留着当下帧的复用缓冲
      if (vertices.boxCount > 0) {
        ensureInstanceBuffer(vertices.boxCount * BOX_INSTANCE_FLOATS * 4);
        device.queue.writeBuffer(instanceBuffer!, 0, vertices.boxes, 0, vertices.boxCount * BOX_INSTANCE_FLOATS);
      }
      if (vertices.lineVertexCount > 0) {
        ensureLineBuffer(vertices.lineVertexCount * LINE_VERTEX_FLOATS * 4);
        device.queue.writeBuffer(lineBuffer!, 0, vertices.lines, 0, vertices.lineVertexCount * LINE_VERTEX_FLOATS);
      }

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: msaaView!,
            resolveTarget: context.getCurrentTexture().createView(),
            // 透明清屏：形状层只画形状，底色由页面给
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            // 用 'store'：resolve 到画布的行为与 storeOp 关系在实现间有差异，'store' 最稳，
            // 代价是这一次 MSAA 写回（视口大小的纹理，可忽略）
            storeOp: 'store',
          },
        ],
      });
      if (vertices.boxCount > 0) {
        pass.setPipeline(boxPipeline);
        pass.setBindGroup(0, bindGroup);
        pass.setVertexBuffer(0, templateBuffer);
        pass.setVertexBuffer(1, instanceBuffer!);
        pass.draw(BOX_QUAD_VERTEX_COUNT, vertices.boxCount);
      }
      if (vertices.lineVertexCount > 0) {
        pass.setPipeline(linePipeline);
        pass.setBindGroup(0, bindGroup);
        pass.setVertexBuffer(0, lineBuffer!);
        pass.draw(vertices.lineVertexCount);
      }
      pass.end();
      device.queue.submit([encoder.finish()]);
    },

    destroy(): void {
      if (disposed) return;
      disposed = true;
      msaa?.destroy();
      instanceBuffer?.destroy();
      lineBuffer?.destroy();
      templateBuffer.destroy();
      uniformBuffer.destroy();
      device.destroy();
    },
  };
}
