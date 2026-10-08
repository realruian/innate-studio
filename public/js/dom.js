// 界面基础件：建节点、图标、提示条、弹窗、浮层菜单、表单控件。
// 所有页面都只用这里的控件，不直接用浏览器原生的下拉框、勾选框和折叠标签。

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'html') el.innerHTML = value; // 只用于内置图标这类可信字符串
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected' || key === 'muted') el[key] = value;
      else if (key === 'title' || key === 'clipTitle') {
        // title：悬停时显示自绘的提示；clipTitle：只在文字被截断时才显示完整内容。
        if (!value) continue;
        el.dataset.tip = value;
        if (key === 'clipTitle') el.dataset.tipClipped = '1';
      } else el.setAttribute(key, value === true ? '' : value);
    }
  }
  append(el, children);
  if (el.dataset.tip && !el.dataset.tipClipped && !el.hasAttribute('aria-label') && !el.textContent.trim()) el.setAttribute('aria-label', el.dataset.tip);
  return el;
}

// 追加子节点：会展开数组，并跳过 null / false。
export function add(el, ...children) {
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

// 图标取自 Hugeicons 免费图标（Stroke Rounded，MIT 许可，见 THIRD-PARTY-NOTICES.md），行尾是原图标名。
// 播放、暂停和喇叭的轮廓填成了实心。
const ICONS = {
  plus: '<path d="M12.001 5.00003V19.002"/><path d="M19.002 12.002L4.99998 12.002"/>', // Add01
  arrowUp: '<path d="M12 5.5V19"/><path d="M18 11C18 11 13.5811 5.00001 12 5C10.4188 4.99999 6 11 6 11"/>', // ArrowUp02
  folder: '<path d="M8 7H16.75C18.8567 7 19.91 7 20.6667 7.50559C20.9943 7.72447 21.2755 8.00572 21.4944 8.33329C22 9.08996 22 10.1433 22 12.25C22 15.7612 22 17.5167 21.1573 18.7779C20.7926 19.3238 20.3238 19.7926 19.7779 20.1573C18.5167 21 16.7612 21 13.25 21H12C7.28595 21 4.92893 21 3.46447 19.5355C2 18.0711 2 15.714 2 11V7.94427C2 6.1278 2 5.21956 2.38032 4.53806C2.65142 4.05227 3.05227 3.65142 3.53806 3.38032C4.21956 3 5.1278 3 6.94427 3C8.10802 3 8.6899 3 9.19926 3.19101C10.3622 3.62712 10.8418 4.68358 11.3666 5.73313L12 7"/>', // Folder01
  user: '<path d="M20 21.0001C19.713 17.269 16.7289 14.3151 12.995 14.0662L12 13.9999C11.6446 14.0096 11.3134 14.0225 11.0008 14.0378C7.3 14.2192 4.28417 17.3057 4 21.0001"/><circle cx="12" cy="6.99988" r="4"/>', // User
  sliders: '<path d="M3 7H6"/><path d="M3 17H9"/><path d="M18 17L21 17"/><path d="M15 7L21 7"/><path d="M6 7C6 6.06812 6 5.60218 6.15224 5.23463C6.35523 4.74458 6.74458 4.35523 7.23463 4.15224C7.60218 4 8.06812 4 9 4C9.93188 4 10.3978 4 10.7654 4.15224C11.2554 4.35523 11.6448 4.74458 11.8478 5.23463C12 5.60218 12 6.06812 12 7C12 7.93188 12 8.39782 11.8478 8.76537C11.6448 9.25542 11.2554 9.64477 10.7654 9.84776C10.3978 10 9.93188 10 9 10C8.06812 10 7.60218 10 7.23463 9.84776C6.74458 9.64477 6.35523 9.25542 6.15224 8.76537C6 8.39782 6 7.93188 6 7Z"/><path d="M12 17C12 16.0681 12 15.6022 12.1522 15.2346C12.3552 14.7446 12.7446 14.3552 13.2346 14.1522C13.6022 14 14.0681 14 15 14C15.9319 14 16.3978 14 16.7654 14.1522C17.2554 14.3552 17.6448 14.7446 17.8478 15.2346C18 15.6022 18 16.0681 18 17C18 17.9319 18 18.3978 17.8478 18.7654C17.6448 19.2554 17.2554 19.6448 16.7654 19.8478C16.3978 20 15.9319 20 15 20C14.0681 20 13.6022 20 13.2346 19.8478C12.7446 19.6448 12.3552 19.2554 12.1522 18.7654C12 18.3978 12 17.9319 12 17Z"/>', // FilterHorizontal
  chevron: '<path d="M18 9.00005C18 9.00005 13.5811 15 12 15C10.4188 15 6 9 6 9"/>', // ArrowDown01
  type: '<path d="M15 21.001H9"/><path d="M12 3.00001V21.0008M12 3.00001C13.3874 3.00001 15.1695 3.03055 16.5884 3.17649C17.1885 3.2382 17.4886 3.26906 17.7541 3.37791C18.3066 3.60429 18.7518 4.10063 18.9194 4.67681C19 4.95382 19 5.26992 19 5.90215M12 3.00001C10.6126 3.00001 8.83047 3.03055 7.41161 3.17649C6.8115 3.2382 6.51144 3.26906 6.24586 3.37791C5.69344 3.60429 5.24816 4.10063 5.08057 4.67681C5 4.95382 5 5.26992 5 5.90215"/>', // Text
  frames: '<path d="M3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124Z"/><path d="M12 2.5V21.5"/>', // Layout2Column
  layers: '<path d="M8.64298 3.14559L6.93816 3.93362C4.31272 5.14719 3 5.75397 3 6.75C3 7.74603 4.31272 8.35281 6.93817 9.56638L8.64298 10.3544C10.2952 11.1181 11.1214 11.5 12 11.5C12.8786 11.5 13.7048 11.1181 15.357 10.3544L17.0618 9.56638C19.6873 8.35281 21 7.74603 21 6.75C21 5.75397 19.6873 5.14719 17.0618 3.93362L15.357 3.14559C13.7048 2.38186 12.8786 2 12 2C11.1214 2 10.2952 2.38186 8.64298 3.14559Z"/><path d="M20.788 11.0972C20.9293 11.2959 21 11.5031 21 11.7309C21 12.7127 19.6873 13.3109 17.0618 14.5072L15.357 15.284C13.7048 16.0368 12.8786 16.4133 12 16.4133C11.1214 16.4133 10.2952 16.0368 8.64298 15.284L6.93817 14.5072C4.31272 13.3109 3 12.7127 3 11.7309C3 11.5031 3.07067 11.2959 3.212 11.0972"/><path d="M20.3767 16.2661C20.7922 16.5971 21 16.927 21 17.3176C21 18.2995 19.6873 18.8976 17.0618 20.0939L15.357 20.8707C13.7048 21.6236 12.8786 22 12 22C11.1214 22 10.2952 21.6236 8.64298 20.8707L6.93817 20.0939C4.31272 18.8976 3 18.2995 3 17.3176C3 16.927 3.20778 16.5971 3.62334 16.2661"/>', // Layers01
  cube: '<path d="M2.79289 21.2071C3.08579 21.5 3.55719 21.5 4.5 21.5H14.5C15.4428 21.5 15.9142 21.5 16.2071 21.2071M2.79289 21.2071C2.5 20.9142 2.5 20.4428 2.5 19.5V9.5C2.5 8.55719 2.5 8.08579 2.79289 7.79289M2.79289 21.2071L8.79289 15.2071M16.2071 21.2071C16.5 20.9142 16.5 20.4428 16.5 19.5V9.5C16.5 8.55719 16.5 8.08579 16.2071 7.79289M16.2071 21.2071L21.2071 16.2071C21.5 15.9142 21.5 15.4428 21.5 14.5V4.5C21.5 3.55719 21.5 3.08579 21.2071 2.79289M16.2071 7.79289C15.9142 7.5 15.4428 7.5 14.5 7.5H4.5C3.55719 7.5 3.08579 7.5 2.79289 7.79289M16.2071 7.79289L21.2071 2.79289M2.79289 7.79289L7.79289 2.79289C8.08579 2.5 8.55719 2.5 9.5 2.5H19.5C20.4428 2.5 20.9142 2.5 21.2071 2.79289M8.79289 15.2071C9.08579 15.5 9.55719 15.5 10.5 15.5H14M8.79289 15.2071C8.5 14.9142 8.5 14.4428 8.5 13.5V10.5"/>', // Cube
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 8V12L14 14"/>', // Clock01
  history: '<path d="M3.49902 14.9656C4.72475 18.4791 8.06749 21 11.999 21C16.9696 21 20.999 16.9706 20.999 12C20.999 7.02944 16.9696 3 11.999 3C8.29827 3 4.8984 5.6756 3.68943 8.5"/><path d="M11.999 7V12L14.999 14"/><path d="M7.49751 8.74363C7.49751 8.74363 3.81388 9.3026 3.25487 8.7436C2.69585 8.1846 3.25488 4.50098 3.25488 4.50098"/>', // History
  more: '<path d="M6.00449 12.5V12M18.0045 12.5V12M12.0045 12.5V12M7.00449 12.5C7.00449 11.9477 6.55677 11.5 6.00449 11.5C5.4522 11.5 5.00449 11.9477 5.00449 12.5C5.00449 13.0523 5.4522 13.5 6.00449 13.5C6.55677 13.5 7.00449 13.0523 7.00449 12.5ZM19.0045 12.5C19.0045 11.9477 18.5568 11.5 18.0045 11.5C17.4522 11.5 17.0045 11.9477 17.0045 12.5C17.0045 13.0523 17.4522 13.5 18.0045 13.5C18.5568 13.5 19.0045 13.0523 19.0045 12.5ZM13.0045 12.5C13.0045 11.9477 12.5568 11.5 12.0045 11.5C11.4522 11.5 11.0045 11.9477 11.0045 12.5C11.0045 13.0523 11.4522 13.5 12.0045 13.5C12.5568 13.5 13.0045 13.0523 13.0045 12.5Z"/>', // MoreHorizontal
  check: '<path d="M5 14L8.5 17.5L19 6.5"/>', // Tick02
  x: '<path d="M18 6L6.00081 17.9992M17.9992 18L6 6.00085"/>', // Cancel01
  play: '<path d="M18.8906 12.846C18.5371 14.189 16.8667 15.138 13.5257 17.0361C10.296 18.8709 8.6812 19.7884 7.37983 19.4196C6.8418 19.2671 6.35159 18.9776 5.95624 18.5787C5 17.6139 5 15.7426 5 12C5 8.2574 5 6.3861 5.95624 5.42132C6.35159 5.02245 6.8418 4.73288 7.37983 4.58042C8.6812 4.21165 10.296 5.12907 13.5257 6.96393C16.8667 8.86197 18.5371 9.811 18.8906 11.154C19.0365 11.7084 19.0365 12.2916 18.8906 12.846Z" fill="currentColor"/>', // Play
  pause: '<path d="M4 7C4 5.58579 4 4.87868 4.43934 4.43934C4.87868 4 5.58579 4 7 4C8.41421 4 9.12132 4 9.56066 4.43934C10 4.87868 10 5.58579 10 7V17C10 18.4142 10 19.1213 9.56066 19.5607C9.12132 20 8.41421 20 7 20C5.58579 20 4.87868 20 4.43934 19.5607C4 19.1213 4 18.4142 4 17V7Z" fill="currentColor"/><path d="M14 7C14 5.58579 14 4.87868 14.4393 4.43934C14.8787 4 15.5858 4 17 4C18.4142 4 19.1213 4 19.5607 4.43934C20 4.87868 20 5.58579 20 7V17C20 18.4142 20 19.1213 19.5607 19.5607C19.1213 20 18.4142 20 17 20C15.5858 20 14.8787 20 14.4393 19.5607C14 19.1213 14 18.4142 14 17V7Z" fill="currentColor"/>', // Pause
  volume: '<path d="M14 14.8135V9.18646C14 6.04126 14 4.46866 13.0747 4.0773C12.1494 3.68593 11.0603 4.79793 8.88232 7.02192C7.75439 8.17365 7.11085 8.42869 5.50604 8.42869C4.10257 8.42869 3.40084 8.42869 2.89675 8.77262C1.85035 9.48655 2.00852 10.882 2.00852 12C2.00852 13.118 1.85035 14.5134 2.89675 15.2274C3.40084 15.5713 4.10257 15.5713 5.50604 15.5713C7.11085 15.5713 7.75439 15.8264 8.88232 16.9781C11.0603 19.2021 12.1494 20.3141 13.0747 19.9227C14 19.5313 14 17.9587 14 14.8135Z" fill="currentColor"/><path d="M17 9C17.6254 9.81968 18 10.8634 18 12C18 13.1366 17.6254 14.1803 17 15"/><path d="M20 7C21.2508 8.36613 22 10.1057 22 12C22 13.8943 21.2508 15.6339 20 17"/>', // VolumeHigh
  mute: '<path d="M14 14.8135V9.18646C14 6.04126 14 4.46866 13.0747 4.0773C12.1494 3.68593 11.0603 4.79793 8.88232 7.02192C7.75439 8.17365 7.11085 8.42869 5.50604 8.42869C4.10257 8.42869 3.40084 8.42869 2.89675 8.77262C1.85035 9.48655 2.00852 10.882 2.00852 12C2.00852 13.118 1.85035 14.5134 2.89675 15.2274C3.40084 15.5713 4.10257 15.5713 5.50604 15.5713C7.11085 15.5713 7.75439 15.8264 8.88232 16.9781C11.0603 19.2021 12.1494 20.3141 13.0747 19.9227C14 19.5313 14 17.9587 14 14.8135Z" fill="currentColor"/><path d="M18 10L22 14M18 14L22 10"/>', // VolumeMute02
  expand: '<path d="M15.5 21C16.8956 21 17.5933 21 18.1611 20.8278C19.4395 20.44 20.44 19.4395 20.8278 18.1611C21 17.5933 21 16.8956 21 15.5M21 8.5C21 7.10444 21 6.40666 20.8278 5.83886C20.44 4.56046 19.4395 3.56004 18.1611 3.17224C17.5933 3 16.8956 3 15.5 3M8.5 21C7.10444 21 6.40666 21 5.83886 20.8278C4.56046 20.44 3.56004 19.4395 3.17224 18.1611C3 17.5933 3 16.8956 3 15.5M3 8.5C3 7.10444 3 6.40666 3.17224 5.83886C3.56004 4.56046 4.56046 3.56004 5.83886 3.17224C6.40666 3 7.10444 3 8.5 3"/>', // FullScreen
  gear: '<path d="M21.3175 7.14139L20.8239 6.28479C20.4506 5.63696 20.264 5.31305 19.9464 5.18388C19.6288 5.05472 19.2696 5.15664 18.5513 5.36048L17.3311 5.70418C16.8725 5.80994 16.3913 5.74994 15.9726 5.53479L15.6357 5.34042C15.2766 5.11043 15.0004 4.77133 14.8475 4.37274L14.5136 3.37536C14.294 2.71534 14.1842 2.38533 13.9228 2.19657C13.6615 2.00781 13.3143 2.00781 12.6199 2.00781H11.5051C10.8108 2.00781 10.4636 2.00781 10.2022 2.19657C9.94085 2.38533 9.83106 2.71534 9.61149 3.37536L9.27753 4.37274C9.12465 4.77133 8.84845 5.11043 8.48937 5.34042L8.15249 5.53479C7.73374 5.74994 7.25259 5.80994 6.79398 5.70418L5.57375 5.36048C4.85541 5.15664 4.49625 5.05472 4.17867 5.18388C3.86109 5.31305 3.67445 5.63696 3.30115 6.28479L2.80757 7.14139C2.45766 7.74864 2.2827 8.05227 2.31666 8.37549C2.35061 8.69871 2.58483 8.95918 3.05326 9.48012L4.0843 10.6328C4.3363 10.9518 4.51521 11.5078 4.51521 12.0077C4.51521 12.5078 4.33636 13.0636 4.08433 13.3827L3.05326 14.5354C2.58483 15.0564 2.35062 15.3168 2.31666 15.6401C2.2827 15.9633 2.45766 16.2669 2.80757 16.8741L3.30114 17.7307C3.67443 18.3785 3.86109 18.7025 4.17867 18.8316C4.49625 18.9608 4.85542 18.8589 5.57377 18.655L6.79394 18.3113C7.25263 18.2055 7.73387 18.2656 8.15267 18.4808L8.4895 18.6752C8.84851 18.9052 9.12464 19.2442 9.2775 19.6428L9.61149 20.6403C9.83106 21.3003 9.94085 21.6303 10.2022 21.8191C10.4636 22.0078 10.8108 22.0078 11.5051 22.0078H12.6199C13.3143 22.0078 13.6615 22.0078 13.9228 21.8191C14.1842 21.6303 14.294 21.3003 14.5136 20.6403L14.8476 19.6428C15.0004 19.2442 15.2765 18.9052 15.6356 18.6752L15.9724 18.4808C16.3912 18.2656 16.8724 18.2055 17.3311 18.3113L18.5513 18.655C19.2696 18.8589 19.6288 18.9608 19.9464 18.8316C20.264 18.7025 20.4506 18.3785 20.8239 17.7307L21.3175 16.8741C21.6674 16.2669 21.8423 15.9633 21.8084 15.6401C21.7744 15.3168 21.5402 15.0564 21.0718 14.5354L20.0407 13.3827C19.7887 13.0636 19.6098 12.5078 19.6098 12.0077C19.6098 11.5078 19.7888 10.9518 20.0407 10.6328L21.0718 9.48012C21.5402 8.95918 21.7744 8.69871 21.8084 8.37549C21.8423 8.05227 21.6674 7.74864 21.3175 7.14139Z"/><path d="M15.5195 12C15.5195 13.933 13.9525 15.5 12.0195 15.5C10.0865 15.5 8.51953 13.933 8.51953 12C8.51953 10.067 10.0865 8.5 12.0195 8.5C13.9525 8.5 15.5195 10.067 15.5195 12Z"/>', // Settings01
};

export function icon(name, size = 16) {
  return h('span', {
    class: 'icon',
    'aria-hidden': 'true',
    html: `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`,
  });
}

export function toast(message, type = 'info', ms = 3600) {
  const root = document.getElementById('toast-root');
  const el = h('div', { class: `toast toast-${type}`, role: 'status' }, message);
  root.append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }, ms);
}

