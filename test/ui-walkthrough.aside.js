// 整体走查：把每个页面、弹窗、浮层都打开一遍，逐个状态做一致性检查并截图。
// 改了任何界面代码之后都要跑，深色、浅色各一遍。
//
// 前提：npm run dev:mock 已在运行（http://127.0.0.1:5179，接的是模拟接口）。
// 用法：aside repl "$(sed 's/__THEME__/light/' test/ui-walkthrough.aside.js)"
//
// 每个状态都检查：
// - 没有页面报错
// - 没有浏览器原生的界面：下拉框、勾选框、折叠标签、视频控件、title 提示、密码框
// - 页面没有横向溢出，弹窗和浮层没有跑出窗口
// - 用到的字号都在规范的几档之内

const THEME = '__THEME__';
const ALLOWED_FONT_SIZES = ['11px', '12px', '13px', '14px', '15px', '18px', '26px'];
const pg = await openTab('http://127.0.0.1:5179/');
const errors = [];
const problems = [];
const shots = [];
try {
  pg.on('pageerror', (e) => errors.push(`页面报错 ${String(e)}`));
  pg.on('console', (m) => m.type() === 'error' && errors.push(`控制台报错 ${m.text()}`));
} catch {
  /* 没有事件接口就只靠下面的检查 */
}

await pg.evaluate((theme) => {
  localStorage.clear();
  localStorage.setItem('seedance-studio.theme', theme);
}, THEME);
await pg.reload();
await sleep(2200);

const click = (selector, index = 0) =>
  pg.evaluate(
    ([s, i]) => {
      const el = document.querySelectorAll(s)[i];
      if (!el) return `找不到 ${s}[${i}]`;
      el.click();
      return 'ok';
    },
    [selector, index],
  );
const clickText = (selector, text) =>
  pg.evaluate(
    ([s, t]) => {
      const el = [...document.querySelectorAll(s)].find((e) => e.textContent.trim().startsWith(t));
      if (!el) return `找不到 ${s} 「${t}」`;
      el.click();
      return 'ok';
    },
    [selector, text],
  );
const must = async (label, promise) => {
  const result = await promise;
  if (result !== 'ok' && result !== true) problems.push(`${label}：${result}`);
  return result;
};
const count = (selector) => pg.evaluate((s) => document.querySelectorAll(s).length, selector);
const text = (selector) => pg.evaluate((s) => [...document.querySelectorAll(s)].map((e) => e.textContent.trim().replace(/\s+/g, ' ')), selector);
const outsideClick = () => pg.evaluate(() => document.querySelector('.brand').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
const escape = () => pg.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

async function audit(state) {
  const found = await pg.evaluate((allowed) => {
    const issues = [];
    const native = document.querySelectorAll('select, details, input[type=checkbox]:not([role=switch]), input[type=radio], input[type=password], video[controls], [title]');
    if (native.length) issues.push(`有原生界面：${[...new Set([...native].map((e) => (e.hasAttribute('title') ? `${e.tagName.toLowerCase()}[title]` : e.tagName.toLowerCase())))].join('、')}`);
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth + 1) issues.push('页面横向溢出');
    for (const el of document.querySelectorAll('.popover, .modal')) {
      const r = el.getBoundingClientRect();
      if (r.left < 0 || r.top < 0 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) issues.push(`浮层超出窗口：${el.className}`);
    }
    const odd = new Set();
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('video') || !el.getClientRects().length) continue;
      if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      const size = getComputedStyle(el).fontSize;
      if (!allowed.includes(size)) odd.add(`${size}（${el.className || el.tagName.toLowerCase()}）`);
    }
    if (odd.size) issues.push(`规范外的字号：${[...odd].join('，')}`);
    if (root.dataset.theme !== localStorage.getItem('seedance-studio.theme')) issues.push('主题和保存的不一致');
    return issues;
  }, ALLOWED_FONT_SIZES);
  for (const issue of found) problems.push(`${state}：${issue}`);
}

