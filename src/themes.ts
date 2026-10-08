// ---------- 终端配色主题 ----------
// 每套主题包含 xterm 完整的 16 色 ANSI 调色板 + 前景/背景/光标。
// 选择结果持久化到 localStorage，并通过 window 事件实时广播给所有终端标签。
import type { ITheme } from 'xterm';

export interface TermThemeDef {
  id: string;
  name: string;
  theme: ITheme;
}

/**
 * 界面外壳调色板：主界面（侧边栏 / 标签栏 / SFTP 面板 / 集群面板 / 弹窗 / 资源监控）
 * 通过 `:root[data-theme='<id>']` 上的这组 CSS 变量整体换色。
 *
 * 背景：主题原先只区分「深色 / 浅色」两态，切深色主题之间的界面外壳颜色毫无变化，
 * 只有终端本身变色，观感割裂。现在每个主题都带一套完整外壳配色，切换时整界面跟随。
 *
 * `overlay` 为半透明玻璃层（导航栏 / 面板毛玻璃底色），需按明暗给不同透明度，
 * 否则浅色主题下深色玻璃会显得脏。
 */
export interface UiPalette {
  /** 主背景 */
  bg: string;
  /** 抬升面（卡片 / 输入框 / 菜单） */
  bgElev: string;
  /** 面板底色（侧边栏 / SFTP / 集群面板） */
  bgPanel: string;
  /** 悬停态 */
  bgHover: string;
  /** 激活 / 选中态 */
  bgActive: string;
  /** 常规边框 */
  border: string;
  /** 弱边框（内部分隔线） */
  borderSoft: string;
  /** 主文字 */
  text: string;
  /** 次要文字 */
  textDim: string;
  /** 极弱文字（占位符 / 禁用） */
  textFaint: string;
  /** 强调色（按钮 / 选中 / 光标 / 高亮） */
  accent: string;
  /** 强调色半透明底（选中项背景 / 悬停泛光） */
  accentSoft: string;
  /** 强调渐变（主按钮 / 进度条）—— 单色主题给纯色渐变即可 */
  accentGrad: string;
  /** 强调色泛光阴影 */
  accentGlow: string;
  /** 玻璃层底色（半透明） */
  glass: string;
  /** 强玻璃层底色（半透明，浮层用） */
  glassStrong: string;
  /** 成功 / 运行中 */
  green: string;
  /** 警告 */
  warn: string;
  /** 危险 / 错误 */
  danger: string;
  /** Tab 激活态文字 */
  tabActiveText: string;
  /** 背景氛围光晕第 1 层（主强调色，最大最亮） */
  amb1: string;
  /** 背景氛围光晕第 2 层（次强调色，右上） */
  amb2: string;
  /** 背景氛围光晕第 3 层（辅助色，底部） */
  amb3: string;
  /** 背景氛围光晕第 4 层（主强调色弱化，右下） */
  amb4: string;
  /** 背景双层网格线颜色 */
  ambLine: string;
  /** 网格线弱化色（细密网格） */
  ambLineFaint: string;
  /** 玻璃高光（面板顶部亮边） */
  glassHighlight: string;
  /** 卡片顶部光泽 */
  cardShine: string;
  /** 内发光（顶部亮线 + 底部暗线） */
  innerGlow: string;
  /** 阴影三级 */
  shadowSm: string;
  shadowMd: string;
  shadowLg: string;
  /** 上传 / 下载速率语义色（否则切到绿/黄主题会与强调色撞色） */
  netUp: string;
  netDown: string;
}

