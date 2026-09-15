#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const readline = require('readline');

// ── 配置路径 ──────────────────────────────────────
let ROOT = null;

function getConfigPath() {
  return path.join(ROOT || process.cwd(), '.whale.json');
}
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
  } catch (e) {
    return {};
  }
}
function saveConfig(cfg) {
  try {
    fs.writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

// ── 全局状态 ──────────────────────────────────────
let config = {};
let PROVIDER = 'ollama';
let OLLAMA_URL = 'http://192.168.221.1:11434';
let MODEL = 'qwen2.5-coder:7b';
let THEME_NAME = 'claude';
let MODE = 'ask';
let PREVIEW_MODE = 'diff';
let LAST_FILE = null;
let ACTIVE_FILE = null;
const HISTORY = [];

const PROVIDERS = {
  ollama: {
    name: 'Ollama',
    defaultUrl: 'http://192.168.221.1:11434',
    port: 11434,
    apiType: 'ollama',
    hint: 'URL 末尾不带 /v1',
  },
  lmstudio: {
    name: 'LM Studio',
    defaultUrl: 'http://192.168.221.1:1234/v1',
    port: 1234,
    apiType: 'openai',
    hint: 'URL 末尾带 /v1',
  },
};

const MODES = {
  chat: '纯聊天，不生成代码，不碰文件',
  sec:  '只生成代码显示，绝不写入文件',
  ask:  '生成后预览，按 y 确认才写入',
  auto: '生成后直接写入，不确认',
  yolo: '自动写入 + 允许运行命令',
};

const PREVIEW_MODES = {
  diff: '只显示 diff（默认）',
  both: '显示 diff + 完整文件',
  off:  '不显示内容，直接确认',
};

const THEMES = {
  claude: {
    name: 'Claude', primary: '\x1b[38;5;173m', accent: '\x1b[38;5;180m',
    user: '\x1b[38;5;215m', assistant: '\x1b[38;5;252m', dim: '\x1b[38;5;245m',
    green: '\x1b[38;5;114m', red: '\x1b[38;5;174m', yellow: '\x1b[38;5;179m',
    line: '\x1b[38;5;240m', star: '✻', dot: '⏺', arrow: '>', bullet: '›',
  },
  ocean: {
    name: 'Ocean', primary: '\x1b[38;5;75m', accent: '\x1b[38;5;116m',
    user: '\x1b[38;5;117m', assistant: '\x1b[38;5;253m', dim: '\x1b[38;5;244m',
    green: '\x1b[38;5;120m', red: '\x1b[38;5;210m', yellow: '\x1b[38;5;222m',
    line: '\x1b[38;5;239m', star: '✦', dot: '●', arrow: '❯', bullet: '›',
  },
  matrix: {
    name: 'Matrix', primary: '\x1b[38;5;46m', accent: '\x1b[38;5;40m',
    user: '\x1b[38;5;82m', assistant: '\x1b[38;5;252m', dim: '\x1b[38;5;240m',
    green: '\x1b[38;5;46m', red: '\x1b[38;5;196m', yellow: '\x1b[38;5;226m',
    line: '\x1b[38;5;238m', star: '◈', dot: '▶', arrow: 'λ', bullet: '›',
  },
  sakura: {
    name: 'Sakura', primary: '\x1b[38;5;218m', accent: '\x1b[38;5;225m',
    user: '\x1b[38;5;219m', assistant: '\x1b[38;5;253m', dim: '\x1b[38;5;246m',
    green: '\x1b[38;5;157m', red: '\x1b[38;5;211m', yellow: '\x1b[38;5;223m',
    line: '\x1b[38;5;243m', star: '❀', dot: '◦', arrow: '›', bullet: '·',
  },
};

const C_RESET = '\x1b[0m';
const C_BOLD = '\x1b[1m';
let T = THEMES.claude;

const MENU = [
  { name: '模式', items: [
    { cmd: '/chat', desc: '纯聊天，不碰文件' },
    { cmd: '/sec',  desc: '只显示代码，绝不写入' },
    { cmd: '/ask',  desc: '预览后确认（默认）' },
    { cmd: '/auto', desc: '直接写入，不确认' },
    { cmd: '/yolo', desc: '自动写入 + 允许运行' },
  ]},
  { name: '文件', items: [
    { cmd: '/open',    desc: '锁定一个文件编辑' },
    { cmd: '/close',   desc: '退出文件编辑模式' },
    { cmd: '/pwd',     desc: '显示当前文件完整路径' },
    { cmd: '/preview', desc: '切换预览模式 (diff/both/off)' },
  ]},
  { name: '配置', items: [
    { cmd: '/conf',   desc: '查看/修改配置' },
    { cmd: '/models', desc: '列出并切换模型' },
    { cmd: '/theme',  desc: '切换主题' },
  ]},
  { name: '查看', items: [
    { cmd: '/files', desc: '列出当前目录文件' },
    { cmd: '/root',  desc: '显示工作目录' },
    { cmd: '/mode',  desc: '显示当前模式' },
    { cmd: '/test',  desc: '检测服务连接（5s 超时）' },
  ]},
  { name: '其他', items: [
    { cmd: '/clear', desc: '清空对话历史' },
    { cmd: '/help',  desc: '显示帮助' },
    { cmd: '/exit',  desc: '退出' },
  ]},
];

// ── 宽字符 ────────────────────────────────────────
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function displayWidth(str) {
  const s = str.replace(ANSI_RE, '');
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c >= 0x1100 && c <= 0x115F) || (c >= 0x2E80 && c <= 0x303E) ||
        (c >= 0x3041 && c <= 0x33FF) || (c >= 0x3400 && c <= 0x4DBF) ||
        (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0xA000 && c <= 0xA4CF) ||
        (c >= 0xAC00 && c <= 0xD7A3) || (c >= 0xF900 && c <= 0xFAFF) ||
        (c >= 0xFE30 && c <= 0xFE4F) || (c >= 0xFF00 && c <= 0xFF60) ||
        (c >= 0xFFE0 && c <= 0xFFE6) || (c >= 0x20000 && c <= 0x3FFFD)) w += 2;
    else w += 1;
  }
  return w;
}

// ── 打印 ──────────────────────────────────────────
const ok = (m) => console.log(`  ${T.green}${T.star}${C_RESET} ${m}`);
const err = (m) => console.log(`  ${T.red}✗${C_RESET} ${m}`);
const info = (m) => console.log(`  ${T.primary}${T.bullet}${C_RESET} ${T.dim}${m}${C_RESET}`);
const warn = (m) => console.log(`  ${T.yellow}!${C_RESET} ${m}`);
const dim = (m) => console.log(`  ${T.dim}${m}${C_RESET}`);