// ---------- 提示气泡 ----------
// 代替浏览器的原生 title 提示：鼠标停留半秒后在元素旁边显示一行说明。

let tipEl = null;
let tipTimer = 0;
let tipTarget = null;

function hideTip() {
  clearTimeout(tipTimer);
  tipTarget = null;
  tipEl?.remove();
  tipEl = null;
}

function showTip(target) {
  if (!target.isConnected) return;
  const clipped = target.scrollWidth > target.clientWidth + 1 || target.scrollHeight > target.clientHeight + 1;
  if (target.dataset.tipClipped && !clipped) return;
  tipEl = h('div', { class: 'tooltip', role: 'tooltip' }, target.dataset.tip);
  document.getElementById('layer-root').append(tipEl);
  const a = target.getBoundingClientRect();
  const left = Math.max(8, Math.min(a.left + a.width / 2 - tipEl.offsetWidth / 2, window.innerWidth - tipEl.offsetWidth - 8));
  const below = a.bottom + 6;
  const top = below + tipEl.offsetHeight > window.innerHeight - 8 ? a.top - 6 - tipEl.offsetHeight : below;
  tipEl.style.left = `${Math.round(left)}px`;
  tipEl.style.top = `${Math.round(top)}px`;
}

document.addEventListener('mouseover', (e) => {
  const target = e.target.closest?.('[data-tip]');
  if (target === tipTarget) return;
  hideTip();
  if (!target) return;
  tipTarget = target;
  tipTimer = setTimeout(() => showTip(target), 500);
});
document.addEventListener('mouseout', (e) => {
  if (tipTarget && !tipTarget.contains(e.relatedTarget)) hideTip();
});
document.addEventListener('mousedown', hideTip, true);
document.addEventListener('keydown', hideTip, true);
document.addEventListener('scroll', hideTip, true);

