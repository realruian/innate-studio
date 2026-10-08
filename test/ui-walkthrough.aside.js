// 整体走查：把每个页面、弹窗、浮层都打开一遍，逐个状态做一致性检查并截图。
// 改了任何界面代码之后都要跑，深色、浅色各一遍。
//
// 前提：npm run dev:mock 已在运行（http://127.0.0.1:5179，接的是模拟接口）。它启动时会构建页面，改了界面要重新运行。
// 用法：aside repl "$(sed 's/__THEME__/light/' test/ui-walkthrough.aside.js)"
//
// 每个状态都检查：
// - 没有页面报错
// - 没有浏览器原生的界面：下拉框、勾选框、折叠标签、视频控件、title 提示、密码框
// - 页面没有横向溢出，弹窗和浮层没有跑出窗口
// - 用到的字号都在规范的几档之内

const THEME = '__THEME__';
const ALLOWED_FONT_SIZES = ['11px', '12px', '13px', '14px', '18px', '26px'];
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
    if (root.dataset.theme !== localStorage.getItem('seedance-studio.theme')) issues.push(`主题和保存的不一致：页面是 ${root.dataset.theme}，保存的是 ${localStorage.getItem('seedance-studio.theme')}`);
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
  light: { 主区底色: 'rgb(249, 249, 249)', 侧栏底色: 'rgb(243, 243, 243)', 输入框底色: 'rgb(252, 252, 252)', 输入框边线: 'rgb(233, 233, 233)', 托边: 'rgb(233, 233, 233)', 分隔线: 'rgb(230, 230, 230)' },
  dark: { 主区底色: 'rgb(16, 16, 16)', 侧栏底色: 'rgb(22, 22, 22)', 输入框底色: 'rgb(28, 28, 28)', 输入框边线: 'rgb(37, 37, 37)', 托边: 'rgb(37, 37, 37)', 分隔线: 'rgb(26, 26, 26)' },
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
    分隔线: over(css('.main').borderLeftColor, css('body').backgroundColor),
  };
});
for (const [name, want] of Object.entries(REFERENCE)) {
  if (colours[name] !== want) problems.push(`颜色和 Antigravity 不一致：${name} 是 ${colours[name]}，应为 ${want}`);
}
if (colours.托边高度 !== '0px 8px 0px 0px' || colours.托边占位 !== '8px') problems.push(`输入框托边不对：${colours.托边高度}，占位 ${colours.托边占位}`);

// 1c. 版式：对齐到共同的边；弹窗之外，标题和正文的行高按角色区分
const edges = await pg.evaluate(() => {
  const left = (selector) => Math.round(document.querySelector(selector).getBoundingClientRect().left);
  const prompt = document.querySelector('textarea.prompt');
  const title = getComputedStyle(document.querySelector('.composer-title'));
  return {
    提示词: Math.round(prompt.getBoundingClientRect().left + parseFloat(getComputedStyle(prompt).paddingLeft)),
    工具栏图标: left('.composer-params .icon'),
    品牌标记: left('.brand-mark'),
    导航图标: left('.nav-item .icon'),
    问句行高: Math.round((parseFloat(title.lineHeight) / parseFloat(title.fontSize)) * 100) / 100,
    正文行高: Math.round((parseFloat(getComputedStyle(document.body).lineHeight) / parseFloat(getComputedStyle(document.body).fontSize)) * 100) / 100,
  };
});
if (edges.提示词 !== edges.工具栏图标) problems.push(`输入框里提示词和工具栏图标的左边线没对齐：${edges.提示词} / ${edges.工具栏图标}`);
if (edges.品牌标记 !== edges.导航图标) problems.push(`侧栏的品牌标记和导航图标的左边线没对齐：${edges.品牌标记} / ${edges.导航图标}`);
if (edges.问句行高 !== 1.2 || edges.正文行高 !== 1.5) problems.push(`行高不对：问句 ${edges.问句行高}（应为 1.2），正文 ${edges.正文行高}（应为 1.5）`);