function hr() {
  const w = Math.min((process.stdout.columns || 80) - 4, 96);
  console.log(`  ${T.line}${'─'.repeat(w)}${C_RESET}`);
}
function banner() {
  const w = Math.min((process.stdout.columns || 80) - 4, 96);
  console.log();
  console.log(`  ${T.primary}${C_BOLD}${T.star}${C_RESET} ${C_BOLD}whale${C_RESET} ${T.dim}· 本地代码小助手${C_RESET}`);
  console.log();
  const p = PROVIDERS[PROVIDER] || PROVIDERS.ollama;
  console.log(`  ${T.dim}provider${C_RESET}  ${T.primary}${p.name}${C_RESET}`);
  console.log(`  ${T.dim}model${C_RESET}     ${T.user}${MODEL}${C_RESET}`);
  console.log(`  ${T.dim}url${C_RESET}       ${T.user}${OLLAMA_URL}${C_RESET}`);
  console.log(`  ${T.dim}cwd${C_RESET}       ${T.user}${relPath(ROOT)}${C_RESET}  ${T.dim}(locked)${C_RESET}`);
  if (ACTIVE_FILE) {
    console.log(`  ${T.dim}file${C_RESET}      ${T.primary}${C_BOLD}${ACTIVE_FILE}${C_RESET}`);
  }
  console.log(`  ${T.dim}mode${C_RESET}      ${T.primary}${MODE}${C_RESET}  ${T.dim}· ${MODES[MODE]}${C_RESET}`);
  console.log(`  ${T.dim}preview${C_RESET}   ${T.primary}${PREVIEW_MODE}${C_RESET}`);
  console.log(`  ${T.dim}theme${C_RESET}     ${T.primary}${T.name}${C_RESET}`);
  console.log();
  console.log(`  ${T.dim}输入 ${C_RESET}${T.primary}/${C_RESET}${T.dim} 弹菜单  ·  ${C_RESET}${T.primary}${T.star}${C_RESET}${T.dim} 直接说话  ·  ${C_RESET}${T.primary}/open${C_RESET}${T.dim} 锁定文件  ·  ${C_RESET}${T.primary}/models${C_RESET}${T.dim} 换模型${C_RESET}`);
  console.log();
  console.log(`  ${T.line}${'─'.repeat(w)}${C_RESET}`);
  console.log();
}
function boxed(content, color) {
  const w = Math.min((process.stdout.columns || 80) - 8, 92);
  const pad = 2, inner = w - pad * 2;
  const lines = [];
  for (const l of content.split('\n')) {
    if (displayWidth(l) <= inner) lines.push(l);
    else {
      let cur = '', curW = 0;
      for (const ch of l) {
        const cw = displayWidth(ch);
        if (curW + cw > inner) { lines.push(cur); cur = ch; curW = cw; }
        else { cur += ch; curW += cw; }
      }
      if (cur) lines.push(cur);
    }
  }
  console.log(`  ${T.line}╭${'─'.repeat(w - 2)}╮${C_RESET}`);
  for (const l of lines) {
    const fill = ' '.repeat(Math.max(0, inner - displayWidth(l)));
    console.log(`  ${T.line}│${C_RESET}${' '.repeat(pad)}${color}${l}${C_RESET}${fill}${' '.repeat(pad)}${T.line}│${C_RESET}`);
  }
  console.log(`  ${T.line}╰${'─'.repeat(w - 2)}╯${C_RESET}`);
}
function userLine(text) {
  console.log();
  console.log(`  ${T.user}${C_BOLD}${T.arrow}${C_RESET} ${T.user}${text}${C_RESET}`);
  console.log();
}
function assistantLine(text, color) {
  const lines = text.split('\n');
  console.log(`  ${T.primary}${T.dot}${C_RESET} ${color}${lines[0]}${C_RESET}`);
  for (let i = 1; i < lines.length; i++) console.log(`    ${color}${lines[i]}${C_RESET}`);
  console.log();
}

function confirm(prompt = '继续?') {
  return new Promise((resolve) => {
    process.stdout.write(`  ${T.primary}${T.star}${C_RESET} ${T.dim}${prompt}${C_RESET} ${T.user}[y/N]${C_RESET} `);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => {
      process.stdin.pause();
      resolve(['y', 'yes'].includes(d.trim().toLowerCase()));
    });
  });
}

// ── API 类型 ──────────────────────────────────────
function detectApiType(url) {
  const p = PROVIDERS[PROVIDER];
  if (p && p.apiType) return p.apiType;
  return /\/v1\/?$/.test(url) ? 'openai' : 'ollama';
}

// ── API 调用 ──────────────────────────────────────
function askOllama(messages, temperature = 0.1) {
  return new Promise((resolve, reject) => {
    const apiType = detectApiType(OLLAMA_URL);
    let url, body, parseResp;

    if (apiType === 'openai') {
      const base = OLLAMA_URL.replace(/\/+$/, '');
      url = new URL(base + '/chat/completions');
      body = JSON.stringify({ model: MODEL, messages, temperature, stream: false });
      parseResp = (p) => {
        if (p.error) throw new Error(p.error.message || JSON.stringify(p.error));
        return p.choices?.[0]?.message?.content ?? '';
      };
    } else {
      url = new URL('/api/chat', OLLAMA_URL);
      body = JSON.stringify({
        model: MODEL, messages, stream: false, options: { temperature },
      });
      parseResp = (p) => {
        if (p.error) throw new Error(p.error);
        return p.message.content;
      };
    }

    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 600000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          resolve(parseResp(p));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.write(body); req.end();
  });
}

const SYS_CODE = 'You are a Python code generator. Output ONLY code. No explanations. No markdown fences. The first character of your output must be the first character of the code.';
const SYS_CHAT = 'You are a concise coding assistant. Reply in the same language as the user. Be brief.';
const genCode = (p) => askOllama([{ role: 'system', content: SYS_CODE }, { role: 'user', content: p }]);
const chatLLM = (m) => askOllama([{ role: 'system', content: SYS_CHAT }, ...m], 0.6);

// ── 连接检测 ──────────────────────────────────────
function checkConnection(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const apiType = detectApiType(OLLAMA_URL);
    let url;
    try {
      if (apiType === 'openai') {
        const base = OLLAMA_URL.replace(/\/+$/, '');
        url = new URL(base + '/models');
      } else {
        url = new URL('/api/tags', OLLAMA_URL);
      }
    } catch (e) { return resolve({ ok: false, error: 'URL 无效: ' + OLLAMA_URL }); }

    const mod = url.protocol === 'https:' ? https : http;
    const t0 = Date.now();
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname, method: 'GET', timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        const elapsed = Date.now() - t0;
        try {
          const p = JSON.parse(data);
          let models;
          if (apiType === 'openai') {
            models = (p.data || []).map((m) => m.id);
          } else {
            models = (p.models || []).map((m) => m.name);
          }
          const hasModel = models.some((n) =>
            n === MODEL || n === MODEL + ':latest' || n.startsWith(MODEL + ':')
          );
          resolve({ ok: true, models, hasModel, elapsed, apiType });
        } catch (e) {
          resolve({ ok: false, error: '响应不是有效 JSON', elapsed });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message, elapsed: Date.now() - t0 }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: `连接超时（${timeoutMs / 1000}s）`, elapsed: Date.now() - t0 });
    });
    req.end();
  });
}

// ── /test ─────────────────────────────────────────
async function doTest() {
  console.log();
  process.stdout.write(`  ${T.primary}${T.star}${C_RESET} ${T.dim}检测中…${C_RESET}`);
  const r = await checkConnection(5000);
  process.stdout.write('\r' + ' '.repeat(40) + '\r');

  const p = PROVIDERS[PROVIDER] || PROVIDERS.ollama;
  const apiLabel = r.apiType === 'openai' ? 'OpenAI 兼容' : 'Ollama 原生';
  console.log(`  ${T.dim}provider${C_RESET}  ${T.primary}${p.name}${C_RESET}`);
  console.log(`  ${T.dim}URL${C_RESET}       ${T.user}${OLLAMA_URL}${C_RESET}`);
  console.log(`  ${T.dim}接口${C_RESET}      ${T.user}${apiLabel}${C_RESET}`);
  console.log(`  ${T.dim}模型${C_RESET}      ${T.user}${MODEL}${C_RESET}`);
  console.log(`  ${T.dim}耗时${C_RESET}      ${r.elapsed}ms`);
  console.log();

  if (r.ok && r.hasModel) {
    console.log(`  ${T.green}${T.star}${C_RESET} ${C_BOLD}连接正常${C_RESET}  ·  ${T.dim}模型就绪${C_RESET}`);
    console.log();
    console.log(`  ${T.dim}换模型:${C_RESET} ${T.primary}/models${C_RESET}`);
    console.log();
    return;
  }
  if (r.ok && !r.hasModel) {
    console.log(`  ${T.yellow}!${C_RESET} ${C_BOLD}服务已连接，但目标模型不在列表中${C_RESET}`);
    console.log();
    if (r.models.length > 0) {
      console.log(`  ${T.dim}可用模型 ${r.models.length} 个，跑 ${T.primary}/models${C_RESET}${T.dim} 选择${C_RESET}`);
    } else {
      console.log(`  ${T.dim}还没有加载任何模型${C_RESET}`);
    }
    console.log();
    return;
  }

  console.log(`  ${T.red}✗${C_RESET} ${C_BOLD}无法连接${C_RESET}`);
  console.log(`  ${T.dim}原因:${C_RESET} ${r.error}`);
  console.log();
  console.log(`  ${C_BOLD}${T.primary}排查${C_RESET}`);
  console.log();
  console.log(`  ${T.primary}1.${C_RESET} 服务是否在运行？`);
  console.log();
  console.log(`  ${T.primary}2.${C_RESET} URL 格式对不对？`);
  console.log(`     ${T.dim}Ollama:${C_RESET}     ${T.accent}http://<主机>:11434${C_RESET} ${T.dim}(末尾不带 /v1)${C_RESET}`);
  console.log(`     ${T.dim}LM Studio:${C_RESET}  ${T.accent}http://<主机>:1234/v1${C_RESET} ${T.dim}(末尾带 /v1)${C_RESET}`);
  console.log();
  console.log(`  ${T.primary}3.${C_RESET} 是否监听 ${T.accent}0.0.0.0${C_RESET}？`);
  console.log(`     ${T.dim}Ollama (Win):${C_RESET} ${T.accent}$env:OLLAMA_HOST="0.0.0.0:11434"; ollama serve${C_RESET}`);
  console.log(`     ${T.dim}LM Studio:${C_RESET} ${T.accent}Developer -> Server -> Serve on Local Network${C_RESET}`);
  console.log();
  console.log(`  ${T.primary}4.${C_RESET} 防火墙放行端口 ${T.accent}${p.port}${C_RESET}`);
  console.log();
  console.log(`  ${T.primary}5.${C_RESET} 手动验证:`);
  if (r.apiType === 'openai') {
    console.log(`     ${T.accent}curl ${OLLAMA_URL}/models${C_RESET}`);
  } else {
    console.log(`     ${T.accent}curl ${OLLAMA_URL}/api/tags${C_RESET}`);
  }
  console.log();
  console.log(`  ${T.dim}切换 provider:${C_RESET} ${T.primary}/conf provider ollama${C_RESET}  ${T.dim}或${C_RESET}  ${T.primary}/conf provider lmstudio${C_RESET}`);
  console.log();
}