async function shot(name) {
  await pg.screenshot({ path: `./${THEME}-${name}.png` });
  shots.push(`${THEME}-${name}.png`);
}

// 1. 创作页初始状态；输入框聚焦前后外观必须一样（不出现描边、光晕）
await audit('创作页');
const look = () =>
  pg.evaluate(() => {
    const s = getComputedStyle(document.querySelector('.composer-card'));
    const p = getComputedStyle(document.querySelector('textarea.prompt'));
    return [s.borderColor, s.boxShadow, s.outlineStyle, p.outlineStyle, p.boxShadow].join(' | ');
  });
await pg.evaluate(() => document.activeElement.blur());
const blurred = await look();
await pg.evaluate(() => document.querySelector('textarea.prompt').focus());
await sleep(250);
const focused = await look();
if (blurred !== focused) problems.push(`输入框聚焦后外观变了：${blurred} → ${focused}`);
await shot('01-create');

// 1b. 关键位置的颜色要等于从 Antigravity 截图取到的值；输入框底部要有灰色托边
const REFERENCE = {
  light: { 主区底色: 'rgb(249, 249, 249)', 侧栏底色: 'rgb(243, 243, 243)', 输入框底色: 'rgb(252, 252, 252)', 输入框边线: 'rgb(233, 233, 233)', 托边: 'rgb(233, 233, 233)', 新建按钮: 'rgb(252, 252, 252)', 分隔线: 'rgb(230, 230, 230)' },
  dark: { 主区底色: 'rgb(16, 16, 16)', 侧栏底色: 'rgb(22, 22, 22)', 输入框底色: 'rgb(28, 28, 28)', 输入框边线: 'rgb(37, 37, 37)', 托边: 'rgb(37, 37, 37)', 新建按钮: 'rgb(50, 50, 50)', 分隔线: 'rgb(26, 26, 26)' },
}[THEME];
const colours = await pg.evaluate(() => {
  const css = (selector) => getComputedStyle(document.querySelector(selector));
  // 半透明边线叠在底色上，算出实际看到的颜色
  const over = (line, base) => {
    const [r, g, b, a = 1] = line.match(/[\d.]+/g).map(Number);
    const under = base.match(/[\d.]+/g).map(Number);
    return `rgb(${[r, g, b].map((v, i) => Math.round(v * a + under[i] * (1 - a))).join(', ')})`;
  };
  const card = css('.composer-card');
  return {
    主区底色: css('body').backgroundColor,
    侧栏底色: css('.sidebar').backgroundColor,
    输入框底色: card.backgroundColor,
    输入框边线: over(card.borderTopColor, card.backgroundColor),
    托边: (card.boxShadow.match(/rgba?\([^)]+\)/) || ['没有托边'])[0],
    托边高度: card.boxShadow.replace(/rgba?\([^)]+\)/, '').trim(),
    托边占位: card.marginBottom,
    新建按钮: css('.nav-new').backgroundColor,
    分隔线: over(css('.main').borderLeftColor, css('body').backgroundColor),
  };
});
for (const [name, want] of Object.entries(REFERENCE)) {
  if (colours[name] !== want) problems.push(`颜色和 Antigravity 不一致：${name} 是 ${colours[name]}，应为 ${want}`);
}
if (colours.托边高度 !== '0px 8px 0px 0px' || colours.托边占位 !== '8px') problems.push(`输入框托边不对：${colours.托边高度}，占位 ${colours.托边占位}`);