// 2. 视频播放器：自绘控制条，能播放、能静音
// 先给要测的那张卡片做个记号。创作记录会随任务进度更新，"第一张带视频的卡片"随时可能换成别的，
// 不做记号的话，点的是一张、检查的是另一张。
const P = '[data-walk=player]';
// 「最近生成」里图片、音频和视频混在一起，只列最新 6 条。后面还会再提交一条，
// 所以要测的视频得排在前 5 张里才不会被挤出去；不在的话先生成一条。
const firstVideo = () => pg.evaluate(() => [...document.querySelectorAll('.view-create .card')].findIndex((c) => c.querySelector('.player')));
if (![0, 1, 2, 3, 4].includes(await firstVideo())) {
  await pg.locator('textarea.prompt').fill('走查用的视频');
  await must('生成一条走查用的视频', click('.send-btn'));
  for (let i = 0; i < 60 && (await firstVideo()) !== 0; i += 1) await sleep(500);
  await pg.locator('textarea.prompt').fill('');
}
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

  // 视频存到本机后，记录里的视频地址会变。这时不能打断正在播放的画面。
  const kept = await pg.evaluate(async (sel) => {
    // 页面把自己的状态挂在 window.__studio 上，供这里模拟接口的变化。
    const { state, emit } = window.__studio;
    const video = document.querySelector(`${sel} video`);
    const item = video && state.history.find((i) => i.videoUrl === video.getAttribute('src'));
    if (!item) return '找不到这张卡片对应的记录';
    const original = item.videoUrl;
    item.videoUrl = `${original}?v=2`;
    emit('history');
    const sameVideo = document.querySelector(`${sel} video`) === video && !video.paused;
    item.videoUrl = original;
    emit('history');
    return sameVideo ? 'ok' : '视频地址更新时，正在播放的画面被打断了';
  }, P);
  if (kept !== 'ok') problems.push(kept);

  await must('点静音', click(`${P} .player-btn`, 1));
  if (!(await pg.evaluate((sel) => document.querySelector(`${sel} video`)?.muted, P))) problems.push('点了静音但没有静音');
  await must('取消静音', click(`${P} .player-btn`, 1));
  await must('点暂停', click(`${P} .player-btn`, 0));
  await sleep(200);
  if (!(await pg.evaluate((sel) => document.querySelector(`${sel} video`)?.paused, P))) problems.push('点了暂停但还在播放');
  await shot('01b-player');

  // 2b. 卡片：只有画面，下面没有文字；视频铺满画框；控制条和「更多」只在鼠标移到画面上时出现；操作都在「更多」的菜单里
  const cardLook = () =>
    pg.evaluate((sel) => {
      const card = document.querySelector(sel);
      return {
        bar: getComputedStyle(card.querySelector('.player-bar')).opacity,
        more: getComputedStyle(card.querySelector('.card-more')).opacity,
        length: card.querySelector('.player-length')?.textContent || '',
        lengthShown: getComputedStyle(card.querySelector('.player-length') || card).opacity,
        frame: getComputedStyle(card.querySelector('.player')).backgroundColor,
        parts: card.children.length,
        textBelow: card.innerText.replace(card.querySelector('.card-media').innerText, '').trim(),
        named: Boolean(card.getAttribute('aria-label')),
      };
    }, P);
  await pg.locator('.brand').hover();
  await sleep(350);
  const away = await cardLook();
  if (away.bar !== '0' || away.more !== '0') problems.push(`鼠标不在卡片上时，控制条和「更多」应该隐藏：${JSON.stringify(away)}`);
  if (away.parts !== 1 || away.textBelow || !away.named) problems.push(`卡片应该只有画面，下面没有文字和按钮：${JSON.stringify(away)}`);
  // 视频卡片左下角标着时长（00:05 这样），鼠标移上来、控制条出现时让开；画框空出来的地方是灰色底，不是黑色
  if (!/^\d\d:\d\d$/.test(away.length) || away.lengthShown !== '1') problems.push(`视频卡片左下角应该标着时长：${JSON.stringify(away)}`);
  if (away.frame === 'rgb(0, 0, 0)') problems.push('视频卡片的画框底色不应该是黑色');
  // 视频比例和画框差不多时要铺满，四边都不露出播放器的黑底；差得多（比如竖屏）才完整显示
  const fit = await pg.evaluate((sel) => {
    const video = document.querySelector(`${sel} video`);
    const frame = document.querySelector(`${sel} .card-media`);
    const close = Math.abs(video.videoWidth / video.videoHeight / (16 / 9) - 1) < 0.03;
    const v = video.getBoundingClientRect();
    const f = frame.getBoundingClientRect();
    const border = parseFloat(getComputedStyle(frame).borderLeftWidth);
    return { close, objectFit: getComputedStyle(video).objectFit, covers: v.left <= f.left + border + 0.01 && v.right >= f.right - border - 0.01 && v.top <= f.top + border + 0.01 && v.bottom >= f.bottom - border - 0.01, size: `${video.videoWidth}x${video.videoHeight}` };
  }, P);
  if (fit.objectFit !== (fit.close ? 'cover' : 'contain') || !fit.covers) problems.push(`视频没有按规则铺满画框：${JSON.stringify(fit)}`);
  await pg.locator(`${P} .card-media`).hover();
  await sleep(350);
  const over = await cardLook();
  if (over.bar !== '1' || over.more !== '1') problems.push(`鼠标移到画面上时，控制条和「更多」应该出现：${JSON.stringify(over)}`);
  if (over.lengthShown !== '0') problems.push('控制条出现时，左下角的时长应该让开');
  await pg.locator(`${P} .card-more`).click();
  await sleep(300);
  const cardMenu = await pg.evaluate((sel) => {
    const menu = document.querySelector('.menu');
    const button = document.querySelector(`${sel} .card-more`);
    return menu && { items: [...menu.querySelectorAll('.menu-item')].map((e) => e.textContent.trim()).join('|'), aligned: Math.abs(menu.getBoundingClientRect().right - button.getBoundingClientRect().right) <= 1, buttonShown: getComputedStyle(button).opacity };
  }, P);
  if (!cardMenu) problems.push('点卡片的「更多」没有打开菜单');
  else {
    if (cardMenu.items !== '下载|复用|延长|修改|配乐|详情|删除') problems.push(`已完成视频卡片的菜单项不对：${cardMenu.items}`);
    if (!cardMenu.aligned) problems.push('「更多」的菜单没有和按钮右对齐');
  }
  if (await count('.modal')) problems.push('点「更多」不应该打开详情');
  await audit('卡片的更多菜单');
  await shot('01c-card-menu');
  await pg.locator('.brand').hover();
  await sleep(350);
  if (cardMenu && (await pg.evaluate((sel) => getComputedStyle(document.querySelector(`${sel} .card-more`)).opacity, P)) !== '1') problems.push('菜单开着的时候，鼠标移开后「更多」按钮不应该消失');
  await must('从菜单进详情', clickText('.menu .menu-item', '详情'));
  await sleep(500);
  if ((await text('.modal h2')).join('') !== '生成详情') problems.push('菜单里的「详情」没有打开详情');
  await escape();
  await sleep(200);
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
// 型号后面的附注说的是它在同一代里是哪一档：同一族的要么都标，要么都不标，不能只标其中一个
const modelNotes = Object.fromEntries(await pg.evaluate(() => [...document.querySelectorAll('.menu .menu-item')].map((e) => [e.querySelector('.menu-item-label').textContent, e.querySelector('.menu-item-note')?.textContent || ''])));
if (modelNotes['seedance-2.0'] !== '专业版' || modelNotes['seedance-2.0-fast'] !== '快速版' || modelNotes['grok-imagine-video'] !== '') problems.push(`型号的附注不对：${JSON.stringify(modelNotes)}`);
if ('seedance2.0-pro' in modelNotes) problems.push('模型菜单里列出了走不通的型号 seedance2.0-pro');
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
if (await count('.more-dot')) problems.push('「更多」上不应该再有提示点');
await outsideClick();
await sleep(200);
if (await count('.more-popover')) problems.push('点外面没有关掉更多面板');
if ((await layout()) !== layoutBefore) problems.push(`关闭面板后页面位置没有复原：${layoutBefore} → ${await layout()}`);

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
if ((await text('.view-create .feed-head h2')).join('') !== '最近生成') problems.push('创作页下方的标题应为「最近生成」');
if ((await count('.view-create h1')) !== 1) problems.push('创作页应该只有一个一级标题（首屏问句），「最近生成」是二级标题');
const sideText = (await text('.sidebar')).join('');
if ((await count('.side-list, .side-row')) || sideText.includes('最近生成')) problems.push('侧栏里不应该有「最近生成」列表');
if ((await text('.sidebar .nav-item')).join('|') !== '创作|创作记录|素材库|真人档案|设置') problems.push(`侧栏的入口不对：${(await text('.sidebar .nav-item')).join('|')}`);
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
await must('打开生成中卡片的更多', click('.view-create .card:first-child .card-more', 0));
await sleep(300);
if ((await text('.menu .menu-item')).join('|') !== '刷新|复用|详情|删除') problems.push(`生成中卡片的菜单项不对：${(await text('.menu .menu-item')).join('|')}`);
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
// 详情的结构：左边是画面，中间是上一条、下一条，右边上面是分组的信息、下面是操作；组与组之间的间距明显大于组内
const detail = await pg.evaluate(() => {
  const modal = document.querySelector('.modal');
  const sections = [...modal.querySelectorAll('.detail-side .detail-section')];
  const tops = sections.map((s) => s.getBoundingClientRect());
  const between = tops.slice(1).map((r, i) => Math.round(r.top - tops[i].bottom));
  const within = sections.map((s) => Math.round(parseFloat(getComputedStyle(s).rowGap)));
  return {
    titles: sections.map((s) => s.querySelector('h3').textContent).join('|'),
    actions: [...modal.querySelectorAll('.detail-side .detail-actions .btn')].map((b) => b.textContent.trim()).join('|'),
    buttonsOutside: [...modal.querySelectorAll('.detail .btn')].filter((b) => !b.closest('.detail-side .detail-actions')).length,
    actionsAtBottom: Math.round(modal.querySelector('.detail-side').getBoundingClientRect().bottom - modal.querySelector('.detail-actions').getBoundingClientRect().bottom) === 0,
    size: [modal.offsetWidth, modal.offsetHeight].join('×'),
    nav: [...modal.querySelectorAll('.detail-nav-btn')].map((b) => b.getAttribute('aria-label')).join('|'),
    copy: Boolean([...modal.querySelectorAll('.detail-section-head button')].find((b) => b.textContent.trim() === '复制')),
    params: modal.querySelectorAll('.param-grid .param').length,
    facts: [...modal.querySelectorAll('.kv dt')].map((d) => d.textContent).join('|'),
    between,
    within,
    sideFits: modal.querySelector('.detail-side').scrollWidth <= modal.querySelector('.detail-side').clientWidth + 1,
  };
});
// 「参考素材」这一组只有用了素材的记录才有。
if (!['提示词|参考素材|生成参数|任务信息', '提示词|生成参数|任务信息'].includes(detail.titles)) problems.push(`详情右侧的分组不对：${detail.titles}`);
if (detail.actions !== '下载视频|复用参数|延长|修改|配乐' || detail.buttonsOutside || !detail.actionsAtBottom) problems.push(`详情的操作应该都在右栏最下面：${detail.actions}，别处的按钮 ${detail.buttonsOutside} 个`);
if (detail.nav !== '上一条|下一条') problems.push(`详情里应该有上一条、下一条：${detail.nav}`);
// 上一条、下一条：换了内容，弹窗的大小不变；方向键也能换
const detailStep = async (how) => {
  if (how === 'key') await pg.keyboard.press('ArrowUp');
  else await must('点下一条', click('.detail-nav-btn:not(.is-prev)'));
  await sleep(400);
  return pg.evaluate(() => ({ id: document.querySelector('.modal .kv .mono').textContent, size: [document.querySelector('.modal').offsetWidth, document.querySelector('.modal').offsetHeight].join('×') }));
};
const detailFirst = await pg.evaluate(() => document.querySelector('.modal .kv .mono').textContent);
const detailNext = await detailStep('click');
if (detailNext.id === detailFirst) problems.push('点「下一条」后详情没有换内容');
if (detailNext.size !== detail.size) problems.push(`换到下一条后弹窗的大小变了：${detail.size} → ${detailNext.size}`);
const detailBack = await detailStep('key');
if (detailBack.id !== detailFirst) problems.push('按上方向键没有回到上一条');
if (!detail.copy) problems.push('提示词这一组的标题旁边应该有「复制」');
if (detail.params < 4 || !detail.facts.startsWith('状态|任务 ID')) problems.push(`详情里的参数或任务信息不全：${detail.params} 项，${detail.facts}`);
if (detail.between.some((gap) => gap < 24) || detail.within.some((gap) => gap * 2 > Math.min(...detail.between))) problems.push(`详情分组的间距不对：组间 ${detail.between.join('/')}，组内 ${detail.within.join('/')}`);
if (!detail.sideFits) problems.push('详情右侧的内容横向溢出了');
// 界面上不展示发给接口的原始请求：那是给开发者看的，不是产品内容
if (await pg.evaluate(() => /请求|"model"|"content"/.test(document.querySelector('.modal').textContent) || Boolean(document.querySelector('.modal pre')))) problems.push('详情里不应该出现请求内容');
await audit('详情弹窗');
await shot('07-detail');
await escape();
await sleep(200);
if (await count('.modal')) problems.push('Esc 没有关掉详情弹窗');
await must('打开最后一张卡片的更多', click('.view-create .card .card-more', (await count('.view-create .card')) - 1));
await sleep(300);
await must('点菜单里的删除', clickText('.menu .menu-item', '删除'));
await sleep(300);
if (!(await text('.modal h2')).join('').includes('删除这条记录')) problems.push('菜单里的「删除」没有弹出确认');
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
// 筛选这一行：左边是类型的分段（和创作页是同一组），右边是条数、状态下拉、搜索
const total = await count(`${V} .card`);
if (!total) problems.push('记录页没有列出记录');
// 筛选这一行：左边是类型的分段，右边只有一个搜索图标。没有条数、没有状态筛选，搜索框平时不展开
const tools = await pg.evaluate((v) => ({ dropdowns: document.querySelectorAll(`${v} .page-tools .dropdown`).length, inputs: document.querySelectorAll(`${v} .page-tools input`).length, icon: document.querySelectorAll(`${v} .page-tools .icon-btn svg`).length, words: document.querySelector(`${v} .page-tools`).innerText.replace(/\s+/g, '') }), V);
if (tools.dropdowns || tools.inputs || tools.icon !== 1 || tools.words !== '全部视频图片语音音效配乐') problems.push(`记录页的筛选行不对：${JSON.stringify(tools)}`);
// 点搜索图标展开输入框并把光标放进去；words 为空且没展开时不用管
const searchFor = async (words) => {
  if (!(await count(`${V} input.search`))) {
    if (!words) return;
    await must('点搜索图标', click(`${V} .page-tools .icon-btn`));
    await sleep(300);
    if (!(await pg.evaluate((v) => document.activeElement === document.querySelector(`${v} input.search`), V))) problems.push('点搜索图标后光标没有进输入框');
  }
  await pg.locator(`${V} input.search`).fill(words);
  await sleep(300);
};
if ((await text(`${V} .filters .seg`)).join('|') !== '全部|视频|图片|语音|音效|配乐') problems.push(`记录页的类型切换不对：${(await text(`${V} .filters .seg`)).join('|')}`);
await audit('创作记录页');
await shot('08b-records');
// 同一时间只放一个：播着一条再去播另一条，前一条要停下并回到开头
const solo = (i) => `${V} [data-solo="${i}"]`;
const playable = await pg.evaluate((v) => {
  const cards = [...document.querySelectorAll(`${v} .card`)].filter((card) => card.querySelector('.player-btn, .audio-play')).slice(0, 2);
  cards.forEach((card, i) => { card.dataset.solo = String(i); });
  return cards.length;
}, V);
if (playable < 2) problems.push('记录页里能播放的不到两条，「同一时间只放一个」没有测到');
else {
  const mediaOf = (i) => pg.evaluate((s) => { const m = document.querySelector(`${s} :is(video, audio)`); return m ? { paused: m.paused, time: m.currentTime } : null; }, solo(i));
  await pg.locator(`${solo(0)} :is(.player-btn, .audio-play)`).first().click();
  await sleep(500);
  const before = await mediaOf(0);
  await pg.locator(`${solo(1)} :is(.player-btn, .audio-play)`).first().click();
  await sleep(500);
  const after = { first: await mediaOf(0), second: await mediaOf(1) };
  if (!before || before.paused || before.time <= 0) problems.push(`记录页里点了播放但没有播起来：${JSON.stringify(before)}`);
  else if (!after.first?.paused || after.first.time !== 0 || after.second?.paused !== false) problems.push(`播放另一条时，前一条没有停下并回到开头：${JSON.stringify(after)}`);
  await pg.evaluate((s) => document.querySelector(`${s} :is(video, audio)`)?.pause(), solo(1));
}
// 搜这次走查自己提交的那条，不依赖数据里碰巧有什么
await searchFor('工作室');
await audit('创作记录页·搜索展开');
const found = await pg.evaluate((v) => [...document.querySelectorAll(`${v} .card`)].map((c) => c.getAttribute('aria-label') || ''), V);
if (!found.length || found.some((t) => !t.includes('工作室'))) problems.push('按提示词搜索的结果不对');
await searchFor('不存在的提示词');
if ((await count(`${V} .card`)) || !(await text(`${V} .empty`)).join('').includes('没有符合条件的记录')) problems.push('搜不到时没有显示空状态');
await searchFor('工作室');
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