// ---------- 浮层：下拉菜单和气泡面板共用 ----------
// 浮层贴着触发它的按钮显示，不占页面的位置，所以打开时不会把别的内容挤走。

const layers = [];
let lastLayerEscape = -1;

export function openPopover(anchor, content, { className = '', label, onClose, align = 'start' } = {}) {
  const opened = layers.find((l) => l.anchor === anchor);
  if (opened) {
    opened.close();
    return null;
  }
  const el = h('div', { class: `popover ${className}`, role: 'dialog', 'aria-label': label, tabindex: '-1' }, content);
  document.getElementById('layer-root').append(el);

  // 优先放在按钮下方；下方放不下而上方更宽裕时放到上方；都不够就限制高度让它自己滚动。
  function place() {
    // 触发它的按钮已经不在页面上了（比如那一块被重画），浮层也就不该留着。
    if (!anchor.isConnected) {
      layer.close();
      return;
    }
    const a = anchor.getBoundingClientRect();
    const margin = 8;
    const gap = 6;
    el.style.maxHeight = '';
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const below = window.innerHeight - a.bottom - gap - margin;
    const above = a.top - gap - margin;
    // align 为 end 时浮层的右边和按钮的右边对齐，用在贴着右边缘的按钮上。
    const wanted = align === 'end' ? a.right - width : a.left;
    const left = Math.max(margin, Math.min(wanted, window.innerWidth - width - margin));
    let top;
    if (height <= below || below >= above) {
      top = a.bottom + gap;
      el.style.maxHeight = `${Math.max(140, below)}px`;
    } else {
      el.style.maxHeight = `${above}px`;
      top = a.top - gap - Math.min(height, above);
    }
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  const onScroll = (e) => {
    if (!el.contains(e.target)) place();
  };

  const layer = {
    el,
    anchor,
    place,
    close({ restoreFocus = false } = {}) {
      const index = layers.indexOf(layer);
      if (index === -1) return;
      for (const child of layers.slice(index + 1).reverse()) child.close();
      layers.splice(layers.indexOf(layer), 1);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
      el.remove();
      anchor.setAttribute('aria-expanded', 'false');
      if (restoreFocus && anchor.isConnected) anchor.focus();
      onClose?.();
    },
  };

  layers.push(layer);
  anchor.setAttribute('aria-expanded', 'true');
  window.addEventListener('resize', place);
  window.addEventListener('scroll', onScroll, true);
  place();
  return layer;
}

// 点在浮层外面：从最上层开始逐个关闭，直到遇到包含点击位置的那一层。
// 点在触发按钮上不处理，交给按钮自己的点击逻辑去收起。
document.addEventListener(
  'mousedown',
  (e) => {
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      const layer = layers[i];
      if (layer.el.contains(e.target) || layer.anchor.contains(e.target)) return;
      layer.close();
    }
  },
  true,
);

