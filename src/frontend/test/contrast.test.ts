/**
 * 对比色测试：某块底色上该用黑字还是白字
 *
 * 底色用主题里的真实取值（浅色 `--surface: #ffffff`、深色 `--surface: #171b21`），
 * 因为这里最容易犯的错就是**默认底色是白的**：
 * 深色主题下空心底/半透明段露出来的都是深色页面底，仍判深字就成"深字压深底"。
 */
import { describe, expect, test } from 'bun:test';
import { INK_DARK, INK_LIGHT, compositeOver, inkOn, parseCssColor } from '../src/contrast.ts';

const LIGHT: [number, number, number] = [255, 255, 255];
const DARK: [number, number, number] = [23, 27, 33];

describe('parseCssColor', () => {
  test('十六进制（3/4/6/8 位）', () => {
    expect(parseCssColor('#fff')).toEqual({ rgb: [255, 255, 255], alpha: 1 });
    expect(parseCssColor('#171b21')).toEqual({ rgb: [23, 27, 33], alpha: 1 });
    expect(parseCssColor('#dc262680')?.alpha).toBeCloseTo(128 / 255, 5);
  });

  test('rgb()/rgba()，含空格加斜杠的写法', () => {
    expect(parseCssColor('rgb(23, 27, 33)')).toEqual({ rgb: [23, 27, 33], alpha: 1 });
    expect(parseCssColor('rgba(0, 0, 0, 0.4)')?.alpha).toBeCloseTo(0.4, 5);
    expect(parseCssColor('rgb(0 0 0 / 40%)')?.alpha).toBeCloseTo(0.4, 5);
    expect(parseCssColor('rgb(100% 100% 100%)')?.rgb).toEqual([255, 255, 255]);
  });

  test('解析不了的颜色（CSS 变量）返回 null', () => {
    expect(parseCssColor('var(--surface)')).toBeNull();
    expect(parseCssColor('color-mix(in srgb, #7c3aed 13%, transparent)')).toBeNull();
  });
});

describe('compositeOver', () => {
  test('由下到上逐层合成', () => {
    expect(compositeOver([{ rgb: [0, 0, 0], alpha: 0.5 }], LIGHT)).toEqual([127.5, 127.5, 127.5]);
    expect(compositeOver([{ rgb: [0, 0, 0], alpha: 1 }, { rgb: [255, 255, 255], alpha: 0.5 }], LIGHT)).toEqual([127.5, 127.5, 127.5]);
  });
});

describe('inkOn', () => {
  test('浅色底：深色填充用白字，浅色填充用深字', () => {
    expect(inkOn('#3b82f6', 0.88, LIGHT)).toBe(INK_LIGHT);
    expect(inkOn('#eab308', 0.88, LIGHT)).toBe(INK_DARK);
  });

  test('深色底：同样的填充不能沿用浅色底的判断', () => {
    // 黄在深底上混出来更暗，但仍够亮 → 深字；蓝在深底上更暗 → 白字
    expect(inkOn('#3b82f6', 0.88, DARK)).toBe(INK_LIGHT);
    expect(inkOn('#eab308', 0.88, DARK)).toBe(INK_DARK);
  });

  test('不填充（空心底）跟着画布底色走：深色主题必须白字', () => {
    expect(inkOn(null, 1, DARK)).toBe(INK_LIGHT);
    expect(inkOn(null, 1, LIGHT)).toBe(INK_DARK);
  });

  test('半透明推断段：深浅主题下判断相反', () => {
    expect(inkOn('#3b82f6', 0.15, LIGHT)).toBe(INK_DARK);
    expect(inkOn('#3b82f6', 0.15, DARK)).toBe(INK_LIGHT);
  });

  test('解析不了的填充退回画布底色判断', () => {
    expect(inkOn('var(--surface)', 1, DARK)).toBe(INK_LIGHT);
    expect(inkOn('var(--surface)', 1, LIGHT)).toBe(INK_DARK);
  });
});