// 6c. 视频之外的四种创作：图片、语音、音效、配乐；以及提示词润色、Grok 视频
const typeSeg = (label) => clickText('.type-switch .seg', label);
const composer = () =>
  pg.evaluate(() => ({
    title: document.querySelector('.composer-title').textContent,
    tools: [...document.querySelectorAll('.composer-params > *')].map((e) => e.textContent.trim()),
    promptHidden: document.querySelector('textarea.prompt').hidden,
    stray: /undefined|null|NaN/.test(document.querySelector('.composer-card').innerText),
    extraRows: document.querySelectorAll('.composer-card ~ *, .composer-card > :not(.media-block):not(.prompt):not(.composer-bar)').length,
  }));
const feedFirst = () => pg.evaluate(() => document.querySelector('.view-create .card .card-media > :first-child')?.className || '');
// 「最近生成」里本来就有同类型的旧记录。提交前先给现有的卡片做记号，
// 之后等的是"排在最前面的是一张没有记号的、已经出结果的卡片"，才不会把旧的当成新的。
const markOld = () => pg.evaluate(() => document.querySelectorAll('.view-create .card').forEach((card) => { card.dataset.old = '1'; }));
const waitNew = async (cls, what, tries = 20) => {
  const arrived = () => pg.evaluate((c) => { const card = document.querySelector('.view-create .card'); return Boolean(card && !card.dataset.old && card.querySelector('.card-media > :first-child')?.className.includes(c)); }, cls);
  for (let i = 0; i < tries && !(await arrived()); i += 1) await sleep(500);
  if (!(await arrived())) problems.push(`${what}：最新一张卡片是 ${await feedFirst()}`);
};
const detailOf = () =>
  pg.evaluate(() => {
    const modal = document.querySelector('.modal');
    return modal ? { titles: [...modal.querySelectorAll('.detail-side h3')].map((e) => e.textContent).join('|'), actions: [...modal.querySelectorAll('.detail-actions > *')].map((e) => e.textContent.trim()).join('|'), media: modal.querySelector('.detail-media > *')?.className || '' } : null;
  });