/** 由主背景 + 强调色推导全套外壳配色的构造器，供各主题复用。 */
function makeUi(opts: {
  bg: string;
  text: string;
  accent: string;
  /** 强调渐变的第二个色停（缺省取 accent 本身 → 纯色渐变） */
  accent2?: string;
  green?: string;
  warn?: string;
  danger?: string;
  /** 强调色 RGB 通道串，用于拼 rgba（如 '79, 140, 255'） */
  accentRgb: string;
}): UiPalette {
  const { bg, text, accent, accentRgb } = opts;
  const isLight = luminance(bg) > 0.5;
  // 深色主题抬升面比背景亮；浅色主题比背景暗
  const dir = isLight ? -1 : 1;
  const accent2 = opts.accent2 ?? accent;
  const rgbBg = toRgbString(bg);
  const rgbAccent = hexToRgb(accent).join(', ');
  const rgbAccent2 = hexToRgb(accent2).join(', ');
  const green = opts.green ?? '#3fb950';
  const warn = opts.warn ?? '#d29922';
  const danger = opts.danger ?? '#f85149';
  // 氛围光晕强度：浅色底需要更弱，否则整片背景糊成带色雾面
  const ambA = (v: number) => (isLight ? v * 0.55 : v);
  return {
    bg,
    bgElev: shift(bg, dir * 6),
    bgPanel: shift(bg, dir * 4),
    bgHover: shift(bg, dir * 12),
    bgActive: shift(bg, dir * 18),
    border: shift(bg, dir * 26),
    borderSoft: shift(bg, dir * 16),
    text,
    textDim: mix(text, bg, isLight ? 0.42 : 0.38),
    textFaint: mix(text, bg, isLight ? 0.62 : 0.58),
    accent,
    accentSoft: `rgba(${accentRgb}, 0.14)`,
    accentGrad: `linear-gradient(135deg, ${accent} 0%, ${accent2} 100%)`,
    accentGlow: `0 6px 22px rgba(${accentRgb}, 0.35)`,
    // 浅色主题玻璃层用浅底 + 低透明度；深色主题沿用暗底
    glass: isLight ? `rgba(${rgbBg}, 0.62)` : `rgba(${rgbBg}, 0.5)`,
    glassStrong: isLight ? `rgba(${rgbBg}, 0.86)` : `rgba(${rgbBg}, 0.76)`,
    green,
    warn,
    danger,
    tabActiveText: mix(accent, isLight ? '#000000' : '#ffffff', 0.55),
    // ---- 氛围光晕：原先硬编码蓝紫青，切到绿/暖橙主题时背景仍是蓝紫 ----
    amb1: `rgba(${rgbAccent}, ${ambA(0.3)})`,
    amb2: `rgba(${rgbAccent2}, ${ambA(0.22)})`,
    amb3: `rgba(${rgbAccent}, ${ambA(0.14)})`,
    amb4: `rgba(${rgbAccent2}, ${ambA(0.12)})`,
    // 网格线：深色下用白线微亮，浅色下用深线微暗
    ambLine: isLight ? 'rgba(40, 60, 90, 0.05)' : 'rgba(255, 255, 255, 0.025)',
    ambLineFaint: isLight ? 'rgba(40, 60, 90, 0.03)' : 'rgba(255, 255, 255, 0.012)',
    // ---- 玻璃质感 / 阴影：原先只在 :root 与 [data-theme='light'] 两处定义，
    //      中间主题会回退到 Ocean 的默认值，这里按明暗统一派生 ----
    glassHighlight: `linear-gradient(180deg, rgba(255, 255, 255, ${isLight ? 0.35 : 0.09}) 0%, transparent 50%)`,
    cardShine: `linear-gradient(180deg, rgba(255, 255, 255, ${isLight ? 0.75 : 0.055}), rgba(255, 255, 255, 0) ${isLight ? '60%' : '55%'})`,
    innerGlow: isLight
      ? `inset 0 1px 0 rgba(255, 255, 255, 0.8), inset 0 -1px 0 rgba(20, 30, 45, 0.08)`
      : `inset 0 1px 0 rgba(255, 255, 255, 0.07), inset 0 -1px 0 rgba(0, 0, 0, 0.2)`,
    shadowSm: isLight
      ? `0 1px 3px rgba(30, 40, 55, 0.12)`
      : `0 2px 8px rgba(0, 0, 0, 0.3)`,
    shadowMd: isLight
      ? `0 6px 20px rgba(30, 40, 55, 0.16)`
      : `0 8px 24px rgba(0, 0, 0, 0.4)`,
    shadowLg: isLight
      ? `0 14px 40px rgba(30, 40, 55, 0.24)`
      : `0 16px 48px rgba(0, 0, 0, 0.55)`,
    // 网络速率色：沿用语义色，但在绿/黄主题下需与强调色拉开距离，
    // 否则「下载中」的绿字会被同色强调背景吞掉。这里取主题绿/黄，
    // 当与强调色色相过近时改用通用色。
    netDown: hueClose(green, accent) ? '#3fb950' : green,
    netUp: hueClose(warn, accent) ? '#d29922' : warn,
  };
}

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [r, g, b]
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
      .join('')
  );
}

/** 整体加减亮度（用于生成抬升面 / 边框层级）。
 *  纯黑（classic-green）等极暗底色下等量加会显得过弱/过冲，
 *  故对极暗底色额外抬高一档，保证边框在白底/黑底上都可辨识。 */