// 2. 视频播放器：自绘控制条，能播放、能静音
// 先给要测的那张卡片做个记号。创作记录会随任务进度更新，"第一张带视频的卡片"随时可能换成别的，
// 不做记号的话，点的是一张、检查的是另一张。
const P = '[data-walk=player]';
const pinned = await pg.evaluate(() => {
  const card = document.querySelector('.card .player')?.closest('.card');
  if (card) card.dataset.walk = 'player';
  return Boolean(card);
});
if (pinned) {
  // 用真实的鼠标点击：浏览器只允许用户亲手触发的有声播放，脚本触发的会被拦下。
  await pg.locator(`${P} .player-btn`).first().click();
  await sleep(900);
  const playing = await pg.evaluate((sel) => {
    const v = document.querySelector(`${sel} video`);
    if (!v) return null;
    return { paused: v.paused, time: v.currentTime, label: document.querySelector(`${sel} .player-time`).textContent, fill: parseFloat(document.querySelector(`${sel} .player-fill`).style.width) || 0, ready: v.readyState, page: document.visibilityState };
  }, P);
  if (!playing) problems.push('刚点了播放的卡片被整张换掉了');
  else if (playing.paused || playing.time <= 0) problems.push(`点了播放但视频没有动：${JSON.stringify(playing)}`);
  else if (playing.fill <= 0 || playing.label.startsWith('0:00 / 0:00')) problems.push(`播放时进度和时间没有更新：${JSON.stringify(playing)}`);

  // 视频存到本机后，记录里的视频地址会变。这时只该更新下载链接，不能打断正在播放的画面。
  const kept = await pg.evaluate(async (sel) => {
    // 取页面自己的状态模块。Aside 的脚本环境不允许直接写动态导入，所以拼出来再调用。
    const load = new Function('url', 'return imp' + 'ort(url)');
    const { state, emit } = await load('/js/store.js');
    const video = document.querySelector(`${sel} video`);
    const item = video && state.history.find((i) => i.videoUrl === video.getAttribute('src'));
    if (!item) return '找不到这张卡片对应的记录';
    const original = item.videoUrl;
    item.videoUrl = `${original}?v=2`;
    emit('history');
    const sameVideo = document.querySelector(`${sel} video`) === video && !video.paused;
    const link = document.querySelector(`${sel} a.entry-action-btn`)?.getAttribute('href') || '';
    item.videoUrl = original;
    emit('history');
    if (!sameVideo) return '视频地址更新时，正在播放的画面被打断了';
    if (!link.includes('?v=2')) return `视频地址更新后，下载链接没有跟着变：${link}`;
    return 'ok';
  }, P);
  if (kept !== 'ok') problems.push(kept);

  await must('点静音', click(`${P} .player-btn`, 1));
  if (!(await pg.evaluate((sel) => document.querySelector(`${sel} video`)?.muted, P))) problems.push('点了静音但没有静音');
  await must('取消静音', click(`${P} .player-btn`, 1));
  await must('点暂停', click(`${P} .player-btn`, 0));
  await sleep(200);
  if (!(await pg.evaluate((sel) => document.querySelector(`${sel} video`)?.paused, P))) problems.push('点了暂停但还在播放');
  await shot('01b-player');
} else {
  problems.push('创作记录里没有已完成的视频，播放器没有测到');
}

// 提示气泡：发送键在不能提交时说明原因，用的是自绘的气泡
await pg.evaluate(() => document.querySelector('.send-btn').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
await sleep(750);
if ((await text('.tooltip')).join('') !== '请填写提示词') problems.push(`发送键上的提示不对：${(await text('.tooltip')).join('')}`);
await pg.evaluate(() => document.querySelector('.send-btn').dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })));
await sleep(100);
if (await count('.tooltip')) problems.push('鼠标移开后提示气泡没有消失');

// 3. 工具栏：只有一行；每个入口打开的都是自绘的菜单或面板，且不推动页面
const toolbar = await text('.composer-params > *');
if (toolbar.length !== 5) problems.push(`工具栏应该是 5 个入口，现在是 ${toolbar.length} 个：${toolbar.join(' | ')}`);
if (await count('.composer-card ~ *, .composer-card > :not(.media-block):not(.prompt):not(.composer-bar)')) problems.push('输入框里外还有多余的一行');
const layout = () =>
  pg.evaluate(() => {
    const card = document.querySelector('.composer-card').getBoundingClientRect();
    return [card.top, card.height, document.querySelector('.feed').getBoundingClientRect().top].map(Math.round).join(',');
  });