const openFirstCard = async () => {
  await must('点最新一张卡片的画面', click('.view-create .card .card-media', 0));
  await sleep(500);
};

if ((await text('.type-switch .seg')).join('|') !== '视频|图片|语音|音效|配乐') problems.push(`类型切换的选项不对：${(await text('.type-switch .seg')).join('|')}`);
// 「最近生成」跟着上面选的类型走：只列这一种，别的类型的画面不该出现
const strangers = (selector, label) => count(`.view-create .card :is(${selector})`).then((n) => n && problems.push(`切到${label}后，「最近生成」里还有别的类型的记录`));
if (await count('.view-create .card :is(.image-view, .audio-player)')) problems.push('选着视频时，「最近生成」里不该有图片和音频');

// 图片：三个入口；润色能改写、能撤销；一次两张就是两张卡片
await must('切到图片', typeSeg('图片'));
await sleep(300);
await strangers('.player, .audio-player', '图片');
let face = await composer();
if (face.title !== '想生成什么图片？' || face.tools.length !== 3 || face.extraRows || face.stray) problems.push(`图片的输入框不对：${JSON.stringify(face)}`);
// 分段选择里选中项的底色是一块滑块：滑完之后要正好盖在选中的那一格上；动效播完不在节点上留样式
await sleep(500);
const settled = await pg.evaluate(() => {
  const off = [...document.querySelectorAll('.segmented')].filter((s) => s.getClientRects().length && s.querySelector('.seg.active')).filter((s) => {
    const thumb = s.querySelector('.seg-thumb').getBoundingClientRect();
    const active = s.querySelector('.seg.active').getBoundingClientRect();
    return Math.abs(thumb.left - active.left) > 1 || Math.abs(thumb.width - active.width) > 1;
  });
  const moving = document.getAnimations().filter((a) => a.playState === 'running' && a.animationName !== 'spin').length;
  return { off: off.map((s) => s.className), moving, card: document.querySelector('.composer-card').getAttribute('style') };
});
if (settled.off.length || settled.moving || settled.card) problems.push(`切换类型的动效没有收干净：${JSON.stringify(settled)}`);
await pg.locator('textarea.prompt').fill('静水上的红色纸船');
await must('点润色', click('[data-control=polish]'));
await sleep(900);
const polished = await pg.evaluate(() => document.querySelector('textarea.prompt').value);
if (polished === '静水上的红色纸船' || (await text('[data-control=polish]')).join('') !== '撤销润色') problems.push(`润色没有改写提示词，或者没有变成「撤销润色」：${polished}`);
await must('撤销润色', click('[data-control=polish]'));
await sleep(200);
if ((await pg.evaluate(() => document.querySelector('textarea.prompt').value)) !== '静水上的红色纸船' || (await text('[data-control=polish]')).join('') !== '润色') problems.push('撤销润色没有恢复原文');
await must('打开数量菜单', click('[data-control=count]'));
await sleep(200);
await audit('图片·数量菜单');
await must('选 2 张', clickText('.menu .menu-item', '2 张'));
await sleep(200);
await must('打开比例菜单', click('[data-control=ratio]'));
await sleep(200);
await shot('12-image');
await must('选 9:16', clickText('.menu .menu-item', '9:16'));
await sleep(200);
await markOld();
await must('生成图片', click('.send-btn'));
await waitNew('image-view', '图片没有生成出来');
if ((await pg.evaluate(() => [...document.querySelectorAll('.view-create .card')].slice(0, 2).filter((c) => c.querySelector('.image-view') && c.getAttribute('aria-label') === '静水上的红色纸船').length)) !== 2) problems.push('一次生成两张图片，最新的两张卡片应该都是它');
await pg.locator('.view-create .card .card-media').first().hover();
await sleep(350);
await must('打开图片卡片的更多', click('.view-create .card .card-more', 0));
await sleep(300);
if ((await text('.menu .menu-item')).join('|') !== '下载|复用|生成视频|详情|删除') problems.push(`图片卡片的菜单项不对：${(await text('.menu .menu-item')).join('|')}`);
await escape();
await sleep(200);
await openFirstCard();
let view = await detailOf();
if (!view || view.titles !== '提示词|生成参数|任务信息' || view.actions !== '下载图片|复用参数|生成视频' || !view.media.includes('image-view')) problems.push(`图片的详情不对：${JSON.stringify(view)}`);
await audit('图片详情');
await shot('13-image-detail');
await escape();
await sleep(200);
// 「查看全部」带着当前类型去记录页
if (await count('.view-create .feed-head .entry-action-btn:not([hidden])')) {
  await must('点查看全部', click('.view-create .feed-head .entry-action-btn'));
  await sleep(500);
  const landed = await pg.evaluate((v) => ({ active: document.querySelector(`${v} .filters .seg.active`)?.textContent, others: document.querySelectorAll(`${v} .card :is(.player, .audio-player)`).length }), V);
  if (landed.active !== '图片' || landed.others) problems.push(`从图片的「查看全部」进记录页，应该只看图片：${JSON.stringify(landed)}`);
  await must('回到创作', clickText('.nav-item', '创作'));
  await sleep(300);
}