// ── 通用选择器 ────────────────────────────────────
function pickItem(items, currentIdx, title) {
  return new Promise((resolve) => {
    let sel = currentIdx >= 0 ? currentIdx : 0;
    let numBuf = '';
    let numTimer = null;
    let lastRenderLines = 0;

    function cleanup() {
      if (numTimer) clearTimeout(numTimer);
      process.stdin.removeListener('keypress', onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }

    function render() {
      const innerW = Math.max(48, Math.min((process.stdout.columns || 80) - 10, 80));
      const maxLen = Math.max(...items.map((m) => displayWidth(m)));
      let out = '';
      if (lastRenderLines > 0) out += `\x1b[${lastRenderLines}A`;
      out += '\r\x1b[0J';

      const t = ' ' + title + ' ';
      const titlePad = ' '.repeat(Math.max(0, innerW - displayWidth(t)));
      out += '\n  ' + T.line + '╭' + '─'.repeat(innerW) + '╮' + C_RESET;
      out += '\n  ' + T.line + '│' + C_RESET + T.primary + C_BOLD + t + C_RESET + titlePad + T.line + '│' + C_RESET;
      out += '\n  ' + T.line + '├' + '─'.repeat(innerW) + '┤' + C_RESET;

      for (let i = 0; i < items.length; i++) {
        const m = items[i];
        const isSel = i === sel;
        const num = String(i + 1).padStart(2, ' ');
        const pad = ' '.repeat(Math.max(0, maxLen - displayWidth(m)));
        let row;
        if (isSel) {
          row = `${T.primary}${T.dot}${C_RESET} ${T.dim}${num}${C_RESET}  ${C_BOLD}${T.primary}${m}${C_RESET}${pad}`;
        } else {
          row = `  ${T.dim}${num}${C_RESET}  ${T.user}${m}${C_RESET}${pad}`;
        }
        const w = displayWidth(row);
        const rightPad = ' '.repeat(Math.max(0, innerW - w - 1));
        out += '\n  ' + T.line + '│' + C_RESET + ' ' + row + rightPad + T.line + '│' + C_RESET;
      }

      out += '\n  ' + T.line + '╰' + '─'.repeat(innerW) + '╯' + C_RESET;
      const hint = numBuf
        ? `↑↓ 选择  Enter 确认  Esc 取消  ${T.primary}输入: ${numBuf}${C_RESET}`
        : `↑↓ 选择  Enter 确认  Esc 取消`;
      out += `\n  ${T.dim}${hint}${C_RESET}`;

      lastRenderLines = items.length + 5;
      process.stdout.write(out);
    }

    function finish(result) {
      let out = '';
      if (lastRenderLines > 0) out += `\x1b[${lastRenderLines}A`;
      out += '\r\x1b[0J';
      process.stdout.write(out);
      cleanup();
      resolve(result);
    }

    function onKey(str, key) {
      if (key.ctrl && key.name === 'c') return finish(null);
      if (key.name === 'escape') return finish(null);

      if (key.name === 'return' || key.name === 'enter') {
        if (numBuf) {
          const n = parseInt(numBuf, 10);
          if (n >= 1 && n <= items.length) return finish(items[n - 1]);
        }
        return finish(items[sel]);
      }

      if (key.name === 'up') {
        sel = (sel - 1 + items.length) % items.length;
        numBuf = '';
        render();
        return;
      }
      if (key.name === 'down') {
        sel = (sel + 1) % items.length;
        numBuf = '';
        render();
        return;
      }

      if (str && /^[0-9]$/.test(str)) {
        numBuf += str;
        const n = parseInt(numBuf, 10);
        if (n >= 1 && n <= items.length) {
          sel = n - 1;
        } else {
          numBuf = str;
          const n2 = parseInt(numBuf, 10);
          if (n2 >= 1 && n2 <= items.length) sel = n2 - 1;
        }
        if (numTimer) clearTimeout(numTimer);
        numTimer = setTimeout(() => { numBuf = ''; render(); }, 1500);
        render();
        return;
      }
    }

    readline.emitKeypressEvents(process.stdin);
    process.stdin.resume();
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', onKey);
    render();
  });
}

// ── /models ───────────────────────────────────────
async function doModels() {
  console.log();
  process.stdout.write(`  ${T.primary}${T.star}${C_RESET} ${T.dim}获取模型列表…${C_RESET}`);
  const r = await checkConnection(5000);
  process.stdout.write('\r' + ' '.repeat(40) + '\r');

  if (!r.ok) {
    err('无法连接');
    dim('先跑 /test 排查');
    console.log();
    return;
  }

  if (r.models.length === 0) {
    warn('没有可用模型');
    if (PROVIDER === 'ollama') {
      dim(`下载: ollama pull ${MODEL}`);
    } else {
      dim('LM Studio 里加载一个模型再试');
    }
    console.log();
    return;
  }

  const currentIdx = r.models.findIndex((m) =>
    m === MODEL || m.startsWith(MODEL + ':') || m === MODEL + ':latest'
  );

  const picked = await pickItem(r.models, currentIdx, '可用模型');
  if (!picked) { dim('取消'); console.log(); return; }

  if (picked === MODEL || picked.startsWith(MODEL + ':')) {
    dim(`已经是 ${picked}`);
    console.log();
    return;
  }

  MODEL = picked;
  persistConfig();
  ok(`model → ${MODEL}`);
  console.log();
}

// ── 文件编辑模式 ──────────────────────────────────
async function doOpenFile(args) {
  console.log();
  let target = args.join(' ').trim();

  if (!target) {
    const entries = fs.readdirSync(ROOT).sort().filter((e) => {
      if (e.startsWith('.')) return false;
      try { return fs.statSync(path.join(ROOT, e)).isFile(); } catch (e) { return false; }
    });
    if (entries.length === 0) {
      err('当前目录没有文件');
      console.log();
      return;
    }
    const picked = await pickItem(entries, -1, '选择文件');
    if (!picked) { dim('取消'); console.log(); return; }
    ACTIVE_FILE = picked;
    const full = path.join(ROOT, picked);
    ok(`已锁定 ${picked}`);
    dim(`完整路径: ${full}`);
    console.log();
    banner();
    return;
  }

  const full = safePath(target);
  if (!full) { err(`路径越界: ${target}`); console.log(); return; }
  if (!fs.existsSync(full)) {
    err(`文件不存在: ${relPath(full)}`);
    dim('可以先用其他编辑器创建，或直接说话让它生成');
    console.log();
    return;
  }
  if (fs.statSync(full).isDirectory()) {
    err(`${relPath(full)} 是目录，不是文件`);
    console.log();
    return;
  }

  ACTIVE_FILE = relPath(full);
  ok(`已锁定 ${ACTIVE_FILE}`);
  dim(`完整路径: ${full}`);
  console.log();
  banner();
}

function doCloseFile() {
  console.log();
  if (!ACTIVE_FILE) {
    dim('当前没有锁定文件');
    console.log();
    return;
  }
  const f = ACTIVE_FILE;
  ACTIVE_FILE = null;
  ok(`已退出 ${f}`);
  console.log();
  banner();
}

function doPwd() {
  console.log();
  if (ACTIVE_FILE) {
    const full = path.isAbsolute(ACTIVE_FILE)
      ? ACTIVE_FILE
      : path.join(ROOT, ACTIVE_FILE);
    console.log(`  ${T.user}${full}${C_RESET}`);
    if (!fs.existsSync(full)) dim('（文件尚不存在）');
  } else {
    console.log(`  ${T.user}${ROOT}${C_RESET}`);
    dim('当前未锁定文件，/open <文件> 可锁定一个');
  }
  console.log();
}

function doPreview(args) {
  console.log();
  if (args.length === 0) {
    console.log(`  ${T.primary}${T.star}${C_RESET} ${C_BOLD}预览模式${C_RESET}  ${T.user}${PREVIEW_MODE}${C_RESET}`);
    dim(PREVIEW_MODES[PREVIEW_MODE] || '?');
    console.log();
    for (const k of Object.keys(PREVIEW_MODES)) {
      const mark = k === PREVIEW_MODE ? `${T.primary}●${C_RESET}` : ' ';
      console.log(`    ${mark} ${T.accent}${k}${C_RESET}  ${T.dim}${PREVIEW_MODES[k]}${C_RESET}`);
    }
    console.log();
    return;
  }
  const m = args[0];
  if (!PREVIEW_MODES[m]) {
    err(`未知模式: ${m}`);
    dim(`可选: ${Object.keys(PREVIEW_MODES).join('  ')}`);
    console.log();
    return;
  }
  PREVIEW_MODE = m;
  persistConfig();
  ok(`preview → ${m}`);
  dim(PREVIEW_MODES[m]);
  console.log();
}

function persistConfig() {
  config.provider = PROVIDER;
  config.ollama_url = OLLAMA_URL;
  config.model = MODEL;
  config.theme = THEME_NAME;
  config.mode = MODE;
  config.preview = PREVIEW_MODE;
  return saveConfig(config);
}

function switchProvider(name) {
  const p = PROVIDERS[name];
  PROVIDER = name;
  OLLAMA_URL = p.defaultUrl;
}

function doConf(args) {
  console.log();
  if (args.length === 0) {
    const p = PROVIDERS[PROVIDER] || PROVIDERS.ollama;
    console.log(`  ${C_BOLD}${T.primary}当前配置${C_RESET}`);
    console.log();
    console.log(`  ${T.dim}provider${C_RESET}  ${T.primary}${p.name}${C_RESET}`);
    console.log(`  ${T.dim}model${C_RESET}     ${T.user}${MODEL}${C_RESET}`);
    console.log(`  ${T.dim}url${C_RESET}       ${T.user}${OLLAMA_URL}${C_RESET}`);
    console.log(`  ${T.dim}theme${C_RESET}     ${T.primary}${T.name}${C_RESET}`);
    console.log(`  ${T.dim}mode${C_RESET}      ${T.primary}${MODE}${C_RESET}`);
    console.log(`  ${T.dim}preview${C_RESET}   ${T.primary}${PREVIEW_MODE}${C_RESET}`);
    console.log(`  ${T.dim}root${C_RESET}      ${T.user}${relPath(ROOT)}${C_RESET}`);
    if (ACTIVE_FILE) console.log(`  ${T.dim}file${C_RESET}      ${T.primary}${ACTIVE_FILE}${C_RESET}`);
    console.log();
    console.log(`  ${T.dim}配置文件${C_RESET}  ${T.accent}${getConfigPath()}${C_RESET}`);
    console.log();
    console.log(`  ${C_BOLD}${T.primary}修改${C_RESET}`);
    console.log(`    ${T.accent}/conf provider${C_RESET} ${T.dim}<ollama|lmstudio>${C_RESET}   ${T.dim}切换服务${C_RESET}`);
    console.log(`    ${T.accent}/conf model${C_RESET}    ${T.dim}<名称>${C_RESET}           ${T.dim}切换模型${C_RESET}`);
    console.log(`    ${T.accent}/conf url${C_RESET}      ${T.dim}<地址>${C_RESET}           ${T.dim}自定义地址${C_RESET}`);
    console.log(`    ${T.accent}/conf theme${C_RESET}    ${T.dim}<名称>${C_RESET}           ${T.dim}主题${C_RESET}`);
    console.log(`    ${T.accent}/conf mode${C_RESET}     ${T.dim}<名称>${C_RESET}           ${T.dim}默认模式${C_RESET}`);
    console.log(`    ${T.accent}/conf reset${C_RESET}                      ${T.dim}恢复默认${C_RESET}`);
    console.log();
    return;
  }

  const sub = args[0];
  const val = args.slice(1).join(' ');

  if (sub === 'provider') {
    if (!val) {
      err('用法: /conf provider <ollama|lmstudio>');
      dim(`当前: ${PROVIDER}`);
      console.log();
      return;
    }
    if (!PROVIDERS[val]) {
      err(`未知 provider: ${val}`);
      dim(`可选: ${Object.keys(PROVIDERS).join('  ')}`);
      console.log();
      return;
    }
    switchProvider(val);
    persistConfig();
    const p = PROVIDERS[val];
    ok(`provider → ${p.name}`);
    dim(`默认 URL 已设为 ${p.defaultUrl}`);
    console.log();
    banner();
    return;
  }

  if (sub === 'model') {
    if (!val) { err('用法: /conf model <名称>'); dim(`当前: ${MODEL}`); console.log(); return; }
    MODEL = val;
    if (persistConfig()) { ok(`model → ${MODEL}`); dim('已保存到配置文件'); }
    else warn(`model → ${MODEL}（内存已改，但配置文件保存失败）`);
    console.log();
    return;
  }
  if (sub === 'url') {
    if (!val) { err('用法: /conf url <地址>'); dim(`当前: ${OLLAMA_URL}`); console.log(); return; }
    if (!/^https?:\/\//.test(val)) { err('URL 必须以 http:// 或 https:// 开头'); console.log(); return; }
    OLLAMA_URL = val;
    if (/\/v1\/?$/.test(val)) PROVIDER = 'lmstudio';
    else PROVIDER = 'ollama';
    if (persistConfig()) {
      ok(`url → ${OLLAMA_URL}`);
      dim(`provider 自动识别为 ${PROVIDERS[PROVIDER].name}`);
    } else {
      warn(`url → ${OLLAMA_URL}（内存已改，但配置文件保存失败）`);
    }
    console.log();
    return;
  }
  if (sub === 'theme') {
    if (!val) { err('用法: /conf theme <名称>'); dim(`可选: ${Object.keys(THEMES).join('  ')}`); console.log(); return; }
    if (!THEMES[val]) { err(`未知主题: ${val}`); dim(`可选: ${Object.keys(THEMES).join('  ')}`); console.log(); return; }
    THEME_NAME = val;
    T = THEMES[val];
    persistConfig();
    ok(`theme → ${val}`);
    console.log();
    banner();
    return;
  }
  if (sub === 'mode') {
    if (!val) { err('用法: /conf mode <名称>'); dim(`可选: ${Object.keys(MODES).join('  ')}`); console.log(); return; }
    if (!MODES[val]) { err(`未知模式: ${val}`); console.log(); return; }
    MODE = val;
    persistConfig();
    ok(`mode → ${val}`);
    dim(MODES[val]);
    console.log();
    return;
  }
  if (sub === 'reset') {
    config = {};
    saveConfig(config);
    PROVIDER = 'ollama';
    OLLAMA_URL = PROVIDERS.ollama.defaultUrl;
    MODEL = 'qwen2.5-coder:7b';
    THEME_NAME = 'claude';
    T = THEMES.claude;
    MODE = 'ask';
    PREVIEW_MODE = 'diff';
    ok('已恢复默认配置');
    console.log();
    return;
  }
  err(`未知子命令: ${sub}`);
  dim('试试 /conf 查看用法');
  console.log();
}

function clean(t) {
  if (!t) return '';
  return t.trim().replace(/^```[a-zA-Z0-9]*\s*\n/, '').replace(/\n```\s*$/, '').trim();
}

// ── 行级 diff ─────────────────────────────────────
function simpleDiff(oldText, newText) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length, m = b.length;

  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'eq', line: a[i], aIdx: i + 1, bIdx: j + 1 });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', line: a[i], aIdx: i + 1 });
      i++;
    } else {
      ops.push({ type: 'add', line: b[j], bIdx: j + 1 });
      j++;
    }
  }
  while (i < n) { ops.push({ type: 'del', line: a[i], aIdx: i + 1 }); i++; }
  while (j < m) { ops.push({ type: 'add', line: b[j], bIdx: j + 1 }); j++; }
  return ops;
}

