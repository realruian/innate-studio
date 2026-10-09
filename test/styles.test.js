// 版式检查：样式表里的字号、行高、字重、间距只能从 :root 的变量取，不能写数值。
// 规则见 DESIGN.md 第 3 节。新增样式时如果这里报错，说明写了阶梯之外的值。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8');
const split = css.indexOf('*, *::before, *::after');
const tokens = css.slice(0, split);
const rules = css.slice(split);

const TEXT_SIZES = { display: 26, title: 18, body: 14, ui: 13, caption: 12, micro: 11 };
const LINE_HEIGHTS = { tight: 1.2, snug: 1.3, body: 1.5 };
const SPACING_SCALE = [2, 4, 8, 12, 16, 20, 24, 32, 48, 64];

// 某个属性在所有规则里出现的值，连同所在的那一行，方便定位。
function declarations(prop) {
  const found = [];
  for (const line of rules.split('\n')) {
    for (const m of line.matchAll(new RegExp(`(?<![-\\w])${prop}\\s*:\\s*([^;}]+)`, 'g'))) {
      found.push({ value: m[1].trim(), where: line.trim().slice(0, 60) });
    }
  }
  return found;
}

const offenders = (list, ok) => list.filter(({ value }) => !ok(value)).map(({ value, where }) => `${value}  ←  ${where}`);

test('变量：字号六档、行高三档、间距阶梯的取值没有被改动或加塞', () => {
  // 取某个前缀下的全部变量。--text- 开头的还有文字颜色（--text-2 等），所以字号只看取值是 rem 的。
  // 字号写成 rem（1rem 是 16 像素），用户调大浏览器的默认字号时会跟着变；上面的表里记的是对应的像素值。
  const defined = (prefix, only = () => true) =>
    Object.fromEntries([...tokens.matchAll(new RegExp(`--${prefix}-(\\w+):\\s*([^;]+);`, 'g'))].map((m) => [m[1], m[2].trim()]).filter(([, value]) => only(value)));
  assert.deepEqual(defined('text', (v) => v.endsWith('rem')), Object.fromEntries(Object.entries(TEXT_SIZES).map(([k, v]) => [k, `${v / 16}rem`])));
  assert.deepEqual(defined('lh'), Object.fromEntries(Object.entries(LINE_HEIGHTS).map(([k, v]) => [k, String(v)])));
  assert.deepEqual(defined('sp'), Object.fromEntries(SPACING_SCALE.map((n) => [String(n), `${n}px`])));
});

test('字号：只用六档变量', () => {
  const allowed = new RegExp(`^var\\(--text-(${Object.keys(TEXT_SIZES).join('|')})\\)$`);
  assert.deepEqual(offenders(declarations('font-size'), (v) => allowed.test(v)), []);
});

test('行高：只用三档变量；单个符号可以用 1', () => {
  const allowed = new RegExp(`^(1|var\\(--lh-(${Object.keys(LINE_HEIGHTS).join('|')})\\))$`);
  assert.deepEqual(offenders(declarations('line-height'), (v) => allowed.test(v)), []);
});

test('字重：只用变量', () => {
  assert.deepEqual(offenders(declarations('font-weight'), (v) => /^var\(--fw-(medium|semibold)\)$/.test(v)), []);
});

test('间距：gap、padding、margin 只用间距阶梯', () => {
  const step = new RegExp(`^(0|auto|\\d+vh|var\\(--sp-(${SPACING_SCALE.join('|')})\\)|calc\\(var\\(--sp-(${SPACING_SCALE.join('|')})\\) \\* -1\\))$`);
  const parts = (value) => value.match(/calc\([^)]*\)[^)]*\)|var\([^)]*\)|\S+/g) || [];
  const props = '(?:(?:row-|column-)?gap|padding(?:-(?:top|right|bottom|left|inline|block))?|margin(?:-(?:top|right|bottom|left|inline|block))?)';
  assert.deepEqual(offenders(declarations(props), (v) => parts(v).every((p) => step.test(p))), []);
});

test('字距：只有大标题收紧，正文不调', () => {
  assert.deepEqual(offenders(declarations('letter-spacing'), (v) => v === '-0.01em' || v === '-0.02em'), []);
  assert.ok(declarations('letter-spacing').length <= 2, '只应有首屏问句和页面标题两处调了字距');
});