// 图片拿去生成视频：Seedance 下是参考生成，图片作为「图1」，不是首尾帧的首帧
await must('打开图片卡片的更多', click('.view-create .card .card-more', 0));
await sleep(300);
await must('点生成视频', clickText('.menu .menu-item', '生成视频'));
for (let i = 0; i < 30 && !(await count('.view-create .ref-row .ref-tile:not(.ref-add)')); i += 1) await sleep(500);
const fromImage = await pg.evaluate(() => ({ title: document.querySelector('.composer-title').textContent, mode: document.querySelector('[data-control=mode]')?.textContent.trim(), tiles: document.querySelectorAll('.ref-row .ref-tile:not(.ref-add)').length, index: document.querySelector('.ref-row .ref-index')?.textContent, frames: document.querySelectorAll('.frame-slot').length }));
if (fromImage.title !== '想生成什么视频？' || fromImage.mode !== '参考生成' || fromImage.tiles !== 1 || fromImage.index !== '图1' || fromImage.frames) problems.push(`图片点「生成视频」后应该是参考生成、带着这张图：${JSON.stringify(fromImage)}`);
// 图片素材的汇总状态可能是失败，只要要用的模型能用就不该显示处理失败
for (let i = 0; i < 30 && (await count('.ref-state')); i += 1) await sleep(500);
if (await count('.ref-state')) problems.push(`图片素材没有变成可用：${(await text('.ref-state')).join('')}`);
// 换成首尾帧：这张图自动变成首帧，不用重新添加；点互换去尾帧；换回参考生成，图还在
const frameSlots = () => pg.evaluate(() => [...document.querySelectorAll('.frame-slot')].map((s) => (s.querySelector('.ref-tile:not(.ref-add)') ? '有' : '空')).join(''));
await must('打开生成方式', click(control('mode')));
await sleep(200);
await must('选首尾帧', clickText('.menu .menu-item', '首尾帧'));
await sleep(300);
if ((await frameSlots()) !== '有空') problems.push(`参考生成换成首尾帧，参考图应该变成首帧：${await frameSlots()}`);
await audit('首尾帧·带着参考图');
await shot('frames-carried');
await must('点互换', click('.frames-swap'));
await sleep(200);
if ((await frameSlots()) !== '空有') problems.push(`点互换后图应该在尾帧：${await frameSlots()}`);
await must('再点互换', click('.frames-swap'));
await sleep(200);
if ((await frameSlots()) !== '有空') problems.push(`再点互换后图应该回到首帧：${await frameSlots()}`);
await must('打开生成方式', click(control('mode')));
await sleep(200);
await must('选参考生成', clickText('.menu .menu-item', '参考生成'));
await sleep(300);
if ((await count('.ref-row .ref-tile:not(.ref-add)')) !== 1 || (await count('.frame-slot'))) problems.push('首尾帧换回参考生成，首帧应该回到参考图里');
await must('移除参考图', click('.ref-row .ref-remove'));
await must('打开生成方式', click(control('mode')));
await sleep(200);
await must('选文生视频', clickText('.menu .menu-item', '文生视频'));
await sleep(200);