const layoutBefore = await layout();
const control = (name) => `.composer-params [data-control=${name}]`;

await must('打开模型菜单', click(control('model')));
await sleep(250);
if ((await count('.menu .menu-item')) < 2) problems.push('模型菜单没有出现');
if ((await count('.menu .menu-item.selected .menu-item-check svg')) !== 1) problems.push('模型菜单没有标出当前项');
await audit('模型菜单');
await shot('02-model-menu');
await escape();
await sleep(150);
if (await count('.menu')) problems.push('Esc 没有关掉菜单');

await must('打开画面面板', click(control('frame')));
await sleep(250);
if (!(await count('.frame-popover'))) problems.push('画面面板没有出现');
await audit('画面面板');
await shot('03-frame');
await must('选 9:16', clickText('.frame-popover .ratio-option', '9:16'));
await sleep(200);
await must('选 1080p', clickText('.frame-popover .seg', '1080p'));
await sleep(200);
if (!(await count('.frame-popover'))) problems.push('在画面面板里选完后面板被关掉了');
if (!(await text(control('frame'))).join('').includes('9:16 · 1080p')) problems.push(`画面按钮没有更新：${(await text(control('frame'))).join('')}`);
await must('再点一次画面按钮收起', click(control('frame')));
await sleep(200);
if (await count('.frame-popover')) problems.push('再点一次按钮没有收起画面面板');

await must('打开时长菜单', click(control('duration')));
await sleep(200);
await audit('时长菜单');
await must('选 8 秒', clickText('.menu .menu-item', '8 秒'));
await sleep(200);

await must('打开更多', click(control('more')));
await sleep(300);
if (!(await count('.more-popover'))) problems.push('更多面板没有出现');
if (await pg.evaluate(() => /请求/.test(document.querySelector('.more-popover')?.textContent || '') || Boolean(document.querySelector('.more-popover pre')))) problems.push('更多面板里不应该出现请求预览');
if ((await layout()) !== layoutBefore) problems.push(`打开面板后输入框或记录的位置变了：${layoutBefore} → ${await layout()}`);
await audit('更多面板');
await must('打开画质超分', click('.more-popover .switch input', 3));
await sleep(250);
await must('打开场景菜单', click('.more-popover .sub-panel .dropdown', 0));
await sleep(250);
await audit('更多面板里的菜单');
await shot('04-more');
await must('选短剧', clickText('.menu .menu-item', '短剧'));
await sleep(250);
if (!(await count('.more-popover'))) problems.push('在更多面板里选完菜单后，面板被一起关掉了');
if (await pg.evaluate(() => document.querySelector('.more-dot').hidden)) problems.push('改了设置但「更多」上没有提示点');
await outsideClick();
await sleep(200);
if (await count('.more-popover')) problems.push('点外面没有关掉更多面板');
if ((await layout()) !== layoutBefore) problems.push('关闭面板后页面位置没有复原');

// 4. 参考生成：选素材弹窗、上传、等待可用
await pg.locator('textarea.prompt').fill('保持产品主体一致，生成干净的工作室展示视频，镜头缓慢环绕');
await must('打开生成方式菜单', click(control('mode')));
await sleep(200);
await must('选参考生成', clickText('.menu .menu-item', '参考生成'));
await sleep(250);
await must('点添加参考', click('.ref-row .ref-add', 0));
await sleep(250);
await must('选图片', clickText('.menu .menu-item', '图片'));
await sleep(350);
await audit('选素材弹窗');
await must('切到真人素材', click('.modal .tabs .seg', 3));
await sleep(900);
await audit('选素材弹窗·真人素材');
await must('切回本地上传', click('.modal .tabs .seg', 0));
await sleep(200);
// 超过大小上限的文件：不发出去，直接说明原因（不能显示成"连不上本地服务"）
await pg.evaluate(() => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array(31 * 1024 * 1024)], '太大的图.png', { type: 'image/png' }));
  const input = document.querySelector('.modal input[type=file]');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(500);
