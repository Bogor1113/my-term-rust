import { Terminal } from 'xterm';
import 'xterm/css/xterm.css';

const term = new Terminal({
  cursorBlink: false,
  fontSize: 13,
  lineHeight: 1.15,
  fontFamily:
    '"Cascadia Code", Consolas, "JetBrains Mono", "Fira Code", Menlo, Monaco, monospace',
  theme: {
    background: '#0a0d12',
    foreground: '#d6dae2',
    cursor: '#5b9cff',
    cursorAccent: '#0a0d12',
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
  scrollback: 1000,
});
term.open(document.getElementById('t'));
term.write('\x1b[31mRED\x1b[0m \x1b[32mGREEN\x1b[0m \x1b[34mBLUE\x1b[0m \x1b[36mCYAN\x1b[0m\x1b[0m\r\n');
term.write('plain text line\r\n');

function report() {
  const r = document.createElement('pre');
  r.id = 'probe-result';
  const fg1 = document.querySelector('.xterm-fg-1');
  const fg2 = document.querySelector('.xterm-fg-2');
  const fg4 = document.querySelector('.xterm-fg-4');
  const fg6 = document.querySelector('.xterm-fg-6');
  const rows = document.querySelector('.xterm-rows');
  const vp = document.querySelector('.xterm-viewport');
  const styleEl = document.querySelector('.xterm-screen style');
  r.textContent = JSON.stringify(
    {
      fg1: fg1 ? getComputedStyle(fg1).color : 'MISSING',
      fg2: fg2 ? getComputedStyle(fg2).color : 'MISSING',
      fg4: fg4 ? getComputedStyle(fg4).color : 'MISSING',
      fg6: fg6 ? getComputedStyle(fg6).color : 'MISSING',
      rowsColor: rows ? getComputedStyle(rows).color : 'MISSING',
      viewportBg: vp ? getComputedStyle(vp).backgroundColor : 'MISSING',
      injectedStyle: styleEl ? styleEl.textContent.slice(0, 120) : 'MISSING',
    },
    null,
    1,
  );
  document.body.appendChild(r);
}
setTimeout(report, 1200);
window.__term = term;