// 语音：一个入口（音色）；面板里能筛语言、能试听；没有润色
await must('切到语音', typeSeg('语音'));
await sleep(900);
await strangers('.player, .image-view', '语音');
face = await composer();
if (face.title !== '想让它读什么？' || face.tools.length !== 1 || face.stray || (await count('[data-control=polish]'))) problems.push(`语音的输入框不对：${JSON.stringify(face)}`);
const beforeVoices = await layout();
await must('打开音色面板', click('[data-control=voice]'));
await sleep(400);
if ((await layout()) !== beforeVoices) problems.push('打开音色面板后输入框或记录的位置变了');
const voicePanel = await pg.evaluate(() => ({ rows: document.querySelectorAll('.voice-popover .voice-row').length, previews: [...document.querySelectorAll('.voice-popover .voice-row .entry-action-btn')].filter((b) => b.textContent === '试听').length, selected: document.querySelectorAll('.voice-popover .voice-row.selected').length, filters: [...document.querySelectorAll('.voice-popover .seg')].map((e) => e.textContent).join('|') }));
if (voicePanel.rows < 2 || voicePanel.previews !== voicePanel.rows || voicePanel.selected !== 1 || voicePanel.filters !== '全部|中文|英语|其他') problems.push(`音色面板不对：${JSON.stringify(voicePanel)}`);
await audit('音色面板');
await shot('14-voices');
await must('只看中文', clickText('.voice-popover .seg', '中文'));
await sleep(200);
if ((await count('.voice-popover .voice-row')) >= voicePanel.rows) problems.push('按语言筛选音色没有生效');
await must('选一个音色', click('.voice-popover .voice-pick', 0));
await sleep(300);
if (await count('.voice-popover')) problems.push('选完音色后面板没有收起');
await pg.locator('textarea.prompt').fill('你好，这是一次走查。');
await markOld();
await must('生成语音', click('.send-btn'));
await waitNew('audio-player', '语音没有生成出来');
// 音频卡片：没有画面，控制条一直显示；点控制条不打开详情
await pg.locator('.brand').hover();
await sleep(300);
const audioCard = await pg.evaluate(() => {
  const card = document.querySelector('.view-create .card');
  const controls = card.querySelector('.audio-controls');
  return controls ? { shown: getComputedStyle(controls).opacity, kind: card.querySelector('.audio-kind')?.textContent || '', text: card.querySelector('.audio-text')?.textContent || '', parts: card.children.length } : null;
});
if (!audioCard || audioCard.shown !== '1' || !audioCard.kind.startsWith('语音') || !audioCard.text.includes('走查') || audioCard.parts !== 1) problems.push(`语音卡片不对：${JSON.stringify(audioCard)}`);
await pg.locator('.view-create .card .audio-play').first().click();
await sleep(300);
if (await count('.modal')) problems.push('点音频的播放键不应该打开详情');
// 音色试听也算在「同一时间只放一个」里：卡片播着时点试听，卡片要停下并回到开头。
// 示例音频可能很短，先让它循环着，不然还没点试听它自己就放完了；没给 MOCK_AUDIO 时音频播不起来，这一条测不到。
const cardSounding = await pg.evaluate(() => {
  const audio = document.querySelector('.view-create .card audio');
  audio.loop = true;
  return !audio.paused && audio.readyState >= 2;
});
if (cardSounding) {
  await must('再打开音色面板', click('[data-control=voice]'));
  await sleep(300);
  await pg.locator('.voice-popover .voice-row .entry-action-btn').first().click();
  await sleep(300);
  const quiet = await pg.evaluate(() => { const audio = document.querySelector('.view-create .card audio'); return { paused: audio.paused, time: audio.currentTime }; });
  if (!quiet.paused || quiet.time !== 0) problems.push(`点音色试听时，正在放的卡片没有停下并回到开头：${JSON.stringify(quiet)}`);
  await escape();
  await sleep(200);
  if (await count('.voice-popover')) problems.push('按 Esc 没有收起音色面板');
}
await pg.evaluate(() => document.querySelector('.view-create .card audio').pause());
await openFirstCard();
view = await detailOf();
if (!view || view.titles !== '朗读的文字|生成参数|任务信息' || view.actions !== '下载音频|复用参数') problems.push(`语音的详情不对：${JSON.stringify(view)}`);
await audit('语音详情');
await shot('15-speech-detail');
await escape();
await sleep(200);