function renderDiff(oldText, newText, pathLabel) {
  const ops = simpleDiff(oldText, newText);
  const changed = ops.map((op) => op.type !== 'eq');
  if (!changed.some(Boolean)) {
    dim('无变化');
    return { added: 0, deleted: 0 };
  }

  const CONTEXT = 3;
  const show = new Array(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (changed[i]) {
      for (let k = Math.max(0, i - CONTEXT); k <= Math.min(ops.length - 1, i + CONTEXT); k++) {
        show[k] = true;
      }
    }
  }

  const added = ops.filter((o) => o.type === 'add').length;
  const deleted = ops.filter((o) => o.type === 'del').length;

  const w = Math.min((process.stdout.columns || 80) - 8, 100);
  const header = `diff ${pathLabel} +${added} -${deleted}`;
  const headerPad = ' '.repeat(Math.max(0, w - displayWidth(header) - 6));
  console.log(`  ${T.line}╭─ ${C_RESET}${T.primary}${C_BOLD}diff${C_RESET} ${T.dim}${pathLabel}${C_RESET} ${T.green}+${added}${C_RESET} ${T.red}-${deleted}${C_RESET} ${T.line}${'─'.repeat(Math.max(0, w - displayWidth(header) - 4))}╮${C_RESET}`);

  const lineW = w - 12;
  let prevShown = false;
  for (let i = 0; i < ops.length; i++) {
    if (!show[i]) {
      if (prevShown) {
        const pad = ' '.repeat(Math.max(0, w - 6));
        console.log(`  ${T.line}│${C_RESET}  ${T.dim}⋯${C_RESET}${pad}${T.line}│${C_RESET}`);
      }
      prevShown = false;
      continue;
    }
    prevShown = true;

    const op = ops[i];
    let marker, lineColor, num;
    if (op.type === 'eq') {
      marker = ' ';
      lineColor = T.dim;
      num = String(op.bIdx).padStart(4, ' ');
    } else if (op.type === 'add') {
      marker = `${T.green}+${C_RESET}`;
      lineColor = T.green;
      num = String(op.bIdx).padStart(4, ' ');
    } else {
      marker = `${T.red}-${C_RESET}`;
      lineColor = T.red;
      num = String(op.aIdx).padStart(4, ' ');
    }

    const raw = op.line === '' ? ' ' : op.line;
    const display = raw.length > lineW ? raw.slice(0, lineW - 1) + '…' : raw;
    const pad = ' '.repeat(Math.max(0, w - 6 - displayWidth(display) - 6));
    console.log(`  ${T.line}│${C_RESET} ${marker} ${T.dim}${num}${C_RESET} ${lineColor}${display}${C_RESET}${pad}${T.line}│${C_RESET}`);
  }

  console.log(`  ${T.line}╰${'─'.repeat(w - 2)}╯${C_RESET}`);
  return { added, deleted };
}

