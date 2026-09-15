/** 产物形态：两个文件
 *
 *   dist/index.html  独立单文件页面（CSS 与 JS 全部内联，双击即可打开）
 *   dist/app.js      HTTP 服务器（可执行，`bun app.js` 后对外提供上面那个页面）
 *
 * 说明：JS 用 IIFE 打包并内联，因此 `file://` 直接打开也不受模块 CORS 限制。
 */

const STYLE_MARKER = '/*__CHIPERF_STYLES__*/';
const SCRIPT_MARKER = '/*__CHIPERF_SCRIPT__*/';

export interface Artifacts {
  jsBundle: string;
  css: string;
  template: string;
}

/** 把模板里的占位注释替换成真实内容（用函数替换，避免 `$&` 等被当成替换模式） */
export function inlineIntoSingleFile(template: string, artifacts: Artifacts): string {
  if (!template.includes(STYLE_MARKER) || !template.includes(SCRIPT_MARKER)) {
    throw new Error(`index.html 模板缺少占位标记：${STYLE_MARKER} / ${SCRIPT_MARKER}`);
  }
  const hardenedJs = artifacts.jsBundle.replaceAll('</script', '<\\/script');
  return template
    .replace(STYLE_MARKER, () => artifacts.css)
    .replace(SCRIPT_MARKER, () => hardenedJs);
}