// 音效：两个入口
await must('切到音效', typeSeg('音效'));
await sleep(300);
face = await composer();
if (face.title !== '想要什么声音？' || face.tools.length !== 2 || face.stray) problems.push(`音效的输入框不对：${JSON.stringify(face)}`);
await must('打开贴合度菜单', click('[data-control=influence]'));
await sleep(200);
await audit('音效·贴合度菜单');
await escape();
await sleep(150);
await pg.locator('textarea.prompt').fill('厚重的关门声');
await markOld();
await must('生成音效', click('.send-btn'));
await sleep(700);
await waitNew('audio-player', '音效没有生成出来');

// 延长和修改：从视频卡片的菜单进来。视频先传进素材库，然后切到参考生成，提示词填好开头的句式和结尾的约束，光标停在两者之间
await must('进入创作记录', clickText('.nav-item', '创作记录'));
await sleep(500);
await searchFor('');
await must('看全部类型', clickText(`${V} .filters .seg`, '全部'));
await sleep(300);
for (const [label, lead, keep] of [['延长', '向后延长视频1：', '镜头和景别保持不变。'], ['修改', '严格编辑视频1，', '其他内容、动作和运镜保持不变。']]) {
  const at = await pg.evaluate((v) => [...document.querySelectorAll(`${v} .card`)].findIndex((c) => c.querySelector('.player')), V);
  await must(`打开视频卡片的更多（${label}）`, click(`${V} .card .card-more`, at));
  await sleep(300);
  await must(`点${label}`, clickText('.menu .menu-item', label));
  const arrived = () => pg.evaluate((want) => Boolean(document.querySelector('.view-create:not([hidden]) .ref-row .ref-tile:not(.ref-add)')) && document.querySelector('textarea.prompt').value.startsWith(want), lead);
  for (let i = 0; i < 30 && !(await arrived()); i += 1) await sleep(500);
  await sleep(300);
  const reworked = await pg.evaluate(() => {
    const prompt = document.querySelector('textarea.prompt');
    return { prompt: prompt.value, caret: prompt.selectionStart, focused: document.activeElement === prompt, mode: document.querySelector('[data-control=mode]')?.textContent.trim(), videos: document.querySelectorAll('.ref-row .ref-tile:not(.ref-add)').length, index: document.querySelector('.ref-row .ref-index')?.textContent };
  });
  if (reworked.prompt !== `${lead}\n${keep}` || reworked.caret !== lead.length || !reworked.focused || reworked.mode !== '参考生成' || reworked.videos !== 1 || reworked.index !== '视频1') problems.push(`从视频卡片点「${label}」后输入框不对：${JSON.stringify(reworked)}`);
  // 视频素材的汇总状态是「失败」，但要用的模型在可用列表里：不能显示成处理失败，等它处理完就能提交
  for (let i = 0; i < 30 && (await count('.ref-state')); i += 1) await sleep(500);
  if (await count('.ref-state')) problems.push(`${label}：视频素材没有变成可用：${(await text('.ref-state')).join('')}`);
  if ((await pg.evaluate(() => document.querySelector('.send-btn').dataset.tip)) !== '生成视频（⌘ Enter）') problems.push(`${label}：素材可用后还是不能提交：${await pg.evaluate(() => document.querySelector('.send-btn').dataset.tip)}`);
  await audit(`${label}视频`);
  if (label === '延长') await shot('20-extend');
  await must('回到创作记录', clickText('.nav-item', '创作记录'));
  await sleep(400);
}
// 收拾一下，免得影响后面的检查：移除视频素材，换回文生视频，清空提示词
await must('回到创作', clickText('.nav-item', '创作'));
await sleep(300);
await must('移除视频素材', click('.ref-row .ref-remove'));
await must('打开生成方式', click(control('mode')));
await sleep(200);
await must('选文生视频', clickText('.menu .menu-item', '文生视频'));
await sleep(200);
await pg.locator('textarea.prompt').fill('');

// 配乐：从视频卡片的菜单进来，视频已经选好；没有提示词输入框
// 这时创作页最新的几条已经是图片和音频了，视频到记录页里找。
await must('进入创作记录', clickText('.nav-item', '创作记录'));
await sleep(500);
await searchFor('');
await must('看全部类型', clickText(`${V} .filters .seg`, '全部'));
await sleep(300);
const videoIndex = await pg.evaluate((v) => [...document.querySelectorAll(`${v} .card`)].findIndex((c) => c.querySelector('.player')), V);
await must('打开视频卡片的更多', click(`${V} .card .card-more`, videoIndex));
await sleep(300);
await must('点配乐', clickText('.menu .menu-item', '配乐'));
await sleep(1800);
face = await composer();
if (face.title !== '给哪段视频配乐？' || !face.promptHidden || face.stray || face.extraRows) problems.push(`配乐的输入框不对：${JSON.stringify(face)}`);
if ((await count('.frame-slot .ref-tile:not(.ref-add)')) !== 1 || !/\d+ 秒/.test((await text('.frame-slot')).join(''))) problems.push(`从视频卡片点「配乐」后，视频没有选好：${(await text('.frame-slot')).join('')}`);
await audit('配乐');
await shot('16-music');
await markOld();
await must('生成配乐', click('.send-btn'));
await sleep(700);
if (!(await feedFirst()).includes('is-pending')) problems.push('提交配乐后没有出现生成中的卡片');
// 配乐是异步任务：模拟接口要十几秒才出结果，再加上本地服务的轮询间隔。
await waitNew('audio-player', '配乐没有生成出来', 120);
await openFirstCard();
await sleep(400);
view = await detailOf();
// 配乐的详情：原视频和音乐一起放，所以左边是带画面的播放器；没有提示词这一组
if (!view || view.titles !== '生成参数|任务信息' || !view.media.split(' ').includes('player') || !(await count('.modal .player audio'))) problems.push(`配乐的详情不对：${JSON.stringify(view)}`);
await audit('配乐详情');
await shot('17-music-detail');
await escape();
await sleep(200);
if (await pg.evaluate(() => [...document.querySelectorAll('video, audio')].some((m) => m.isConnected && !m.paused))) problems.push('关掉配乐详情后还有声音在放');