document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape' || !layers.length) return;
    lastLayerEscape = e.timeStamp;
    layers.at(-1).close({ restoreFocus: true });
  },
  true,
);

// 下拉菜单。items: [{ value, label, note, disabled, selected, title }]
// 两种用法：选一个值（每项带 selected，当前项打勾，顶部显示标题），
// 或者一组动作（各项都不带 selected，不显示标题和打勾的位置）。
export function openMenu(anchor, { label, items, onSelect, onClose, align }) {
  const picking = items.some((item) => 'selected' in item);
  const buttons = items.map((item) =>
    h(
      'button',
      {
        type: 'button',
        class: `menu-item ${item.selected ? 'selected' : ''} ${item.danger ? 'danger' : ''}`,
        role: picking ? 'option' : 'menuitem',
        'aria-selected': picking ? String(Boolean(item.selected)) : null,
        disabled: item.disabled,
        title: item.title,
        onClick: () => {
          layer.close({ restoreFocus: true });
          if (!item.selected) onSelect(item.value);
        },
      },
      h('span', { class: 'menu-item-label' }, item.label),
      item.note && h('span', { class: 'menu-item-note' }, item.note),
      picking && h('span', { class: 'menu-item-check' }, item.selected && icon('check', 14)),
    ),
  );

  const layer = openPopover(anchor, [picking && label && h('div', { class: 'menu-title' }, label), h('div', { class: 'menu-list', role: picking ? 'listbox' : 'menu', 'aria-label': label }, buttons)], {
    className: 'menu',
    label,
    onClose,
    align,
  });
  if (!layer) return null;
  layer.el.style.minWidth = `${Math.max(picking ? 168 : 128, Math.round(anchor.getBoundingClientRect().width))}px`;
  layer.place();

  const enabled = buttons.filter((b) => !b.disabled);
  layer.el.addEventListener('keydown', (e) => {
    const index = enabled.indexOf(document.activeElement);
    let next = null;
    const start = enabled.find((b) => b.classList.contains('selected')) || enabled[0];
    if (e.key === 'ArrowDown') next = index === -1 ? start : enabled[(index + 1) % enabled.length];
    else if (e.key === 'ArrowUp') next = index === -1 ? start : enabled[(index - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled.at(-1);
    else if (e.key === 'Tab') layer.close();
    if (next) {
      e.preventDefault();
      next.focus();
    }
  });
  layer.el.focus();
  return layer;
}

// 下拉选择器：按钮上显示当前值，点开是自绘的菜单。
// variant：'tool' 是输入框工具栏里的（图标加文字，无边框）；'field' 是表单里带边框的。
export function dropdown({ label, value, options, onChange, variant = 'field', icon: iconName, control }) {
  const current = options.find((o) => String(o.value) === String(value)) || options[0];
  const tool = variant === 'tool';
  let layer = null;
  const button = h(
    'button',
    {
      type: 'button',
      class: `dropdown dropdown-${variant}`,
      'data-control': control,
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
      'aria-label': `${label}：${current.display || current.label}`,
      onClick: () => {
        if (layer) {
          layer.close();
          return;
        }
        layer = openMenu(button, {
          label,
          items: options.map((o) => ({ ...o, selected: o === current })),
          onSelect: onChange,
          onClose: () => {
            layer = null;
          },
        });
      },
    },
    iconName && icon(iconName),
    h('span', { class: 'dropdown-value' }, current.display || current.label, !tool && current.note && h('span', { class: 'dropdown-note' }, current.note)),
    !tool && icon('chevron', 12),
  );
  return button;
}

// 设置项的一行：左边名称（可带一句说明），右边控件。
export function formRow(label, control, desc) {
  return h('div', { class: 'form-row' }, h('div', { class: 'form-label' }, label, desc && h('span', { class: 'form-desc' }, desc)), h('div', { class: 'form-control' }, control));
}

// ---------- 弹窗 ----------

// 打开弹窗，返回 { close, body }。点遮罩或按 Esc 关闭。
export function openModal({ title, subtitle, content, size = 'md', onClose } = {}) {
  const root = document.getElementById('modal-root');
  const body = h('div', { class: 'modal-body' }, content);
  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    onClose?.();
  };
  const onKey = (e) => {
    // 这次 Esc 已经用来关掉弹窗里的菜单了，就不再关弹窗。
    if (e.key !== 'Escape' || e.timeStamp === lastLayerEscape) return;
    if (root.lastElementChild === overlay) close();
  };
  const overlay = h(
    'div',
    { class: 'modal-overlay', onMousedown: (e) => e.target === overlay && close() },
    h(
      'div',
      { class: `modal modal-${size}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h(
        'header',
        { class: 'modal-head' },
        h('div', null, h('h2', null, title), subtitle && h('p', { class: 'muted small' }, subtitle)),
        h('button', { class: 'modal-close', type: 'button', 'aria-label': '关闭', onClick: close }, icon('x', 16)),
      ),
      body,
    ),
  );
  document.addEventListener('keydown', onKey);
  root.append(overlay);
  return { close, body };
}

export function confirmDialog({ title, message, okText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (value) => {
      answered = true;
      modal.close();
      resolve(value);
    };
    const modal = openModal({
      title,
      size: 'sm',
      onClose: () => !answered && resolve(false),
      content: [
        h('p', { class: 'confirm-text' }, message),
        h(
          'div',
          { class: 'modal-actions' },
          h('button', { class: 'btn', onClick: () => answer(false) }, cancelText),
          h('button', { class: danger ? 'btn btn-danger' : 'btn btn-primary', onClick: () => answer(true) }, okText),
        ),
      ],
    });
  });
}

// ---------- 小工具 ----------

export async function copyText(text, okMessage = '已复制') {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage, 'success', 1800);
  } catch {
    toast('复制失败，请手动选中复制', 'error');
  }
}

export function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay ? `今天 ${time}` : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

export function fmtBytes(n) {
  if (!n) return '';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

// 分段选择器。options: [{ value, label, title, disabled }]
export function segmented(options, value, onChange, extraClass = '') {
  return h(
    'div',
    { class: `segmented ${extraClass}`, role: 'radiogroup' },
    options.map((opt) =>
      h(
        'button',
        {
          type: 'button',
          class: `seg ${opt.value === value ? 'active' : ''}`,
          role: 'radio',
          'aria-checked': String(opt.value === value),
          title: opt.title,
          disabled: opt.disabled,
          onClick: () => opt.value !== value && onChange(opt.value),
        },
        opt.label,
      ),
    ),
  );
}

export function toggle(checked, onChange, label) {
  return h('label', { class: 'switch' }, h('input', { type: 'checkbox', role: 'switch', checked, onChange: (e) => onChange(e.target.checked), 'aria-label': label }));
}