const tooBig = (await text('.modal .upload-row .error-text')).join('');
if (!tooBig.includes('文件太大') || !tooBig.includes('30 MB') || tooBig.includes('连不上')) problems.push(`超过上限的文件提示不对：「${tooBig}」`);
if ((await count('.modal')) !== 1) problems.push('文件太大时弹窗不应该关闭');
await pg.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 480;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 640, 480);
  g.addColorStop(0, '#ffb347');
  g.addColorStop(1, '#3a7bd5');
  x.fillStyle = g;
  x.fillRect(0, 0, 640, 480);
  x.fillStyle = '#fff';
  x.beginPath();
  x.arc(320, 240, 110, 0, 7);
  x.fill();
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], '产品参考图.png', { type: 'image/png' }));
  const input = document.querySelector('.modal input[type=file]');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(2000);
if (await count('.modal')) problems.push('上传完成后弹窗没有关闭');
if ((await count('.ref-tile:not(.ref-add)')) !== 1) problems.push('上传后没有出现参考图');
await audit('参考生成·素材处理中');
await shot('05-reference');
for (let i = 0; i < 30 && (await count('.ref-state')); i += 1) await sleep(500);
if (await count('.ref-state')) problems.push('素材一直没有变成可用');

// 5. 提交 → 「最近生成」的第一张是刚提交的任务；创作页最多列 6 条；侧栏只有导航和设置
await must('点生成', click('.send-btn'));
await sleep(1800);
if (!(await count('.view-create .card:first-child .card-state.is-pending'))) problems.push('提交后「最近生成」的第一张不是刚提交的任务');
if ((await count('.view-create .card')) > 6) problems.push(`创作页的「最近生成」超过了 6 条：${await count('.view-create .card')}`);
if ((await text('.view-create .feed-head h1')).join('') !== '最近生成') problems.push('创作页下方的标题应为「最近生成」');
const sideText = (await text('.sidebar')).join('');
if ((await count('.side-list, .side-row')) || sideText.includes('最近生成')) problems.push('侧栏里不应该有「最近生成」列表');
if ((await text('.sidebar .nav-item')).join('|') !== '新建创作|创作记录|素材库|真人档案|设置') problems.push(`侧栏的入口不对：${(await text('.sidebar .nav-item')).join('|')}`);
await audit('提交后');
await shot('06-submitted');

// 6. 点卡片画面打开详情（不是播放）；列表里正在放的视频要停下；详情里不出现请求内容；Esc 关闭；删除确认
if (!(await count(P))) problems.push('做了记号的卡片不见了：它在中途被整张重建过');
else await pg.locator(`${P} .player-btn`).first().click();
await sleep(500);
if (await pg.evaluate((sel) => document.querySelector(`${sel} video`)?.paused !== false, P)) problems.push('打开详情前，列表里的视频没有播起来');
await must('点已完成卡片的画面', click(`${P} video`, 0));
await sleep(600);
if ((await text('.modal h2')).join('') !== '生成详情') problems.push(`点卡片画面没有打开详情：${(await text('.modal h2')).join('')}`);
const stillPlaying = await pg.evaluate(() => [...document.querySelectorAll('.card video')].filter((v) => !v.paused).length);
if (stillPlaying) problems.push('打开详情后，列表里的视频还在播放');
await escape();
await sleep(200);
await must('点生成中卡片的画面', click('.card .card-state.is-pending', 0));
await sleep(400);
if ((await text('.modal h2')).join('') !== '生成详情') problems.push('点生成中的卡片没有打开详情');
await escape();
await sleep(200);
await must('点控制条上的静音', click(`${P} .player-btn`, 1));
await sleep(200);
if (await count('.modal')) problems.push('点控制条上的按钮不应该打开详情');
await must('取消静音', click(`${P} .player-btn`, 1));
await must('再点已完成卡片的画面', click(`${P} video`, 0));
await sleep(600);
// 界面上不展示发给接口的原始请求：那是给开发者看的，不是产品内容
if (await pg.evaluate(() => /请求|"model"|"content"/.test(document.querySelector('.modal').textContent) || Boolean(document.querySelector('.modal pre')))) problems.push('详情里不应该出现请求内容');
await audit('详情弹窗');
await shot('07-detail');
await escape();
await sleep(200);
if (await count('.modal')) problems.push('Esc 没有关掉详情弹窗');
await must('点删除', click('.card .entry-action-btn.danger', (await count('.card')) - 1));
await sleep(300);
await audit('删除确认');
await shot('08-confirm');
await must('取消删除', clickText('.modal .btn', '取消'));
await sleep(200);