// ── 路径 ──────────────────────────────────────────
function safePath(p) {
  if (!p) return null;
  const full = path.isAbsolute(p) ? path.normalize(p) : path.resolve(ROOT, p);
  const rel = path.relative(ROOT, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}
function relPath(full) {
  if (full === ROOT) return '.';
  try { return path.relative(ROOT, full); } catch (e) { return full; }
}
function backup(fp) {
  if (fs.existsSync(fp)) {
    const b = `${fp}.bak.${Math.floor(Date.now() / 1000)}`;
    fs.copyFileSync(fp, b);
    dim(`备份 → ${relPath(b)}`);
  }
}

// ── 意图识别 ──────────────────────────────────────
function extractFile(text) {
  let m = text.match(/([\w\-/]+\.(py|txt|json|md|yaml|yml|toml|cfg|ini|js|ts|go|rs|java))/);
  if (m) return m[1];
  m = text.match(/(?:写入到|写到|存到|保存到)\s*([\w\-/]+\.[a-z]+)/);
  if (m) return m[1];
  return null;
}
function detectIntent(text) {
  const fname = extractFile(text);
  const isRun = /(跑一下|运行|执行一下|\brun\b)/.test(text);
  const isEdit = /(改|修|优化|调整|重构|替换|重写|排.*版|格式|整理|美化|清理|格式化)/.test(text);
  const isRead = /(看一下|看下|读一下|读下|打开|查看|显示|看看)/.test(text);
  const isWrite = /(写一个|写个|写一下|创建|新建|生成|帮我写|加一个|加个|添加|追加|再来|写入)/.test(text);
  const isLs = /(列出|列表|有哪些文件|\bls\b)/.test(text);
  if (fname) {
    if (isRun) return 'run';
    if (isEdit) return 'edit';
    if (isRead) return 'read';
    if (isWrite) return 'write';
    return 'read';
  }
  const anchor = ACTIVE_FILE || LAST_FILE;
  if (anchor) {
    if (isEdit) return 'edit';
    if (isRun) return 'run';
    if (isRead) return 'read';
    if (isWrite) return 'write';
  }
  if (isLs) return 'ls';
  if (isRun) return 'run';
  if (isWrite) return 'write';
  if (isEdit) return 'edit';
  if (isRead) return 'read';
  return 'chat';
}
const wantsOverwrite = (t) => /(覆盖|重写|替换整个)/.test(t);

// ── 动作 ──────────────────────────────────────────
async function doChat(text) {
  userLine(text);
  HISTORY.push({ role: 'user', content: text });
  process.stdout.write(`  ${T.primary}${T.star}${C_RESET} ${T.dim}thinking…${C_RESET}`);
  const t0 = Date.now();
  let reply;
  try { reply = await chatLLM(HISTORY); }
  catch (e) {
    process.stdout.write('\r' + ' '.repeat(30) + '\r');
    err(`请求失败: ${e.message}`);
    dim('试试 /test 检测连接，或 /conf 改配置');
    HISTORY.pop(); return;
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write('\r' + ' '.repeat(30) + '\r');
  if (!reply) { HISTORY.pop(); return; }
  HISTORY.push({ role: 'assistant', content: reply });
  assistantLine(reply, T.assistant);
  console.log(`  ${T.dim}${dt}s${C_RESET}`);
  console.log();
}
function doLs(_) {
  const entries = fs.readdirSync(ROOT).sort();
  if (entries.length === 0) { dim('(空)'); return; }
  const files = [], dirs = [];
  for (const e of entries) {
    if (e.startsWith('.')) continue;
    const full = path.join(ROOT, e);
    if (fs.statSync(full).isDirectory()) dirs.push(e);
    else files.push(e);
  }
  console.log();
  for (const d of dirs) console.log(`  ${T.primary}${T.bullet}${C_RESET} ${T.user}${d}/${C_RESET}`);
  for (const f of files) {
    const isActive = f === ACTIVE_FILE;
    const mark = isActive ? `${T.primary}●${C_RESET}` : `${T.dim}${T.bullet}${C_RESET}`;
    console.log(`  ${mark} ${isActive ? T.primary + C_BOLD : ''}${f}${C_RESET}${isActive ? `  ${T.dim}(锁定)${C_RESET}` : ''}`);
  }
  console.log();
}
function doRead(text) {
  const p = extractFile(text) || ACTIVE_FILE || LAST_FILE;
  if (!p) { err('看哪个文件？'); return; }
  const full = safePath(p);
  if (!full) { err(`路径越界: ${p}`); return; }
  if (!fs.existsSync(full)) { err(`不存在: ${relPath(full)}`); return; }
  const content = fs.readFileSync(full, 'utf8');
  console.log();
  boxed(content, T.assistant);
  dim(`${relPath(full)} · ${content.length} 字符 · ${content.split('\n').length} 行`);
  console.log();
  LAST_FILE = relPath(full);
}
async function doRun(text) {
  if (MODE !== 'yolo') { warn(`运行需要 yolo 模式（当前: ${MODE}）。用 /yolo 切换。`); return; }
  const p = extractFile(text) || ACTIVE_FILE || LAST_FILE;
  if (!p) { err('跑哪个文件？'); return; }
  const full = safePath(p);
  if (!full) { err(`路径越界: ${p}`); return; }
  if (!fs.existsSync(full)) { err(`不存在: ${relPath(full)}`); return; }
  info(`python3 ${relPath(full)}`);
  hr();
  await new Promise((resolve) => {
    const child = spawn('python3', [relPath(full)], { cwd: ROOT, stdio: 'inherit' });
    child.on('close', () => resolve());
    child.on('error', (e) => { err(`启动失败: ${e.message}`); resolve(); });
  });
  hr();
  LAST_FILE = relPath(full);
}
async function doWrite(text, action) {
  let p = extractFile(text) || ACTIVE_FILE || LAST_FILE;
  if (!p) {
    p = (await readLine(`  ${T.primary}${T.star}${C_RESET} ${T.dim}写到哪个文件？${C_RESET} `, null)).trim();
    if (!p) { dim('取消'); return; }
    if (!p.includes('.')) p += '.py';
  }
  const full = safePath(p);
  if (!full) { err(`路径越界: ${p}`); return; }
  const exists = fs.existsSync(full);
  if (action === 'new' && exists) action = wantsOverwrite(text) ? 'overwrite' : 'append';
  if (action === 'edit' && !exists) { err(`文件不存在: ${relPath(full)}`); return; }

  let prompt;
  if (action === 'edit') {
    const old = fs.readFileSync(full, 'utf8');
    prompt = `以下是 ${relPath(full)} 的现有代码:\n\n${old}\n\n用户要求: ${text}\n\n输出修改后的完整代码。保留所有未被要求修改的部分。不要解释，不要 markdown。`;
    console.log();
    info(`改 ${relPath(full)}…`);
  } else {
    console.log();
    info(`${action === 'append' ? '追加到' : '新建'} ${relPath(full)}…`);
    prompt = text;
  }
  process.stdout.write(`  ${T.primary}${T.star}${C_RESET} ${T.dim}生成中…${C_RESET}`);
  const t0 = Date.now();
  let newCode;
  try { newCode = clean(await genCode(prompt)); }
  catch (e) {
    process.stdout.write('\r' + ' '.repeat(30) + '\r');
    err(`请求失败: ${e.message}`);
    dim('试试 /test 检测连接，或 /conf 改配置');
    return;
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write('\r' + ' '.repeat(30) + '\r');
  if (!newCode) { err('模型没返回'); return; }

  let final;
  if (action === 'append' && exists) {
    const old = fs.readFileSync(full, 'utf8');
    final = old.replace(/\s*$/, '') + '\n\n' + newCode + '\n';
  } else final = newCode + '\n';

  console.log();
  dim(`${dt}s · ${newCode.length} 字符`);
  console.log();

  if (action === 'edit' && exists) {
    const old = fs.readFileSync(full, 'utf8');

    if (PREVIEW_MODE === 'off') {
      dim(`预览已关闭，${relPath(full)} 即将被覆盖`);
      console.log();
    } else {
      const { added, deleted } = renderDiff(old, final, relPath(full));
      if (added === 0 && deleted === 0) {
        dim('模型返回内容与原文一致，无改动');
        console.log();
        return;
      }
      if (PREVIEW_MODE === 'both') {
        console.log();
        boxed(newCode, T.assistant);
        console.log();
      }
    }
  } else {
    if (PREVIEW_MODE !== 'off') {
      boxed(newCode, T.assistant);
      console.log();
    } else {
      dim(`预览已关闭，${relPath(full)} 即将被写入`);
      console.log();
    }
  }

  if (MODE === 'sec') { warn('sec 模式：仅显示，不写入'); LAST_FILE = relPath(full); return; }
  if (MODE === 'ask') {
    const verb = { new: '写入', append: '追加到', overwrite: '覆盖', edit: '更新' }[action];
    if (!(await confirm(`${verb} ${relPath(full)}?`))) { dim('取消'); return; }
  }
  backup(full);
  fs.writeFileSync(full, final, 'utf8');
  const verb = { new: '写入', append: '追加到', overwrite: '覆盖', edit: '更新' }[action];
  ok(`已${verb} ${relPath(full)}`);
  LAST_FILE = relPath(full);
}

// ── 参数候选 ──────────────────────────────────────
function getArgCandidates(buf) {
  let m = buf.match(/^\/theme\s+(\S*)$/);
  if (m) {
    const prefix = m[1];
    const items = Object.keys(THEMES)
      .filter((n) => n.startsWith(prefix))
      .map((n) => ({ cmd: n, desc: THEMES[n].name, isArg: true }));
    return { items, prefix };
  }
  m = buf.match(/^\/mode\s+(\S*)$/);
  if (m) {
    const prefix = m[1];
    const items = Object.keys(MODES)
      .filter((n) => n.startsWith(prefix))
      .map((n) => ({ cmd: n, desc: MODES[n], isArg: true }));
    return { items, prefix };
  }
  m = buf.match(/^\/preview\s+(\S*)$/);
  if (m) {
    const prefix = m[1];
    const items = Object.keys(PREVIEW_MODES)
      .filter((n) => n.startsWith(prefix))
      .map((n) => ({ cmd: n, desc: PREVIEW_MODES[n], isArg: true }));
    return { items, prefix };
  }
  m = buf.match(/^\/conf\s+theme\s+(\S*)$/);
  if (m) {
    const prefix = m[1];
    const items = Object.keys(THEMES)
      .filter((n) => n.startsWith(prefix))
      .map((n) => ({ cmd: n, desc: THEMES[n].name, isArg: true }));
    return { items, prefix };
  }
  m = buf.match(/^\/conf\s+mode\s+(\S*)$/);
  if (m) {
    const prefix = m[1];
    const items = Object.keys(MODES)
      .filter((n) => n.startsWith(prefix))
      .map((n) => ({ cmd: n, desc: MODES[n], isArg: true }));
    return { items, prefix };
  }
  m = buf.match(/^\/conf\s+provider\s+(\S*)$/);
  if (m) {
    const prefix = m[1];
    const items = Object.keys(PROVIDERS)
      .filter((n) => n.startsWith(prefix))
      .map((n) => ({ cmd: n, desc: PROVIDERS[n].name + ' · ' + PROVIDERS[n].hint, isArg: true }));
    return { items, prefix };
  }
  m = buf.match(/^\/conf\s+(\S*)$/);
  if (m) {
    const prefix = m[1];
    const subs = [
      { cmd: 'provider', desc: 'Ollama 或 LM Studio' },
      { cmd: 'model',    desc: '切换模型' },
      { cmd: 'url',      desc: '自定义地址' },
      { cmd: 'theme',    desc: '切换主题' },
      { cmd: 'mode',     desc: '默认模式' },
      { cmd: 'reset',    desc: '恢复默认' },
    ];
    const items = subs.filter((s) => s.cmd.startsWith(prefix))
      .map((s) => ({ cmd: s.cmd, desc: s.desc, isArg: true }));
    return { items, prefix };
  }
  return null;
}

// ── 输入 ──────────────────────────────────────────
function readLine(prompt, menu) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let cursor = 0;
    let catIdx = 0, sel = 0;
    let menuVisible = !!menu;
    let flatItems = [];
    let filtering = false;
    let lastRenderLines = 0;

    function refreshMenu() {
      if (!menu) { menuVisible = false; return; }
      const argInfo = getArgCandidates(buf);
      if (argInfo) {
        flatItems = argInfo.items;
        menuVisible = flatItems.length > 0;
        filtering = true;
        sel = 0;
        return;
      }
      if (buf === '/') { menuVisible = true; filtering = false; sel = 0; }
      else if (buf.startsWith('/') && !buf.includes(' ')) {
        const all = [];
        for (const cat of menu) for (const it of cat.items) all.push(it);
        flatItems = all.filter((it) => it.cmd.startsWith(buf));
        menuVisible = flatItems.length > 0;
        filtering = true;
        sel = 0;
      } else { menuVisible = false; filtering = false; }
    }

    function buildRows() {
      const rows = [];
      if (!menuVisible) return rows;
      if (filtering) {
        const maxLen = Math.max(...flatItems.map((it) => it.cmd.length));
        for (let i = 0; i < flatItems.length; i++) {
          const it = flatItems[i];
          const pad = ' '.repeat(maxLen - it.cmd.length + 2);
          if (i === sel) rows.push(`${T.primary}${T.dot}${C_RESET} ${C_BOLD}${it.cmd}${C_RESET}${pad}${T.dim}${it.desc}${C_RESET}`);
          else rows.push(`  ${T.accent}${it.cmd}${C_RESET}${pad}${T.dim}${it.desc}${C_RESET}`);
        }
      } else {
        const tabParts = [];
        for (let i = 0; i < menu.length; i++) {
          const cat = menu[i];
          if (i === catIdx) tabParts.push(`${T.primary}${C_BOLD}${cat.name}${C_RESET}`);
          else tabParts.push(`${T.dim}${cat.name}${C_RESET}`);
        }
        rows.push(tabParts.join(`  ${T.line}${T.bullet}${C_RESET}  `));
        rows.push('__SEP__');
        const items = menu[catIdx].items;
        const maxLen = Math.max(...items.map((it) => it.cmd.length));
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          const pad = ' '.repeat(maxLen - it.cmd.length + 2);
          if (i === sel) rows.push(`${T.primary}${T.dot}${C_RESET} ${C_BOLD}${it.cmd}${C_RESET}${pad}${T.dim}${it.desc}${C_RESET}`);
          else rows.push(`  ${T.accent}${it.cmd}${C_RESET}${pad}${T.dim}${it.desc}${C_RESET}`);
        }
      }
      return rows;
    }

    function render() {
      const cols = process.stdout.columns || 80;
      const inputText = prompt + buf;
      const cursorText = prompt + buf.slice(0, cursor);
      const cursorCol = displayWidth(cursorText);
      let cursorRow = Math.floor(cursorCol / cols);
      let colInRow = cursorCol - cursorRow * cols;

      const inputCols = displayWidth(inputText);
      const inputLines = Math.max(1, Math.ceil(inputCols / cols));

      const rows = buildRows();
      let maxW = 0;
      for (const r of rows) {
        if (r === '__SEP__') continue;
        maxW = Math.max(maxW, displayWidth(r));
      }
      const innerW = Math.max(maxW + 2, 30);

      let out = '';
      if (lastRenderLines > 0) out += `\x1b[${lastRenderLines}A`;
      out += '\r\x1b[0J';
      out += inputText;

      let menuLines = 0;
      if (rows.length > 0) {
        out += '\n  ' + T.line + '╭' + '─'.repeat(innerW) + '╮' + C_RESET;
        for (const r of rows) {
          out += '\n  ' + T.line + '│' + C_RESET;
          if (r === '__SEP__') {
            out += T.line + '─'.repeat(innerW) + C_RESET;
          } else {
            const w = displayWidth(r);
            const rightPad = ' '.repeat(Math.max(0, innerW - w - 2));
            out += ' ' + r + rightPad + ' ';
          }
          out += T.line + '│' + C_RESET;
        }
        out += '\n  ' + T.line + '╰' + '─'.repeat(innerW) + '╯' + C_RESET;
        menuLines = rows.length + 2;
      }

      // 从屏幕末尾回到光标应在的位置
      const linesUp = menuLines + (inputLines - 1 - cursorRow);
      if (linesUp > 0) out += `\x1b[${linesUp}A`;
      out += '\r';
      if (colInRow > 0) out += `\x1b[${colInRow}C`;

      lastRenderLines = cursorRow;
      process.stdout.write(out);
    }

    function cleanup() {
      process.stdin.removeListener('keypress', onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    function finish(fb) {
      let out = '';
      if (lastRenderLines > 0) out += `\x1b[${lastRenderLines}A`;
      out += '\r\x1b[0J';
      out += prompt + fb + '\n';
      lastRenderLines = 0;
      cleanup();
      resolve(fb);
    }
    function abort(r) {
      let out = '';
      if (lastRenderLines > 0) out += `\x1b[${lastRenderLines}A`;
      out += '\r\x1b[0J\n';
      lastRenderLines = 0;
      cleanup();
      reject(new Error(r));
    }
    function currentItem() {
      if (!menuVisible) return null;
      return filtering ? flatItems[sel] : menu[catIdx].items[sel];
    }
    function completeFilename() {
      const before = buf.slice(0, cursor);
      const after = buf.slice(cursor);
      const lastSpace = before.lastIndexOf(' ');
      const prefix = lastSpace >= 0 ? before.slice(lastSpace + 1) : before;
      const head = lastSpace >= 0 ? before.slice(0, lastSpace + 1) : '';
      let names = [];
      try { names = fs.readdirSync(ROOT).sort(); } catch (e) { /* */ }
      const matches = names.filter((n) => n.startsWith(prefix));
      if (matches.length === 1) {
        const full = path.join(ROOT, matches[0]);
        const suffix = fs.statSync(full).isDirectory() ? '/' : '';
        const inserted = matches[0] + suffix;
        buf = head + inserted + after;
        cursor = (head + inserted).length;
        render();
        return true;
      } else if (matches.length > 1) {
        let common = matches[0];
        for (const m of matches) {
          let i = 0;
          while (i < common.length && i < m.length && common[i] === m[i]) i++;
          common = common.slice(0, i);
        }
        if (common.length > prefix.length) {
          buf = head + common + after;
          cursor = (head + common).length;
          render();
          return true;
        }
      }
      return false;
    }

    function onKey(str, key) {
      if (key.ctrl && key.name === 'c') return abort('SIGINT');
      if (key.ctrl && key.name === 'd') { if (buf === '') return abort('EOF'); }
      if (key.ctrl && key.name === 'a') { cursor = 0; render(); return; }
      if (key.ctrl && key.name === 'e') { cursor = buf.length; render(); return; }

      if (key.name === 'return' || key.name === 'enter') {
        if (menuVisible) {
          const it = currentItem();
          if (it) {
            if (it.isArg) {
              buf = buf.replace(/\S*$/, it.cmd);
              cursor = buf.length;
            } else {
              buf = it.cmd;
              cursor = buf.length;
            }
          }
        }
        return finish(buf);
      }
      if (key.name === 'backspace') {
        if (cursor > 0) {
          buf = buf.slice(0, cursor - 1) + buf.slice(cursor);
          cursor--;
          refreshMenu();
          render();
        }
        return;
      }
      if (key.name === 'delete') {
        if (cursor < buf.length) {
          buf = buf.slice(0, cursor) + buf.slice(cursor + 1);
          refreshMenu();
          render();
        }
        return;
      }
      if (key.name === 'left') {
        if (menuVisible && !filtering) {
          catIdx = (catIdx - 1 + menu.length) % menu.length;
          sel = 0;
          render();
        } else if (cursor > 0) {
          cursor--;
          render();
        }
        return;
      }
      if (key.name === 'right') {
        if (menuVisible && !filtering) {
          catIdx = (catIdx + 1) % menu.length;
          sel = 0;
          render();
        } else if (cursor < buf.length) {
          cursor++;
          render();
        }
        return;
      }
      if (key.name === 'home') { cursor = 0; render(); return; }
      if (key.name === 'end') { cursor = buf.length; render(); return; }
      if (key.name === 'up') {
        if (!menuVisible) return;
        const len = filtering ? flatItems.length : menu[catIdx].items.length;
        sel = (sel - 1 + len) % len;
        render();
        return;
      }
      if (key.name === 'down') {
        if (!menuVisible) return;
        const len = filtering ? flatItems.length : menu[catIdx].items.length;
        sel = (sel + 1) % len;
        render();
        return;
      }
      if (key.name === 'escape') {
        if (menuVisible) { menuVisible = false; render(); }
        return;
      }
      if (key.name === 'tab') {
        if (menuVisible) {
          const it = currentItem();
          if (it) {
            if (it.isArg) {
              buf = buf.replace(/\S*$/, it.cmd);
              cursor = buf.length;
              if (flatItems.length === 1) { buf += ' '; cursor++; }
              refreshMenu();
              render();
            } else {
              buf = it.cmd;
              cursor = buf.length;
              const len = filtering ? flatItems.length : menu[catIdx].items.length;
              if (len === 1) { buf += ' '; cursor++; }
              refreshMenu();
              render();
            }
          }
        } else {
          completeFilename();
        }
        return;
      }
      if (str && str.length > 0 && !key.ctrl && !key.meta) {
        const pr = str.replace(/[\r\n]/g, ' ');
        let has = false;
        for (const ch of pr) if (ch.charCodeAt(0) >= 32) has = true;
        if (has) {
          buf = buf.slice(0, cursor) + pr + buf.slice(cursor);
          cursor += pr.length;
          refreshMenu();
          render();
        }
      }
    }

    readline.emitKeypressEvents(process.stdin);
    process.stdin.resume();
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', onKey);
    process.stdout.write(prompt);
    lastRenderLines = 0;
  });
}

// ── 帮助 ──────────────────────────────────────────
function helpText() {
  console.log();
  console.log(`  ${C_BOLD}${T.primary}直接说话${C_RESET} ${T.dim}（自动判断意图）${C_RESET}`);
  console.log(`    ${T.dim}写一个 check_phone 函数到 solution.py${C_RESET}`);
  console.log(`    ${T.dim}再加个 check_email${C_RESET}`);
  console.log(`    ${T.dim}把 1_test.py 排一下版${C_RESET}`);
  console.log(`    ${T.dim}看下 solution.py${C_RESET}`);
  console.log(`    ${T.dim}跑一下${C_RESET}`);
  console.log();
  console.log(`  ${C_BOLD}${T.primary}文件编辑模式${C_RESET}`);
  console.log(`    ${T.accent}/open${C_RESET}    ${T.dim}<文件>${C_RESET}     ${T.dim}锁定文件，之后默认操作它${C_RESET}`);
  console.log(`    ${T.accent}/open${C_RESET}              ${T.dim}不带参数弹出列表选${C_RESET}`);
  console.log(`    ${T.accent}/close${C_RESET}             ${T.dim}退出文件编辑模式${C_RESET}`);
  console.log(`    ${T.accent}/pwd${C_RESET}               ${T.dim}显示当前文件完整路径${C_RESET}`);
  console.log(`    ${T.accent}/preview${C_RESET}           ${T.dim}预览模式 diff / both / off${C_RESET}`);
  console.log();
  console.log(`  ${C_BOLD}${T.primary}模式${C_RESET}`);
  console.log(`    ${T.accent}/chat${C_RESET}   ${T.dim}纯聊天${C_RESET}`);
  console.log(`    ${T.accent}/sec${C_RESET}    ${T.dim}只显示，绝不写入${C_RESET}`);
  console.log(`    ${T.accent}/ask${C_RESET}    ${T.dim}预览后确认（默认）${C_RESET}`);
  console.log(`    ${T.accent}/auto${C_RESET}   ${T.dim}直接写入${C_RESET}`);
  console.log(`    ${T.accent}/yolo${C_RESET}   ${T.dim}自动写入 + 允许运行${C_RESET}`);
  console.log();
  console.log(`  ${C_BOLD}${T.primary}配置${C_RESET}`);
  console.log(`    ${T.accent}/conf${C_RESET}                      ${T.dim}查看当前配置${C_RESET}`);
  console.log(`    ${T.accent}/conf provider${C_RESET} ${T.dim}<名称>${C_RESET}      ${T.dim}ollama / lmstudio${C_RESET}`);
  console.log(`    ${T.accent}/conf model${C_RESET}    ${T.dim}<名称>${C_RESET}      ${T.dim}切换模型${C_RESET}`);
  console.log(`    ${T.accent}/conf url${C_RESET}      ${T.dim}<地址>${C_RESET}      ${T.dim}自定义地址${C_RESET}`);
  console.log(`    ${T.accent}/conf theme${C_RESET}    ${T.dim}<名称>${C_RESET}      ${T.dim}主题${C_RESET}`);
  console.log(`    ${T.accent}/conf mode${C_RESET}     ${T.dim}<名称>${C_RESET}      ${T.dim}默认模式${C_RESET}`);
  console.log(`    ${T.accent}/conf reset${C_RESET}                  ${T.dim}恢复默认${C_RESET}`);
  console.log();
  console.log(`  ${C_BOLD}${T.primary}模型${C_RESET}`);
  console.log(`    ${T.accent}/models${C_RESET}                    ${T.dim}列出并交互切换模型${C_RESET}`);
  console.log();
  console.log(`  ${C_BOLD}${T.primary}其他${C_RESET} ${T.dim}/test /mode /root /files /clear /exit${C_RESET}`);
  console.log();
  console.log(`  ${T.dim}配置文件: ${T.accent}${getConfigPath()}${C_RESET}`);
  console.log(`  ${T.dim}优先级: 命令行 > 环境变量 > 配置文件 > 默认${C_RESET}`);
  console.log();
  console.log(`  ${C_BOLD}${T.primary}连接不上？${C_RESET} 跑 ${T.accent}/test${C_RESET} 看详细排查`);
  console.log();
}
function showMode() {
  console.log(`  ${T.primary}${T.star}${C_RESET} ${C_BOLD}模式${C_RESET}  ${T.user}${MODE}${C_RESET}`);
  dim(MODES[MODE] || '?');
  if (MODE === 'sec') info('只显示代码，不会写入任何文件');
}

// ── 主入口 ────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  let rootArg = null;
  let cliMode = null;
  let cliTheme = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--root' || a === '-r') rootArg = args[++i];
    else if (a === '--mode' || a === '-m') cliMode = args[++i];
    else if (a === '--sec') cliMode = 'sec';
    else if (a === '--theme' || a === '-t') cliTheme = args[++i];
    else if (a === '--help' || a === '-h') {
      console.log('用法: whale.js [--root <目录>] [--mode <模式>] [--theme <主题>]');
      process.exit(0);
    }
  }

  if (rootArg) {
    ROOT = path.resolve(rootArg.replace(/^~/, os.homedir()));
    if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) {
      console.error(`目录不存在 ${ROOT}`); process.exit(1);
    }
    process.chdir(ROOT);
  } else {
    ROOT = process.cwd();
  }

  config = loadConfig();

  PROVIDER = config.provider || 'ollama';
  if (!PROVIDERS[PROVIDER]) PROVIDER = 'ollama';
  OLLAMA_URL = process.env.OLLAMA_URL || config.ollama_url || PROVIDERS[PROVIDER].defaultUrl;
  MODEL = process.env.OLLAMA_MODEL || config.model || 'qwen2.5-coder:7b';
  THEME_NAME = process.env.WHALE_THEME || config.theme || 'claude';
  MODE = config.mode || 'ask';
  PREVIEW_MODE = config.preview || 'diff';

  if (cliTheme && THEMES[cliTheme]) THEME_NAME = cliTheme;
  if (cliMode && MODES[cliMode]) MODE = cliMode;
  if (!(MODE in MODES)) MODE = 'ask';
  if (!(PREVIEW_MODE in PREVIEW_MODES)) PREVIEW_MODE = 'diff';
  T = THEMES[THEME_NAME] || THEMES.claude;

  banner();

  while (true) {
    const modeTag = MODE === 'ask' ? `${T.dim}ask${C_RESET}` : `${T.primary}${MODE}${C_RESET}`;
    const fileTag = ACTIVE_FILE
      ? `${T.primary}${C_BOLD}${ACTIVE_FILE}${C_RESET} ${T.dim}·${C_RESET} `
      : '';
    const prompt = `  ${T.primary}${C_BOLD}${T.star}${C_RESET} ${fileTag}${modeTag} ${T.primary}${T.bullet}${C_RESET} `;

    let text;
    try { text = (await readLine(prompt, MENU)).trim(); }
    catch (e) {
      if (e.message === 'SIGINT' || e.message === 'EOF') { console.log(); break; }
      throw e;
    }
    if (!text) continue;

    if (text.startsWith('/')) {
      const spaceIdx = text.indexOf(' ');
      const cmd = spaceIdx > 0 ? text.slice(1, spaceIdx) : text.slice(1);
      const rest = spaceIdx > 0 ? text.slice(spaceIdx + 1).split(/\s+/).filter(Boolean) : [];

      if (cmd in MODES) { MODE = cmd; ok(`模式 → ${cmd}`); dim(MODES[cmd]); continue; }
      if (cmd === 'exit' || cmd === 'quit' || cmd === 'q') break;
      if (cmd === 'help') { helpText(); continue; }
      if (cmd === 'test') { await doTest(); continue; }
      if (cmd === 'models') { await doModels(); continue; }
      if (cmd === 'open')  { await doOpenFile(rest); continue; }
      if (cmd === 'close') { doCloseFile(); continue; }
      if (cmd === 'pwd')   { doPwd(); continue; }
      if (cmd === 'preview') { doPreview(rest); continue; }
      if (cmd === 'conf') { doConf(rest); continue; }
      if (cmd === 'theme') {
        if (rest.length === 0) {
          console.log(`  ${T.primary}当前主题${C_RESET}: ${C_BOLD}${T.name}${C_RESET}`);
          dim(`可用: ${Object.keys(THEMES).join('  ')}`);
        } else {
          const t = rest[0];
          if (THEMES[t]) {
            THEME_NAME = t; T = THEMES[t]; persistConfig();
            console.log(); banner();
          } else { err(`未知主题: ${t}`); dim(`可用: ${Object.keys(THEMES).join('  ')}`); }
        }
        continue;
      }
      if (cmd === 'mode') {
        if (rest.length === 0) { showMode(); continue; }
        const m = rest[0];
        if (m in MODES) { MODE = m; persistConfig(); ok(`模式 → ${m}`); dim(MODES[m]); }
        else { err(`未知模式: ${m}`); }
        continue;
      }
      if (cmd === 'root') { console.log(`  ${T.user}${relPath(ROOT)}${C_RESET}`); continue; }
      if (cmd === 'files') { doLs(''); continue; }
      if (cmd === 'clear') { HISTORY.length = 0; ok('历史已清空'); continue; }
      err(`未知命令: /${cmd}`);
      continue;
    }

    if (MODE === 'chat') { await doChat(text); continue; }
    const intent = detectIntent(text);
    try {
      if (intent === 'chat') await doChat(text);
      else if (intent === 'ls') doLs(text);
      else if (intent === 'read') doRead(text);
      else if (intent === 'run') await doRun(text);
      else if (intent === 'edit') await doWrite(text, 'edit');
      else if (intent === 'write') await doWrite(text, 'new');
      else await doChat(text);
    } catch (e) { err(`出错: ${e.message}`); }
  }

  console.log();
  console.log(`  ${T.primary}${T.star}${C_RESET} ${T.dim}bye~${C_RESET}`);
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