// Grok 视频：只有文生和图生两种方式，没有「更多」；不支持的比例和分辨率不能选
await must('切回视频', typeSeg('视频'));
await sleep(300);
await strangers('.image-view, .audio-player', '视频');
await must('打开模型菜单', click(control('model')));
await sleep(200);
await must('选 Grok', clickText('.menu .menu-item', 'grok-imagine-video'));
await sleep(300);
face = await composer();
if (face.tools.length !== 4 || face.tools.some((t) => t === '更多')) problems.push(`Grok 的工具栏不对：${face.tools.join(' | ')}`);
await must('打开生成方式', click(control('mode')));
await sleep(200);
if ((await text('.menu .menu-item .menu-item-label')).join('|') !== '文生视频|图生视频') problems.push(`Grok 的生成方式不对：${(await text('.menu .menu-item .menu-item-label')).join('|')}`);
await must('选图生视频', clickText('.menu .menu-item', '图生视频'));
await sleep(300);
if ((await count('.frame-slot')) !== 1) problems.push('Grok 的图生视频应该只有首帧一个格子');
await must('点添加首帧', click('.frame-slot .ref-add'));
await sleep(300);
if ((await text('.modal .tabs .seg')).join('|') !== '本地上传|粘贴链接|生成记录') problems.push(`Grok 选首帧的来源不对：${(await text('.modal .tabs .seg')).join('|')}`);
await must('切到生成记录', clickText('.modal .tabs .seg', '生成记录'));
await sleep(300);
await audit('选首帧·生成记录');
await shot('18-grok-frame-picker');
await must('选一张生成的图', click('.modal .pick-card', 0));
await sleep(900);
if ((await count('.modal')) || (await count('.frame-slot .ref-tile:not(.ref-add)')) !== 1) problems.push('从生成记录选首帧没有成功');
await must('打开画面面板', click(control('frame')));
await sleep(250);
const grokFrame = await pg.evaluate(() => ({ ratios: [...document.querySelectorAll('.frame-popover .ratio-option:disabled')].map((e) => e.textContent.trim()).join('|'), res: [...document.querySelectorAll('.frame-popover .seg:disabled')].map((e) => e.textContent).join('|') }));
if (grokFrame.ratios !== '21:9|自适应' || grokFrame.res !== '1080p') problems.push(`Grok 的画面面板没有禁用不支持的选项：${JSON.stringify(grokFrame)}`);
await audit('Grok·画面面板');
await must('收起画面面板', click(control('frame')));
await sleep(200);
// 换回 Seedance，免得影响后面的检查
await must('移除首帧', click('.frame-slot .ref-remove'));
await must('打开生成方式', click(control('mode')));
await sleep(200);
await must('选文生视频', clickText('.menu .menu-item', '文生视频'));
await sleep(200);
await must('打开模型菜单', click(control('model')));
await sleep(200);
await must('选回 Seedance', clickText('.menu .menu-item', 'seedance-2.0'));
await sleep(300);
if ((await composer()).tools.length !== 5) problems.push('换回 Seedance 后工具栏不是 5 个入口');

// 记录页：按类型筛选（先清掉前面留在搜索框里的字）
await must('进入创作记录', clickText('.nav-item', '创作记录'));
await sleep(500);
await searchFor('');
await sleep(300);
for (const [label, mark] of [['图片', '.image-view'], ['语音', '.audio-kind'], ['配乐', '.audio-kind']]) {
  await must(`只看${label}`, clickText(`${V} .filters .seg`, label));
  await sleep(400);
  const only = await pg.evaluate(([v, m, l]) => {
    const cards = [...document.querySelectorAll(`${v} .card`)];
    // 已完成的卡片要带这种类型的画面；音频还要看面板上写的是不是这一种
    const wrong = cards.filter((c) => !c.querySelector('.card-state') && !(c.querySelector(m) && (m !== '.audio-kind' || c.querySelector(m).textContent.startsWith(l)))).length;
    return { cards: cards.length, wrong };
  }, [V, mark, label]);
  if (!only.cards || only.wrong) problems.push(`按「${label}」筛选的结果不对：${JSON.stringify(only)}`);
}
await audit('创作记录·只看配乐');
await shot('19-records-type');
await must('看全部类型', clickText(`${V} .filters .seg`, '全部'));
await sleep(300);
if ((await count(`${V} .card`)) < total) problems.push('切回「全部」后记录没有列全');
// 生成失败的卡片：一个提示图标、标题、原因，文字都在画框里面，不被截掉
const failed = await pg.evaluate((v) => {
  const card = document.querySelector(`${v} .card-state.is-failed`);
  if (!card) return null;
  const box = card.getBoundingClientRect();
  const inside = [...card.children].every((el) => { const r = el.getBoundingClientRect(); return r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5; });
  return { mark: card.querySelectorAll('.state-mark svg').length, title: card.querySelector('.state-title')?.textContent, reason: Boolean(card.querySelector('.state-text')?.textContent), inside, titleColour: getComputedStyle(card.querySelector('.state-title')).color, markColour: getComputedStyle(card.querySelector('.state-mark')).color };
}, V);
if (!failed) problems.push('记录里没有失败的任务，失败卡片的样子没有测到');
else if (failed.mark !== 1 || !failed.title || !failed.reason || !failed.inside || failed.titleColour === failed.markColour) problems.push(`失败卡片不对：${JSON.stringify(failed)}`);

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
await sleep(900);
const settingRows = (await text('.modal .form-label')).join('|');
if (!settingRows.includes('润色用的模型') || !settingRows.includes('账户余额')) problems.push(`设置里缺少润色模型或余额：${settingRows}`);
if (!/剩余 [\d.,]+/.test((await text('.modal .form-row')).join(' '))) problems.push('设置里没有读到余额');
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
await must('回到创作', clickText('.nav-item', '创作'));
await sleep(300);
if (!(await pg.evaluate(() => document.activeElement === document.querySelector('textarea.prompt')))) problems.push('点「创作」后光标没有回到输入框');
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