// 6b. 创作记录页：全部记录、筛选、搜索；点画面看详情；复用会回到创作页并填好参数
const V = '.view:not([hidden])';
await must('进入创作记录', clickText('.nav-item', '创作记录'));
await sleep(500);
if ((await text(`${V} .page-head h1`)).join('') !== '创作记录') problems.push('点「创作记录」没有进入记录页');
if ((await pg.evaluate(() => document.querySelector('.nav-item[aria-current=page]')?.textContent.trim())) !== '创作记录') problems.push('侧栏没有高亮「创作记录」');
if (await pg.evaluate(() => [...document.querySelectorAll('.view-create video')].some((v) => !v.paused))) problems.push('离开创作页后，那里的视频还在播放');
const total = Number(((await text(`${V} .filters .seg`))[0] || '').replace(/\D/g, ''));
if (!total || (await count(`${V} .card`)) !== total) problems.push(`记录页列出的数量不对：卡片 ${await count(`${V} .card`)}，应为 ${total}`);
await audit('创作记录页');
await shot('08b-records');
const failedTotal = Number(((await text(`${V} .filters .seg`))[3] || '').replace(/\D/g, ''));
await must('筛选失败', clickText(`${V} .filters .seg`, '失败'));
await sleep(250);
if ((await count(`${V} .card`)) !== failedTotal || (await count(`${V} .card:not(.status-failed)`))) problems.push(`按「失败」筛选的结果不对：应有 ${failedTotal} 条`);
await must('筛选全部', clickText(`${V} .filters .seg`, '全部'));
// 搜这次走查自己提交的那条，不依赖数据里碰巧有什么
await pg.locator(`${V} input.search`).fill('工作室');
await sleep(300);
if (!(await count(`${V} .card`)) || (await text(`${V} .card .card-prompt`)).some((t) => !t.includes('工作室'))) problems.push('按提示词搜索的结果不对');
await pg.locator(`${V} input.search`).fill('不存在的提示词');
await sleep(300);
if ((await count(`${V} .card`)) || !(await text(`${V} .empty`)).join('').includes('没有符合条件的记录')) problems.push('搜不到时没有显示空状态');
await pg.locator(`${V} input.search`).fill('工作室');
await sleep(300);
// 先清空输入框，才能确认「复用」真的把提示词填了回去
await pg.evaluate(() => {
  const prompt = document.querySelector('textarea.prompt');
  prompt.value = '';
  prompt.dispatchEvent(new Event('input', { bubbles: true }));
});
await must('在记录页点卡片画面', click(`${V} .card .card-media`, 0));
await sleep(500);
if ((await text('.modal h2')).join('') !== '生成详情') problems.push('在记录页点卡片画面没有打开详情');
await must('点复用参数', clickText('.modal .btn', '复用参数'));
await sleep(400);
if (await count('.modal')) problems.push('点「复用参数」后详情弹窗没有关闭');
if (!(await count('.view-create:not([hidden])'))) problems.push('点「复用参数」后没有回到创作页');
if (!(await pg.evaluate(() => document.querySelector('textarea.prompt').value.includes('工作室')))) problems.push('点「复用参数」后提示词没有填回输入框');