function shift(hex: string, amt: number): string {
  const [r, g, b] = hexToRgb(hex);
  // 极暗底色（感知亮度 < 0.06，如纯黑）需要更大的偏移量，
  // 否则 shift(+26) 得到的 #1a1a1a 在黑底上肉眼几乎不可见
  const boost = luminance(hex) < 0.06 ? 1.55 : 1;
  const a = amt * boost;
  return rgbToHex(r + a, g + a, b + a);
}

/** 两色线性混合，t=0 取 a，t=1 取 b */
function mix(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}

/** 感知亮度（0~1），用于判定明暗主题 */
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function toRgbString(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `${r}, ${g}, ${b}`;
}

/** 色相角（0~360） */
function hue(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/** 两个颜色色相是否过于接近（差值 < 40°，视为撞色） */
function hueClose(a: string, b: string): boolean {
  const da = hue(a);
  const db = hue(b);
  const diff = Math.abs(da - db);
  return Math.min(diff, 360 - diff) < 40;
}

/** 各主题的界面外壳调色板（键为主题 id）。 */
export const UI_PALETTES: Record<string, UiPalette> = {
  ocean: makeUi({
    bg: '#0e1116',
    text: '#d6dae2',
    accent: '#4f8cff',
    accent2: '#7a5cff',
    accentRgb: '79, 140, 255',
  }),
  windterm: makeUi({
    bg: '#1c1c1c',
    text: '#e8e8e2',
    accent: '#819aff',
    accentRgb: '129, 154, 255',
  }),
  'classic-green': makeUi({
    bg: '#000000',
    text: '#33ff33',
    accent: '#33ff33',
    green: '#33ff33',
    warn: '#ffff00',
    danger: '#ff3333',
    accentRgb: '51, 255, 51',
  }),
  light: makeUi({
    bg: '#f5f6f7',
    text: '#333333',
    accent: '#0451a5',
    accent2: '#2b7dd6',
    green: '#00a200',
    warn: '#bbb400',
    danger: '#c91b00',
    accentRgb: '4, 81, 165',
  }),
  'solarized-dark': makeUi({
    bg: '#002b36',
    text: '#93a1a1',
    accent: '#268bd2',
    accent2: '#2aa198',
    green: '#859900',
    warn: '#b58900',
    danger: '#dc322f',
    accentRgb: '38, 139, 210',
  }),
  dracula: makeUi({
    bg: '#282a36',
    text: '#f8f8f2',
    accent: '#bd93f9',
    accent2: '#ff79c6',
    green: '#50fa7b',
    warn: '#f1fa8c',
    danger: '#ff5555',
    accentRgb: '189, 147, 249',
  }),
  gruvbox: makeUi({
    bg: '#282828',
    text: '#ebdbb2',
    accent: '#b8bb26',
    accent2: '#fabd2f',
    green: '#b8bb26',
    warn: '#fabd2f',
    danger: '#fb4934',
    accentRgb: '184, 187, 38',
  }),
  nord: makeUi({
    bg: '#2e3440',
    text: '#d8dee9',
    accent: '#88c0d0',
    accent2: '#81a1c1',
    green: '#a3be8c',
    warn: '#ebcb8b',
    danger: '#bf616a',
    accentRgb: '136, 192, 208',
  }),
};

/** 把主题的界面调色板写入 `<html>` 的 CSS 变量，使整个界面外壳跟随换色。 */
export function applyUiPalette(id: string): void {
  const p = UI_PALETTES[id] ?? UI_PALETTES[TERM_THEMES[0].id];
  if (!p) return;
  const root = document.documentElement;
  const vars: Record<string, string> = {
    '--bg': p.bg,
    '--bg-elev': p.bgElev,
    '--bg-panel': p.bgPanel,
    '--bg-hover': p.bgHover,
    '--bg-active': p.bgActive,
    '--border': p.border,
    '--border-soft': p.borderSoft,
    '--text': p.text,
    '--text-dim': p.textDim,
    '--text-faint': p.textFaint,
    '--accent': p.accent,
    '--accent-soft': p.accentSoft,
    '--accent-grad': p.accentGrad,
    '--accent-glow': p.accentGlow,
    '--glass': p.glass,
    '--glass-strong': p.glassStrong,
    '--green': p.green,
    '--warn': p.warn,
    '--danger': p.danger,
    '--tab-active-text': p.tabActiveText,
    // 悬停泛光 / 边框 / Tab 激活渐变 / 边缘光晕均由强调色派生，
    // 否则这些位置会残留默认蓝色，与主题强调色打架
    '--hover-tint': p.accentSoft,
    '--hover-border': `rgba(${hexToRgb(p.accent).join(', ')}, 0.3)`,
    '--tab-active-grad': `linear-gradient(180deg, rgba(${hexToRgb(p.accent).join(', ')}, 0.26), rgba(${hexToRgb(p.accent).join(', ')}, 0.04))`,
    '--edge-glow': `rgba(${hexToRgb(p.accent).join(', ')}, 0.55)`,
    // ---- 背景氛围层：原先 body::before 里 5 层光晕 + 双层网格全硬编码为
    //      蓝/紫/青，切到墨绿、暖橙主题时背景仍是蓝紫，观感割裂 ----
    '--amb-1': p.amb1,
    '--amb-2': p.amb2,
    '--amb-3': p.amb3,
    '--amb-4': p.amb4,
    '--amb-line': p.ambLine,
    '--amb-line-faint': p.ambLineFaint,
    // ---- 玻璃质感 / 阴影：中间主题原先回退到 Ocean 默认值 ----
    '--glass-highlight': p.glassHighlight,
    '--card-shine': p.cardShine,
    '--inner-glow': p.innerGlow,
    '--shadow-sm': p.shadowSm,
    '--shadow-md': p.shadowMd,
    '--shadow-lg': p.shadowLg,
    // ---- 上传/下载速率语义色：绿主题下 net-down 与强调色同绿会撞色 ----
    '--net-up': p.netUp,
    '--net-down': p.netDown,
  };
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  // 明暗标记保留：供 styles.css 中仅少量「深色专属」细节（如玻璃高光）使用
  root.dataset.theme = luminance(p.bg) > 0.5 ? 'light' : 'dark';
  root.dataset.themeId = id;
}


export const TERM_THEMES: TermThemeDef[] = [
  {
    id: 'ocean',
    name: '深蓝（默认）',
    theme: {
      // 背景与主界面 --bg (#0e1116) 统一，避免终端区与整体界面风格割裂
      background: '#0e1116',
      foreground: '#d6dae2',
      cursor: '#5b9cff',
      cursorAccent: '#0e1116',
      selectionBackground: 'rgba(91, 156, 255, 0.32)',
      black: '#20242c',
      red: '#f07178',
      green: '#8ccf7e',
      yellow: '#e5c07b',
      blue: '#6fa8f6',
      magenta: '#c792ea',
      cyan: '#56c8d8',
      white: '#d6dae2',
      brightBlack: '#5c6470',
      brightRed: '#ff8189',
      brightGreen: '#9ce08c',
      brightYellow: '#f2d08c',
      brightBlue: '#8ab8ff',
      brightMagenta: '#d5a8ff',
      brightCyan: '#6adbe8',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'windterm',
    name: 'WindTerm',
    theme: {
      background: '#1c1c1c',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#1c1c1c',
      selectionBackground: 'rgba(80, 80, 255, 0.4)',
      black: '#333333',
      red: '#c4265e',
      green: '#86b42b',
      yellow: '#d0a500',
      blue: '#3465a4',
      magenta: '#8c6bc8',
      cyan: '#56adbc',
      white: '#e3e3dd',
      brightBlack: '#666666',
      brightRed: '#f92672',
      brightGreen: '#a6e22e',
      brightYellow: '#9e862f',
      brightBlue: '#819aff',
      brightMagenta: '#ae81ff',
      brightCyan: '#66d9ef',
      brightWhite: '#f8f8f2',
    },
  },
  {
    id: 'classic-green',
    name: '经典绿',
    theme: {
      background: '#000000',
      foreground: '#33ff33',
      cursor: '#33ff33',
      cursorAccent: '#000000',
      selectionBackground: 'rgba(51, 255, 51, 0.25)',
      black: '#000000',
      red: '#ff0000',
      green: '#33ff33',
      yellow: '#ffff00',
      blue: '#0066ff',
      magenta: '#cc33ff',
      cyan: '#00ffff',
      white: '#cccccc',
      brightBlack: '#999999',
      brightRed: '#ff3333',
      brightGreen: '#66ff66',
      brightYellow: '#ffff66',
      brightBlue: '#3399ff',
      brightMagenta: '#ff66ff',
      brightCyan: '#66ffff',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'light',
    name: '明亮',
    theme: {
      background: '#f5f6f7',
      foreground: '#333333',
      cursor: '#111111',
      cursorAccent: '#ffffff',
      selectionBackground: 'rgba(0, 120, 215, 0.25)',
      black: '#1e1e1e',
      red: '#c91b00',
      green: '#00a200',
      yellow: '#bbb400',
      blue: '#0451a5',
      magenta: '#a31db1',
      cyan: '#0598a6',
      white: '#c5c1b4',
      brightBlack: '#666666',
      brightRed: '#ff0000',
      brightGreen: '#00d800',
      brightYellow: '#d8d800',
      brightBlue: '#2b7dd6',
      brightMagenta: '#c241d8',
      brightCyan: '#00c8d8',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    theme: {
      background: '#002b36',
      foreground: '#839496',
      cursor: '#93a1a1',
      cursorAccent: '#002b36',
      selectionBackground: 'rgba(147, 161, 161, 0.3)',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#586e75',
      brightRed: '#cb4b16',
      brightGreen: '#93a1a1',
      brightYellow: '#839496',
      brightBlue: '#6c71c4',
      brightMagenta: '#d33682',
      brightCyan: '#2aa198',
      brightWhite: '#fdf6e3',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    theme: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#282a36',
      selectionBackground: 'rgba(68, 71, 90, 0.6)',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox Dark',
    theme: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#ebdbb2',
      cursorAccent: '#282828',
      selectionBackground: 'rgba(235, 219, 178, 0.25)',
      black: '#282828',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#a89984',
      brightBlack: '#928374',
      brightRed: '#fb4934',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#8ec07c',
      brightWhite: '#ebdbb2',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    theme: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      cursorAccent: '#2e3440',
      selectionBackground: 'rgba(216, 222, 233, 0.25)',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#bf616a',
      brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1',
      brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4',
    },
  },
];

const THEME_KEY = 'myterm.theme';

/** 主题广播事件名（App 选择后分发给所有已打开的终端） */
export const THEME_EVENT = 'myterm-theme';

export function getThemeById(id: string): TermThemeDef {
  return TERM_THEMES.find((t) => t.id === id) ?? TERM_THEMES[0];
}

/** 是否为浅色主题（背景亮度高于阈值）：用于联动整体 UI 外壳（侧边栏/标签栏/面板） */
export function isLightTheme(id: string): boolean {
  const t = getThemeById(id);
  if (!t) return false;
  const h = parseHex(t.theme.background ?? '#0e1116');
  if (!h) return false;
  return (0.299 * h.r + 0.587 * h.g + 0.114 * h.b) / 255 > 0.5;
}

/** 读取本地保存的主题 id（供 App 下拉框初始值使用） */
export function getSavedThemeId(): string {
  try {
    const id = localStorage.getItem(THEME_KEY);
    return id && TERM_THEMES.some((t) => t.id === id) ? id : TERM_THEMES[0].id;
  } catch {
    return TERM_THEMES[0].id;
  }
}

/** 读取本地保存的主题（供终端创建时使用） */
export function loadTermTheme(): TermThemeDef {
  return getThemeById(getSavedThemeId());
}

// ---------- 选区兑底色计算 ----------
// xterm 渲染选区时会把「带透明度的 selectionBackground 与 background 混合后的
// 不透明色」注入到 <style> 中。个别 WebView2 下注入失效时（与光标/字体同源），
// styles.css 的 :where() 兑底规则用 --term-selection-bg 变量兜底绘制选区，
// 该变量由 TerminalTab 在此函数的结果上设置，保证随主题切换同步。

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = hex.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function parseSelectionColor(
  s: string | undefined,
): { r: number; g: number; b: number; a: number } | null {
  if (!s) return null;
  const hex = parseHex(s);
  if (hex) return { ...hex, a: 1 };
  const m = s.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i,
  );
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] !== undefined ? +m[4] : 1 };
}

/** 计算选区兑底的不透明背景色（rgb() 字符串）。
 *  公式与 xterm 一致：逐通道 round(alpha * selection + (1-alpha) * background)。
 *  解析失败时回退为深蓝主题的混合色。 */
export function computeSelectionOpaque(theme: ITheme): string {
  const bg = parseHex(theme.background ?? '#0e1116');
  const sel = parseSelectionColor(theme.selectionBackground);
  if (!bg || !sel) return 'rgb(36, 59, 94)';
  const r = Math.round(sel.a * sel.r + (1 - sel.a) * bg.r);
  const g = Math.round(sel.a * sel.g + (1 - sel.a) * bg.g);
  const b = Math.round(sel.a * sel.b + (1 - sel.a) * bg.b);
  return `rgb(${r}, ${g}, ${b})`;
}

/** 选择主题：持久化并广播给所有终端 */
export function applyTermTheme(id: string): void {
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch {
    /* 存储失败时忽略 */
  }
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: id }));
}
