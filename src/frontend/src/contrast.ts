/**
 * 对比色：某块底色上该用黑字还是白字
 *
 * 单独成文件是为了能脱离 DOM 直接测 —— 可视化里所有"画在色块上的字"都走这里，
 * 判错的后果很直接：深色主题下一片深字压在深色底上，等于没写。
 *
 * 关键点是**底色不能假定为白**：半透明填充、空心底、推断段露出的都是页面底色，
 * 而页面底色跟着主题走（`--surface` 浅色 `#ffffff` / 深色 `#171b21`）。
 */

export type Rgb = [number, number, number];

/** 深字（浅底上用） */
export const INK_DARK = '#0b1220';
/** 白字（深底上用） */
export const INK_LIGHT = '#ffffff';

/** 感知明度阈值：超过它就认为底色够亮、该用深字 */
const LUMINANCE_THRESHOLD = 0.6;

/** CSS 颜色 → `{ rgb, alpha }`；解析不了（`var()` 引用、`color-mix()` 等）返回 null */
export function parseCssColor(color: string): { rgb: Rgb; alpha: number } | null {
  const text = color.trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text);
  if (hex !== null) {
    let body = hex[1]!;
    if (body.length <= 4) body = body.replace(/./g, (c) => c + c);
    const channel = (index: number): number => parseInt(body.slice(index * 2, index * 2 + 2), 16);
    return { rgb: [channel(0), channel(1), channel(2)], alpha: body.length === 8 ? channel(3) / 255 : 1 };
  }
  // rgb() / rgba()，逗号或空格分隔都接受（含 `rgb(0 0 0 / 40%)` 这种写法）
  const fn = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (fn !== null) {
    const parts = fn[1]!.split(/[\s,/]+/).filter((part) => part !== '');
    if (parts.length >= 3) {
      const channel = (value: string): number => (value.endsWith('%') ? (parseFloat(value) / 100) * 255 : parseFloat(value));
      const raw = parts[3];
      const alpha = raw === undefined ? 1 : raw.endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw);
      return { rgb: [channel(parts[0]!), channel(parts[1]!), channel(parts[2]!)], alpha: Number.isFinite(alpha) ? alpha : 1 };
    }
  }
  return null;
}

/** 把若干半透明层（由下到上）合成到 `backdrop` 上 */
export function compositeOver(layers: { rgb: Rgb; alpha: number }[], backdrop: Rgb): Rgb {
  let behind = backdrop;
  for (const layer of layers) {
    behind = [0, 1, 2].map((i) => layer.alpha * layer.rgb[i]! + (1 - layer.alpha) * behind[i]!) as Rgb;
  }
  return behind;
}

/**
 * `backdrop` 上该用黑字还是白字。
 * `fill` 传 `null` 表示该处**不填充**（空心底、推断段、未知段……），直接看底色；
 * 否则把 `fill` 按 `alpha` 压在底色上，再取感知明度阈值。
 */
export function inkOn(fill: string | null, alpha: number, backdrop: Rgb): string {
  let rgb = backdrop;
  if (fill !== null) {
    const parsed = parseCssColor(fill);
    if (parsed !== null) rgb = compositeOver([{ rgb: parsed.rgb, alpha: parsed.alpha * alpha }], backdrop);
  }
  const luminance = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  return luminance > LUMINANCE_THRESHOLD ? INK_DARK : INK_LIGHT;
}