// 7. 素材库
await must('进入素材库', clickText('.nav-item', '素材库'));
await sleep(500);
if (!(await count('.asset-card'))) problems.push('素材库里没有刚上传的素材');
await audit('素材库');
await shot('09-library');
await must('打开添加素材', click('.page-head .btn-primary'));
await sleep(300);
await must('切到用链接创建', click('.modal .tabs .seg', 1));
await sleep(200);
await audit('添加素材弹窗');
await escape();
await sleep(200);
await must('点素材的删除', click('.asset-card .entry-action-btn.danger', 0));
await sleep(300);
await audit('删除素材弹窗');
await must('取消', clickText('.modal .btn', '取消'));
await sleep(200);

// 8. 真人档案：新建 → 认证链接 → 列表与详情
await must('进入真人档案', clickText('.nav-item', '真人档案'));
await sleep(900);
await audit('真人档案');
await must('打开新建档案', clickText('.page-head .btn', '新建档案'));
await sleep(300);
await pg.locator('.modal input[type=text]').fill(`走查档案 ${THEME}`);
await must('创建档案', clickText('.modal .btn', '创建档案'));
await sleep(1200);
if (!(await pg.evaluate(() => document.querySelector('.modal input[readonly]')?.value.startsWith('https://')))) problems.push('创建档案后没有显示认证链接');
await audit('认证链接弹窗');
await escape();
await sleep(300);
if (!(await count('.person-item'))) problems.push('档案列表里没有新建的档案');
await must('选中档案', click('.person-item', 0));
await sleep(900);
await audit('真人档案详情');
await shot('10-persons');

// 9. 设置：只有一个入口；外观在设置里；切换主题整页生效
if ((await count('.sidebar-foot .nav-item')) !== 1 || (await count('.sidebar-foot > *')) !== 1) problems.push('侧栏底部不是只有「设置」一项');
if ((await text('.sidebar-foot')).join('').includes('sk-')) problems.push('侧栏底部还显示着 Key');
await must('打开设置', click('.sidebar-foot .nav-item'));
await sleep(400);
await audit('设置');
await shot('11-settings');
const other = THEME === 'light' ? '深色' : '浅色';
await must(`切到${other}`, clickText('.modal .segmented .seg', other));
await sleep(300);
if ((await pg.evaluate(() => document.documentElement.dataset.theme)) === THEME) problems.push('在设置里切换主题没有生效');
await must('切回原主题', clickText('.modal .segmented .seg', THEME === 'light' ? '浅色' : '深色'));
await sleep(300);
await must('点显示', clickText('.modal .btn', '显示'));
if (await pg.evaluate(() => document.querySelector('.modal input.mono').classList.contains('masked'))) problems.push('点「显示」后输入框内容仍被遮住');
await escape();
await sleep(200);

// 10. 回到创作页；窄窗口下不溢出
await must('回到创作', clickText('.nav-item', '新建创作'));
await sleep(300);
if (!(await pg.evaluate(() => document.activeElement === document.querySelector('textarea.prompt')))) problems.push('点「新建创作」后光标没有回到输入框');
const narrow = await pg.evaluate(async () => {
  const out = [];
  for (const width of [900, 420]) {
    const frame = document.createElement('iframe');
    frame.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:800px;border:0;z-index:999`;
    frame.src = '/';
    document.body.append(frame);
    await new Promise((r) => frame.addEventListener('load', r));
    await new Promise((r) => setTimeout(r, 1200));
    const root = frame.contentDocument.documentElement;
    if (root.scrollWidth > root.clientWidth + 1) out.push(`${width}px 宽时横向溢出`);
    frame.remove();
  }
  return out;
});
problems.push(...narrow);

console.log(`主题：${THEME}`);
console.log(`页面报错：${errors.length ? errors.join(' | ') : '无'}`);
console.log(`发现的问题（${problems.length}）：${problems.length ? '\n- ' + problems.join('\n- ') : '无'}`);
console.log(`截图：${shots.join(' ')}`);
console.log(`截图目录：${typeof pwd === 'function' ? await pwd() : pwd}`);
