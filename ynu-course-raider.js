#!/usr/bin/env node
/**
 * YNU Course Raider — 云南大学研究生选课系统自动抢课守护
 *
 * 特性：
 *  - 持续监控目标课程空位（1.5s 轮询，全量查询不污染搜索框）
 *  - 发现空位立即提交（token 保鲜前置 + 提交前 guard + 通知后置，零延迟）
 *  - 会话过期自动重登录（云端 VLM 验证码识别：三模型候选合并）
 *  - Ego 渲染进程卡死自愈（关闭重开页签，非 refresh）
 *  - macOS 桌面通知 + 蜂鸣
 *
 * 运行环境：macOS + Ego Browser（ego-browser CLI）
 * 使用前：见 README.md —— 修改下方 CONFIG.groups 为你自己的课程，
 *         并在 ~/.config/ynu-course-raider/credentials.json 配置登录凭证。
 *
 * 免责声明：本脚本仅用于学习研究。请遵守学校选课规定，勿滥用。
 */

const CONFIG = {
  pollInterval: 1.5,
  resultPollBase: 0.5,
  resultMaxRetries: 30,
  sessionRefreshPolls: 200,
  rebuildIntervalPolls: 9600,   // 每 9600 轮（≈4小时）主动重建页签，防止 Ego 渲染进程长时间运行后卡死
  taskSpaceId: 2,
  taskSpaceName: 'ynu course sniper deployment',  // Ego 重启后数字 id 会失效，用名字兜底创建
  courseUrl: 'https://yjsxk.ynu.edu.cn/yjsxkapp/sys/xsxkapp/course.html',
  courseLx: '0',

  // 会话过期自动重登录
  autoRelogin: true,
  loginUrl: 'https://yjsxk.ynu.edu.cn/yjsxkapp/sys/xsxkapp/index.html',
  credentialsPath: require('os').homedir() + '/.config/ynu-course-raider/credentials.json',
  loginMaxAttempts: 4,          // 每轮尝试 N 张验证码图（每图只提交 top1 候选=4个独立样本；锁定窗口~5次提交安全）
  loginRetryInterval: 300,      // 自动登录失败后每隔 N 秒再自动重试
  tesseractPath: '/opt/homebrew/bin/tesseract',
  vlmEnabled: true,             // 本地 VLM（ollama）识别验证码
  vlmApi: 'http://localhost:11434/api/generate',
  vlmModel: 'qwen3-vl:4b',      // 本地兜底（实测识别率仅17-33%，仅云端失败时用）
  vlmSamples: 3,                // 多采样投票次数
  vlmUpscale: 8,                // 验证码放大倍数（本地 VLM 用；云端不需要）
  lockPauseSec: 3600,           // 检测到"登录错误次数过多"后暂停秒数（失败计数深时每轮第2次提交就锁，拉长到1小时）
  cloudVlmEnabled: true,        // 云端 VLM 主识别
  cloudVlmBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  cloudVlmModel: 'qwen3.8-max',   // 主模型（2026-08-26 学生认证 300 元券生效，Access denied 解除；识别率最高 83%）
  cloudVlmModel2: 'qwen3.8-27b',  // 第二模型：延迟 2-3s，与 max 候选互补
  cloudVlmModel3: 'qwen3.5-omni-plus', // 第三模型：稳定，与 max/27b 互补
  cloudVlmUpscale: 0,           // 云端放大倍数：OCR 模型实测放大后丢字符，关闭

  // 任务定义：每组独立必抢，所有组成功后停止
  // 示例：三门课全抢（课程代码 KCDM 在选课系统「开课课程查询」中查看）
  groups: [
    {
      name: 'G0-CourseA',
      codes: ['XXXXXXXXXX'],      // 替换为目标课程代码
      classFilter: ['02'],        // 班级过滤（可选）
      mustGet: true,
    },
    {
      name: 'G1-CourseB',
      codes: ['XXXXXXXXXX'],
      classFilter: [],
      mustGet: true,
    },
    {
      name: 'G2-CourseC',
      codes: ['XXXXXXXXXX'],
      classFilter: [],
      mustGet: true,
    },
  ],
};

let pollCount = 0, selecting = false, courseTabId = null;
let consecutiveErrors = 0, sessionState = 'init', sessionExpiredSince = null, lastNotifyTime = 0;
let autoLoginTriedAt = 0;       // 上次自动登录尝试时间戳（0=未尝试）
let lockPausedUntil = 0;        // 登录频率限制暂停截止时间戳
// 每组的成功状态
let groupSuccess = CONFIG.groups.map(() => false);
// 每组抢课连续失败计数（升级通知用，跨轮次累计）
let groupFailCount = CONFIG.groups.map(() => 0);

// ★ 日志（审查修正）：迁到用户私有状态目录，0600 权限，拒绝符号链接（防 /tmp 泄露/覆盖）
const { homedir } = require('os');
const LOG_DIR = homedir() + '/.config/ynu-course-raider';
const LOG_FILE = LOG_DIR + '/daemon.log';
const { writeFileSync, appendFileSync, mkdirSync, chmodSync, lstatSync } = require('fs');
try { mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 }); } catch(e) {}
try {
  // 拒绝符号链接：若日志路径是 symlink，先删除（防预置链接覆盖）
  const st = lstatSync(LOG_FILE);
  if (st.isSymbolicLink()) { try { require('fs').unlinkSync(LOG_FILE); } catch(e) {} }
} catch(e) {}

function log(msg) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = `[${ts}] ${msg}`;
  cliLog(line);
  try { appendFileSync(LOG_FILE, line + '\n'); chmodSync(LOG_FILE, 0o600); } catch(e) {}
}
function allDone() { return groupSuccess.every(x => x); }

// ★ HTML 转义（审查修正）：课程名等外部数据进 innerHTML 前转义，防 XSS
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function courseMatchesGroup(course, group) {
  if (!group.codes.includes(course.KCDM)) return false;
  if (group.classFilter && group.classFilter.length > 0) {
    const name = course.BJMC || course.KCMC || '';
    return group.classFilter.some(cf => name.includes(cf));
  }
  return true;
}

// A successful selection removes the class from the available-course list.
// Sync once at startup so a restart does not keep trying an already-selected group.
async function syncSelectedGroups() {
  try {
    const result = await js(String.raw`(() => {
      var d = $.Deferred();
      $.ajax({
        url: BaseUrl + "/sys/xsxkapp/xsxkCourse/loadStdCourseInfo.do?_=" + Date.now(),
        cache: false, dataType: "json", data: {}, type: "get",
        success: function(res) {
          d.resolve(JSON.stringify({ ok: true, results: res.results || [] }));
        },
        error: function(xhr, s, e) {
          d.resolve(JSON.stringify({ ok: false, httpCode: xhr.status || 0, error: String(e) }));
        }
      });
      return d.promise();
    })()`);
    const data = JSON.parse(result);
    if (!data.ok) {
      log(`已选课程同步失败: ${data.error || ''} http=${data.httpCode || ''}`);
      return false;
    }
    for (let gi = 0; gi < CONFIG.groups.length; gi++) {
      if (groupSuccess[gi]) continue;
      const found = data.results.some(course => courseMatchesGroup(course, CONFIG.groups[gi]));
      if (found) {
        groupSuccess[gi] = true;
        log(`✅ 检测到已选课程，标记任务完成: ${CONFIG.groups[gi].name}`);
      }
    }
    return true;
  } catch (e) {
    log('已选课程同步异常: ' + String(e.message || e));
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════
 *  会话过期自动重登录模块
 *  流程: 拿 vtoken → 下载验证码 → tesseract OCR → 页面内 DES 加密 → 提交
 *  失败自动换验证码重试; 密码错误才停下通知人工
 * ═══════════════════════════════════════════════════════════════ */
function loadCredentials() {
  try {
    const { readFileSync } = require('fs');
    const c = JSON.parse(readFileSync(CONFIG.credentialsPath, 'utf8'));
    if (!c.loginName || !c.loginPwd) return null;
    return c;
  } catch (e) {
    log('❌ 读取凭据失败: ' + CONFIG.credentialsPath + ' (' + String(e.message || e) + ')');
    return null;
  }
}

// 云端 VLM 单次识别（DashScope OpenAI 兼容）。输入原图 base64，内部放大（OCR 模型对小图丢字符）。返回 4 字符候选或 ''
async function cloudVlmCall(b64img, temperature, model) {
  try {
    const { spawnSync } = require('child_process');
    const cred = loadCredentials();
    if (!cred || !cred.apiKey) return '';
    const m = model || CONFIG.cloudVlmModel;
    // 放大预处理（sips，原图 70x30 → 560x240）
    let imgB64 = b64img;
    if (CONFIG.cloudVlmUpscale > 1) {
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const rawPath = path.join(os.tmpdir(), 'craw-' + process.pid + '.jpg');
      const bigPath = path.join(os.tmpdir(), 'cbig-' + process.pid + '.jpg');
      try {
        fs.writeFileSync(rawPath, Buffer.from(b64img, 'base64'));
        const up = spawnSync('/usr/bin/sips', ['-Z', String(70 * CONFIG.cloudVlmUpscale), rawPath, '--out', bigPath], { timeout: 20000 });
        if (up.status === 0 && fs.existsSync(bigPath)) imgB64 = fs.readFileSync(bigPath).toString('base64');
      } catch(e) {}
    }
    const prompt = '这是一张验证码图片，只包含大写字母和数字，共4个字符。请准确识别，只输出这4个字符（大写），不要任何其他内容。';
    const body = {
      model: m,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + imgB64 } },
          { type: 'text', text: prompt }
        ]
      }],
      max_tokens: 16
    };
    // OCR 专用模型不支持 temperature，仅通用模型带
    if (String(m).indexOf('ocr') < 0) body.temperature = temperature;
    // ★ 进程内 https 请求（审查修正）：API key 不进 curl argv，避免被本机进程检查读取
    const https = require('https');
    const payloadBuf = Buffer.from(JSON.stringify(body), 'utf8');
    const parsed = new URL(CONFIG.cloudVlmBase + '/chat/completions');
    const r = await new Promise((resolve) => {
      const req = https.request({
        hostname: parsed.hostname, port: 443, path: parsed.pathname,
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + cred.apiKey,
          'Content-Type': 'application/json',
          'Content-Length': payloadBuf.length
        },
        timeout: 60000
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
      req.on('error', () => resolve({ status: 0, body: '' }));
      req.write(payloadBuf);
      req.end();
    });
    if (r.status !== 200) return '';
    const j = JSON.parse(r.body);
    const t = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '')
      .replace(/\s+/g, '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
    return t.length === 4 ? t : '';
  } catch (e) { return ''; }
}

// 本地 ollama VLM 单次识别（qwen3-vl:4b）。输入 b64img 原图，内部做放大预处理。返回 4 字符候选或 ''
function ollamaVlmCall(b64img, temperature) {
  try {
    const { spawnSync } = require('child_process');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmpdir = os.tmpdir();
    const rawPath = path.join(tmpdir, 'vcode-raw-' + process.pid + '.jpg');
    const bigPath = path.join(tmpdir, 'vcode-big-' + process.pid + '.jpg');
    fs.writeFileSync(rawPath, Buffer.from(b64img, 'base64'));
    // 放大（sips 从 stdin 无法读图，需临时文件；Electron 下 spawnSync 可用）
    const up = spawnSync('/usr/bin/sips', ['-Z', String(70 * CONFIG.vlmUpscale), rawPath, '--out', bigPath], { timeout: 20000 });
    let imgB64 = b64img;
    if (up.status === 0 && fs.existsSync(bigPath)) {
      imgB64 = fs.readFileSync(bigPath).toString('base64');
    }
    const prompt = '这是一张验证码图片，只包含大写字母和数字，共4个字符。请准确识别，只输出这4个字符（大写），不要任何其他内容。';
    const payload = JSON.stringify({
      model: CONFIG.vlmModel, prompt, images: [imgB64], stream: false,
      options: { temperature }
    });
    const r = spawnSync('curl', ['-s', '--max-time', '60', CONFIG.vlmApi, '-d', payload], { timeout: 90000, maxBuffer: 10 * 1024 * 1024 });
    if (r.status !== 0) return '';
    const j = JSON.parse(r.stdout.toString('utf8'));
    const t = (j.response || '').replace(/\s+/g, '').replace(/[^0-9A-Z]/g, '');
    return t.length === 4 ? t : '';
  } catch (e) { return ''; }
}

// tesseract 单次识别（stdin 管道，Electron 下 fopen 有 bug）
function tessCall(b64img) {
  try {
    const { spawnSync } = require('child_process');
    const buf = Buffer.from(b64img, 'base64');
    const whitelist = 'tessedit_char_whitelist=0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    for (const psm of ['7', '8', '13']) {
      try {
        const t = spawnSync(CONFIG.tesseractPath, ['stdin', 'stdout', '--psm', psm, '-c', whitelist], { input: buf, timeout: 15000 });
        if (t.status === 0) {
          const s = t.stdout.toString('utf8').replace(/\s+/g, '');
          if (s.length >= 3) return s;
        }
      } catch (e) {}
    }
  } catch (e) {}
  return '';
}

// 验证码识别：VLM 多采样投票，返回去重候选列表（按票数排序，最多3个）。tesseract 结果并入候选。
// ★ async（审查修正）：cloudVlmCall 是 async，必须 await，否则候选变成 "[object Promise]" 被当真实验证码提交
async function ocrVcodeCandidates(b64img) {
  const cands = [];
  if (CONFIG.cloudVlmEnabled) {
    // 三模型采样：max + 27b + omni-plus，候选合并去重
    const temps = [0, 0.3, 0.6];
    const models = [CONFIG.cloudVlmModel, CONFIG.cloudVlmModel2 || CONFIG.cloudVlmModel, CONFIG.cloudVlmModel3 || CONFIG.cloudVlmModel];
    for (let i = 0; i < CONFIG.vlmSamples; i++) {
      const c = await cloudVlmCall(b64img, temps[i % 3], models[i % 3]);
      if (c) cands.push(c);
    }
  } else if (CONFIG.vlmEnabled) {
    for (let i = 0; i < CONFIG.vlmSamples; i++) {
      const c = await ollamaVlmCall(b64img, [0, 0.4, 0.8][i % 3]);
      if (c) cands.push(c);
    }
  }
  const tess = tessCall(b64img);
  if (tess && tess.length === 4) cands.push(tess);
  // 按票数排序（VLM 采样 + tesseract 各算一票）
  const counts = {};
  for (const c of cands) counts[c] = (counts[c] || 0) + 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(e => e[0])
    .slice(0, 3);
}

// 兼容旧调用：返回第一个候选或 ''（async）
async function ocrVcode(b64img) {
  const cands = await ocrVcodeCandidates(b64img);
  return cands.length ? cands[0] : '';
}

// 页面内获取 vtoken + 验证码图片 base64（与提交登录共用同一页面会话）
async function fetchVcode() {
  const r = await js(String.raw`(() => {
    return fetch(BaseUrl + '/sys/xsxkapp/login/4/vcode.do?timestamp=' + Date.now())
      .then(function(r){ return r.json() })
      .then(function(d){
        if (!d.data || !d.data.token) return JSON.stringify({ ok: false, reason: 'no_token' });
        var vt = d.data.token;
        return fetch(BaseUrl + '/sys/xsxkapp/login/vcode/image.do?vtoken=' + vt)
          .then(function(r){ return r.arrayBuffer() })
          .then(function(ab){
            var bytes = new Uint8Array(ab), bin = '';
            for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            return JSON.stringify({ ok: true, vt: vt, b64: btoa(bin) });
          });
      })
      .catch(function(e){ return JSON.stringify({ ok: false, reason: String(e) }); });
  })()`);
  return JSON.parse(r);
}

// 页面内 DES 加密 + 提交登录。返回后端响应对象
async function submitLogin(loginName, loginPwd, verifyCode, vtoken) {
  const r = await js(String.raw`(() => {
    var d = $.Deferred();
    var p = {
      loginName: ` + JSON.stringify(loginName) + `,
      loginPwd: DES.strEncSimple(` + JSON.stringify(loginPwd) + `),
      verifyCode: ` + JSON.stringify(verifyCode) + `,
      vtoken: ` + JSON.stringify(vtoken) + `
    };
    $.post(BaseUrl + '/sys/xsxkapp/login/check/login.do?timestrap=' + Date.now(), p, function(resp){
      d.resolve(JSON.stringify(resp));
    }).fail(function(xhr){ d.resolve(JSON.stringify({ code: 0, httpCode: xhr.status, msg: 'http ' + xhr.status })); });
    return d.promise();
  })()`);
  return JSON.parse(r);
}

// 检查登录页环境是否可用（URL 正确 + BaseUrl + jQuery + DES 都在）
async function isLoginPageReady() {
  try {
    const r = await js(`JSON.stringify({
      url: window.location.href || '',
      base: typeof BaseUrl !== 'undefined' && !!BaseUrl,
      jq: typeof $ !== 'undefined' && typeof $.ajax === 'function',
      des: typeof DES !== 'undefined' && typeof DES.strEncSimple === 'function'
    })`);
    const s = JSON.parse(r);
    return s.url.indexOf('/index.html') >= 0 && s.base && s.jq && s.des;
  } catch (e) { return false; }
}

// 完整自动登录流程。成功返回 true
async function autoLogin() {
  const cred = loadCredentials();
  if (!cred) return false;
  log('🔑 开始自动重登录...');
  try {
    await gotoAndWait(CONFIG.loginUrl, { timeout: 60, settle: 5 });
    await wait(2);
  } catch (e) {
    // gotoAndWait 超时 ≠ 导航失败：页面可能已跳转但加载慢。检查页面环境是否可用。
    log('⚠️ gotoAndWait 超时: ' + String(e.message || e).slice(0, 80));
    let ready = false;
    for (let i = 0; i < 3; i++) {
      await wait(5);
      ready = await isLoginPageReady();
      if (ready) break;
    }
    if (!ready) {
      log('❌ 打开登录页失败（页面环境不可用）');
      return false;
    }
    log('✅ 页面已就绪（gotoAndWait 超时但导航成功），继续登录');
  }
  for (let attempt = 1; attempt <= CONFIG.loginMaxAttempts; attempt++) {
    try {
      const vc = await fetchVcode();
      if (!vc.ok) { log(`⚠️ 验证码获取失败 #${attempt}: ${vc.reason || ''}`); await wait(2); continue; }
      const candidates = await ocrVcodeCandidates(vc.b64);
      if (candidates.length === 0) { log(`⚠️ OCR 未识别出验证码 #${attempt}`); continue; }
      // 每图只提交 top1 候选：同图多候选是"确定性模型的相关样本"，不同图才是独立样本。
      // 4 张图 × top1 = 4 次独立尝试（锁定窗口内 ~5 次提交安全）
      const code = candidates[0];
      log(`🔍 图#${attempt} 候选: ${JSON.stringify(candidates.slice(0, 3))} → 提交 "${code}"`);
      let resp = null, codeStr = '';
      resp = await submitLogin(cred.loginName, cred.loginPwd, code, vc.vt);
      codeStr = String(resp.code || '');
      // ★ 日志去标识（审查修正）：只记录分类+code，不持久化后端 msg（可能含账号类个人标识）
      const respMsg = String(resp.msg || '');
      const respClass = /次数过多|限制|锁定|频繁/.test(respMsg) ? 'LOCK_HINT'
        : respMsg.indexOf('页面已过期') >= 0 ? 'EXPIRED'
        : respMsg ? 'OTHER' : '';
      log(`登录尝试 #${attempt} "${code}": code=${codeStr} class=${respClass || '-'}`);
      // 锁定检测（审查修正）：只对明确锁定码（#E2140600091）或锁定文案启用长暂停。
      // code=0 可能是网络/传输错误（HTTP 失败），不是频率限制——不应暂停 1 小时。
      const lockHint = /次数过多|限制|锁定|频繁/.test(String(resp.msg || ''));
      const lockCode = /#E2140600091/.test(codeStr);
      if (lockCode || (codeStr !== '1' && codeStr !== '2' && codeStr !== '3' && codeStr !== '4' && lockHint)) {
        lockPausedUntil = Date.now() + CONFIG.lockPauseSec * 1000;
        log(`⛔ 检测到登录频率限制/锁定，暂停 ${CONFIG.lockPauseSec} 秒后再试`);
        notify('⛔ 登录频率限制', `暂停 ${CONFIG.lockPauseSec / 60} 分钟后自动重试`, 'Basso'); beep(2);
        return false;
      }
      if (codeStr === '1') {
        log('✅✅ 自动登录成功!');
        return true;
      }
      if (codeStr === '2') {
        log('❌ 账号或密码错误，停止自动重试。请检查 ' + CONFIG.credentialsPath);
        notify('❌ 自动登录失败', '账号或密码错误，需要人工处理', 'Basso'); beep(3);
        return false;
      }
      if (codeStr === '4') { log('⚠️ 在线人数超限，10 秒后重试'); await wait(10); continue; }
      // code=3 → 这张图识别错，换下一张（独立样本）
      await wait(1 + Math.random());
    } catch (e) {
      log(`⚠️ 登录尝试异常 #${attempt}: ${String(e.message || e).slice(0, 120)}`);
      await wait(2);
    }
  }
  log('❌ 自动登录失败（已达最大尝试次数），请手动登录');
  notify('🚨 自动登录失败', '已重试 ' + CONFIG.loginMaxAttempts + ' 次，请手动登录', 'Basso'); beep(3);
  return false;
}

function notify(title, message, sound) {
  try {
    const script = `display notification ${JSON.stringify(String(message || ''))} with title ${JSON.stringify(String(title || ''))}${sound ? ` sound name ${JSON.stringify(String(sound))}` : ''}`;
    const { execFileSync } = require('child_process');
    execFileSync('/usr/bin/osascript', ['-e', script], { timeout: 5000 });
  } catch(e) {}
}
function beep(times) {
  try { const { execSync } = require('child_process'); execSync(`osascript -e 'beep ${times||3}'`, { timeout: 3000 }); } catch(e) {}
}

async function ensureTab() {
  // 直接用名字：匹配已有空间或创建（数字 id 在 Ego 重启后会失效，仅作参考）
  try { await useOrCreateTaskSpace(CONFIG.taskSpaceName); }
  catch(e) {
    const msg = String(e && e.message || e);
    if (msg.includes('user is controlling') || msg.includes('not assigned') || msg.includes('inactive') || msg.includes('user-owned')) return 'user_control';
    log('无法连接任务空间: ' + msg); return false;
  }
  const tabs = await listTabs();
  // 匹配放宽：course 或 index（登录页）都算"业务页签"，避免 autoLogin 导航后误判不存在而重复新开
  let tab = tabs.find(t => t.url && t.url.includes('xsxkapp') && (t.url.includes('course') || t.url.includes('index')));
  let openedNewTab = false;
  if (!tab) {
    log('⚠️ 选课标签页不存在，重新打开...');
    try {
      const pageNavigationStartedAt = Date.now();
      await openOrReuseTab(CONFIG.courseUrl, { wait: true, timeout: 30 });
      const nt = await listTabs();
      tab = nt.find(t => t.url && t.url.includes('xsxkapp') && (t.url.includes('course') || t.url.includes('index')));
      if (!tab) { log('❌ 无法打开'); return false; }
      await wait(5);
      // ★ 修复（2026-08-29）：token 未就绪不再阻塞 ensureTab——未登录时 csrfToken 永不注入，
      //   若在此 return false，pollOnce 永远到不了 checkSession/autoLogin（死锁）。
      //   页面结构就绪即返回 true，token 检查交给会话流程（checkSession 401 → autoLogin → 登录后注入）。
      const tokenOk = await waitForTokenReady();
      if (!tokenOk) {
        log('⚠️ 新开页签后 csrfToken 未就绪（可能未登录），交由会话流程处理');
        tokenBornAt = 0; lastTokenVerifiedAt = 0;
      }
      openedNewTab = true;
      tokenBornAt = pageNavigationStartedAt;  // 从导航开始保守计龄，不把就绪等待时间漏掉
      lastTokenVerifiedAt = Date.now();
    } catch(e) { log('❌ 打开失败: ' + e.message); return false; }
  }
  if (courseTabId !== tab.targetId) {
    await switchTab(tab.targetId);
    courseTabId = tab.targetId;
    // token 时间戳只属于生成它的页面实例，不能从另一个 tab 继承。
    if (!openedNewTab) {
      tokenBornAt = 0;
      lastTokenVerifiedAt = 0;
    }
  }
  return true;
}

// 关闭多余的 xsxkapp 页签，只保留当前工作的那个（防页面堆积卡死）
async function cleanupExtraTabs() {
  try {
    const tabs = await listTabs();
    const keepId = courseTabId;
    for (const t of tabs) {
      if (!t.url || !t.url.includes('xsxkapp')) continue;
      if (t.targetId === keepId) continue;
      try { await closeTab(t.targetId); log('🧹 关闭多余页签: ' + (t.url || '').slice(0, 60)); } catch(e) {}
    }
  } catch(e) {}
}

async function checkSession() {
  try {
    const state = await js(`(() => {
      var url = window.location.href || '';
      if (url.indexOf('xsxkapp') < 0 || url.indexOf('course') < 0)
        return JSON.stringify({ status: 'expired', reason: 'url: ' + url.substring(0, 80) });
      if (typeof BaseUrl === 'undefined' || !BaseUrl)
        return JSON.stringify({ status: 'expired', reason: 'no_baseurl' });
      var el = document.querySelector('#csrfToken');
      if (!el || !el.value) return JSON.stringify({ status: 'expired', reason: 'no_csrf' });
      return JSON.stringify({ status: 'valid' });
    })()`);
    return JSON.parse(state);
  } catch(e) {
    const msg = String(e.message || e);
    if (msg.includes('user is controlling') || msg.includes('not assigned'))
      return { status: 'user_control', reason: msg };
    return { status: 'error', reason: msg };
  }
}

/**
 * 全量查询，按 KCDM + 班名过滤，返回各组候选课程
 * query_keyword 留空，不污染搜索框
 */
async function queryCourses() {
  // 将 groups 配置序列化注入页面
  const groupsJs = JSON.stringify(CONFIG.groups.map(g => ({
    codes: g.codes, classFilter: g.classFilter, name: g.name
  })));

  const result = await js(String.raw`(() => {
    var groups = ` + groupsJs + `;
    var d = $.Deferred();
    $.ajax({
      url: BaseUrl + "/sys/xsxkapp/xsxkCourse/loadJhnCourseInfo.do?_=" + Date.now(),
      cache: false, dataType: "json",
      data: "query_keyword=&query_kkyx=&query_kcfl=&query_kcbq=&query_xqdm=&query_skyydm=&query_sfct=&query_sfym=&query_gxrlsfym=&fixedAutoSubmitBug=&pageIndex=1&pageSize=100&sortField=&sortOrder=",
      type: "post",
      success: function(res) {
        var allCourses = res.datas || [];
        var groupResults = groups.map(function(g) {
          var matches = allCourses.filter(function(c) {
            if (g.codes.indexOf(c.KCDM) < 0) return false;
            // 如果有 classFilter，班名必须包含其中之一
            if (g.classFilter && g.classFilter.length > 0) {
              var name = c.BJMC || c.KCMC || '';
              var classMatch = g.classFilter.some(function(cf) { return name.indexOf(cf) >= 0; });
              if (!classMatch) return false;
            }
            return true;
          }).map(function(c) {
            return {
              kcdm: c.KCDM, name: c.BJMC || c.KCMC, bjdm: c.BJDM,
              kxrs: c.KXRS, dqrs: c.DQRS,
              conflict: c.IS_CONFLICT === 1,
              full: c.DQRS >= c.KXRS,
              hasVacancy: c.DQRS < c.KXRS
            };
          });
          return { name: g.name, classes: matches };
        });
        d.resolve(JSON.stringify({ ok: true, groups: groupResults, totalCount: allCourses.length }));
      },
      error: function(xhr, s, e) {
        d.resolve(JSON.stringify({ ok: false, error: String(e), httpCode: xhr.status || 0, body: (xhr.responseText||'').substring(0, 80) }));
      }
    });
    return d.promise();
  })()`);
  return JSON.parse(result);
}

// csrfToken 保鲜预检：用"真实长格式 bjdm 的冲突课"（信息安全，无副作用）探针。
// 同一页面实测：109s 时到达时间冲突业务层，277s 时返回"页面已过期"。
// 注意：满课/无效 bjdm 可能在 token 校验前就返回，不能据此证明某类 bjdm 免校验。
// 与官方 courses.js 的 getRequest() + secretKey 条件附加保持一致。
// 返回同一 data 对象，便于在页面上下文中注入并调用。
function addSecretKeyFromSearch(data, search) {
  const query = String(search || '').replace(/^\?/, '');
  if (!query) return data;
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    const key = eq >= 0 ? part.slice(0, eq) : part;
    if (key !== 'secretKey') continue;
    const value = unescape(eq >= 0 ? part.slice(eq + 1) : '');
    if (value) data.secretKey = value;
    break;
  }
  return data;
}

async function submitChoice(bjdm) {
  const addSecretKeyJs = addSecretKeyFromSearch.toString();
  const result = await js(String.raw`(() => {
    var d = $.Deferred();
    var csrfToken = '';
    var el = document.querySelector('#csrfToken');
    if (el) csrfToken = el.value;
    var data = { bjdm: ` + JSON.stringify(bjdm) + `, lx: "` + CONFIG.courseLx + `", csrfToken: csrfToken };
    (` + addSecretKeyJs + `)(data, window.location.search);
    $.ajax({
      url: BaseUrl + "/sys/xsxkapp/xsxkCourse/choiceCourse.do?_=" + Date.now(),
      cache: false, dataType: "json",
      data: data,
      type: "post",
      success: function(res) { d.resolve(JSON.stringify(res)); },
      error: function(xhr, s, e) { d.resolve(JSON.stringify({ code: 0, error: String(e) })); }
    });
    return d.promise();
  })()`);
  return JSON.parse(result);
}

// 页面加载时间跟踪：token 年龄基准（每次 gotoAndWait/rebuildTab 后重置）
let tokenBornAt = 0;  // 当前页面 token 的"出生"时间戳（ms）
let lastTokenVerifiedAt = 0;  // 最近一次探针实测确认 token 有效的时间戳（ms）
const TOKEN_TTL_MS = 75 * 1000;  // 实测 TTL 波动：8-27 为 180s 有效/228s 失效；8-29 实测 107s 已失效 → 保守 75s

function isTokenFresh(bornAt, now) {
  const current = now === undefined ? Date.now() : now;
  return Number.isFinite(bornAt) && bornAt > 0 && current >= bornAt && current - bornAt < TOKEN_TTL_MS;
}

// 提交后校验：若返回"页面已过期"（csrfToken 过期），立即重建页签刷新 token，并标记需要重试
async function submitChoiceWithRecovery(bjdm, groupName) {
  // token 保鲜：页面加载超 TOKEN_TTL_MS（实测 TTL ~3 分钟）先重建，避免提交必死
  let res = await submitChoice(bjdm);
  let msg = String(res.msg || res.error || '');
  if (res.code === 0 && msg.indexOf('页面已过期') >= 0) {
    log('⚠️ 页面已过期（csrfToken 失效），重建页签并等待 token 就绪后立即重试...');
    const refreshed = await rebuildTab();
    if (!refreshed) {
      log('❌ csrfToken 刷新失败，本次不重试，避免用无效 token 重复提交');
      return { code: 0, msg: 'csrfToken 刷新失败，未重试' };
    }
    // token 已刷新，同一次调用内立即重试（不再等下一轮——空位可能瞬间消失）
    res = await submitChoice(bjdm);
    msg = String(res.msg || res.error || '');
    log(`重试提交: ${JSON.stringify(res)}`);
  }
  return res;
}

// 等待 #csrfToken 注入就绪（页面加载完 → 服务端 token 注入有异步延迟，最多 30s）
async function waitForTokenReady() {
  for (let i = 0; i < 15; i++) {
    await wait(2);
    try {
      const r = await js(`(() => {
        var el = document.querySelector('#csrfToken');
        return JSON.stringify({has: !!el, len: el ? el.value.length : 0});
      })()`);
      const s = JSON.parse(r);
      if (s.has && s.len >= 16) { log(`✅ token 就绪 (${s.len}位)`); return true; }
    } catch(e) {}
  }
  log('⚠️ token 30s 未就绪');
  return false;
}

async function pollResultOnce(xid, retryCount) {
  // ★ 对齐官方前端：后续轮询 sfhqdqxkqqs=1 概率 40%（官方 >=6/10，原为 >=7 是 30%）
  const sfhqdqxkqqs = (retryCount === 0) ? 1 : (Math.random() * 10 >= 6 ? 1 : 0);
  const result = await js(String.raw`(() => {
    var d = $.Deferred();
    $.ajax({
      url: BaseUrl + "/sys/xsxkapp/xsxkCourse/loadXkjgRes.do?_=" + Date.now(),
      cache: false, dataType: "json",
      data: { xid: ` + JSON.stringify(xid) + `, sfhqdqxkqqs: ` + sfhqdqxkqqs + ` },
      type: "post",
      success: function(res) { d.resolve(JSON.stringify(res)); },
      error: function(xhr, s, e) { d.resolve(JSON.stringify({ msg: "", error: String(e) })); }
    });
    return d.promise();
  })()`);
  const res = JSON.parse(result);
  if (res.msg) {
    try { const r = JSON.parse(res.msg); return { success: r.code === 1, message: r.msg || '' }; }
    catch(e) { return { success: false, message: '解析失败: ' + res.msg }; }
  } else if (retryCount >= CONFIG.resultMaxRetries) {
    return { success: false, message: '超时，请在已选课程中确认' };
  }
  return null;
}

async function refreshPage() {
  await gotoAndWait(CONFIG.courseUrl, { timeout: 30, settle: 5 });
  await wait(3);
  log('🔄 页面已刷新');
}

// 重建页签：Ego 长时间运行的页签渲染进程会卡死（JS 永不响应，Runtime.evaluate 全超时），
// 刷新(gotoAndWait)反而会触发/加剧卡死。关闭重开是唯一解药（实测：卡死页签关闭重开后 JS 4ms 恢复）。
async function rebuildTab() {
  try {
    const tabs = await listTabs();
    const oldTab = tabs.find(t => t.url && t.url.includes('xsxkapp') && (t.url.includes('course') || t.url.includes('index')));
    if (oldTab) {
      try { await closeTab(oldTab.targetId); } catch(e) {}
      log('🧹 关闭卡死页签');
    }
    await wait(2);
    await useOrCreateTaskSpace(CONFIG.taskSpaceName);
    const pageNavigationStartedAt = Date.now();
    await openOrReuseTab(CONFIG.courseUrl, { wait: true, timeout: 45 });
    // 等待页面环境就绪（jQuery + BaseUrl 加载完成，load 事件后可能仍需数秒）
    let ready = false;
    for (let i = 0; i < 15; i++) {
      await wait(2);
      try {
        const r = await js(`JSON.stringify({jq: typeof $ !== 'undefined' && typeof $.ajax === 'function', base: typeof BaseUrl !== 'undefined' && !!BaseUrl})`);
        const s = JSON.parse(r);
        if (s.jq && s.base) { ready = true; break; }
      } catch(e) {}
    }
    // 等待 csrfToken 注入就绪（提交必需，独立于 jQuery 加载）
    const tokenReady = await waitForTokenReady();
    if (!ready || !tokenReady) {
      log('❌ 重建后页面环境或 csrfToken 未就绪，本次重建判定失败');
      return false;
    }
    const nt = await listTabs();
    const tab = nt.find(t => t.url && t.url.includes('xsxkapp') && t.url.includes('course'));
    if (tab) { await switchTab(tab.targetId); courseTabId = tab.targetId; }
    tokenBornAt = pageNavigationStartedAt;  // 从导航开始保守计龄，不把环境/token 等待时间漏掉
    lastTokenVerifiedAt = Date.now();
    log('🔄 页签已重建' + (ready ? '' : '（环境未就绪）'));
    return true;
  } catch (e) {
    log('❌ 页签重建失败: ' + String(e.message || e).slice(0, 100));
    return false;
  }
}

async function injectPanel() {
  try {
    await js(String.raw`(() => {
      if (window.__daemonPanel) return;
      window.__daemonPanel = true;
      window.__daemonState = { running: false, succeeded: false, expired: false };
      var p = document.createElement('div');
      p.id = 'daemon-panel';
      p.style.cssText = 'position:fixed;top:12px;right:12px;z-index:999999;width:400px;background:rgba(18,20,26,0.96);color:#e0e0e0;border:1px solid rgba(100,160,255,0.35);border-radius:10px;padding:0;font-family:-apple-system,"PingFang SC",sans-serif;font-size:13px;box-shadow:0 8px 32px rgba(0,0,0,0.4);backdrop-filter:blur(8px)';
      p.innerHTML = '<div style="background:linear-gradient(135deg,#1a3a5c,#2d5a8a);padding:8px 14px;border-radius:10px 10px 0 0;font-weight:600;color:#8fc4ff;display:flex;align-items:center;gap:6px">'
        + '<span id="daemon-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#666;transition:all 0.3s"></span>'
        + '后台守护·Course Raider</div>'
        + '<div style="padding:10px 14px">'
        + '<div id="daemon-info" style="margin:4px 0;padding:6px 8px;background:rgba(255,255,255,0.05);border-radius:6px;font-size:12px;color:#aaa">等待查询...</div>'
        + '<div id="daemon-status" style="margin:4px 0;padding:6px 8px;background:rgba(255,255,255,0.03);border-radius:6px;font-size:12px;color:#888">初始化...</div>'
        + '</div>';
      document.body.appendChild(p);
      setInterval(function(){
        var dot = document.getElementById('daemon-dot');
        if (!dot) return;
        var st = window.__daemonState;
        if (st.expired) { dot.style.background='#ef4444'; dot.style.boxShadow='0 0 8px #ef4444'; dot.style.opacity=(Math.sin(Date.now()/200)+1)/2*0.7+0.3; }
        else if (st.succeeded) { dot.style.background='#22c55e'; dot.style.boxShadow='0 0 12px #22c55e'; dot.style.opacity='1'; }
        else if (st.running) { dot.style.background='#4ade80'; dot.style.boxShadow='0 0 8px #4ade80'; dot.style.opacity=(Math.sin(Date.now()/500)+1)/2*0.6+0.4; }
        else { dot.style.background='#666'; dot.style.opacity='0.5'; }
      }, 200);
    })()`);
  } catch(e) {}
}

async function updatePanel(statusText, infoText, running, succeededVal, expiredVal) {
  try {
    await js(String.raw`(() => {
      var s = document.getElementById('daemon-status');
      var i = document.getElementById('daemon-info');
      if (s) s.textContent = ` + JSON.stringify(statusText||'') + `;
      if (i) i.innerHTML = ` + JSON.stringify(infoText||'') + `;
      window.__daemonState = { running: ` + (running?'true':'false') + `, succeeded: ` + (succeededVal?'true':'false') + `, expired: ` + (expiredVal?'true':'false') + ` };
    })()`);
  } catch(e) {}
}

async function resumeAfterLogin() {
  // 自动登录成功后：回到课程页，恢复监控，清理多余页签
  const pageNavigationStartedAt = Date.now();
  try { await gotoAndWait(CONFIG.courseUrl, { timeout: 30, settle: 5 }); await wait(3); } catch(e) {}
  if (!await waitForTokenReady()) {
    log('❌ 登录后课程页 csrfToken 未就绪，暂不恢复提交');
    return false;
  }
  tokenBornAt = pageNavigationStartedAt;  // 从导航开始保守计龄，不把等待时间漏掉
  lastTokenVerifiedAt = Date.now();
  await injectPanel();
  await cleanupExtraTabs();
  sessionState = 'normal'; sessionExpiredSince = null; consecutiveErrors = 0; autoLoginTriedAt = 0;
  log('✅ 会话已恢复，继续监控（csrfToken 已随页面重新注入）');
  notify('✅ 自动登录成功', '监控已恢复', 'Glass');
  return true;
}

async function handleSessionExpired(reason) {
  if (sessionState !== 'expired') {
    sessionState = 'expired'; sessionExpiredSince = Date.now();
    log(`🚨🚨🚨 会话已过期! 原因: ${reason}`);
    if (CONFIG.autoRelogin) {
      log(`🚨 正在尝试自动重登录（失败会定期重试，也可到 Ego Browser 手动登录）。`);
      notify('🚨 选课会话已过期!', '正在尝试自动重登录', 'Basso'); beep(5);
      const ok = await autoLogin();
      if (ok) {
        const resumed = await resumeAfterLogin();
        if (resumed) return true;
        log('⚠️ 登录成功但课程页 token 未就绪，等待页面恢复后再检查，不立即重复登录');
      }
      autoLoginTriedAt = Date.now();
      log(ok ? '🔑 课程页尚未恢复，将定期检查。' : '🔑 自动登录未成功，将定期重试。');
    } else {
      log(`🚨 请到 Ego Browser 重新登录！登录后自动恢复。`);
      notify('🚨 选课会话已过期!', '请到 Ego Browser 重新登录', 'Basso'); beep(5);
    }
  } else if (CONFIG.autoRelogin && Date.now() >= lockPausedUntil && Date.now() - autoLoginTriedAt > CONFIG.loginRetryInterval * 1000) {
    autoLoginTriedAt = Date.now();
    log('🔄 再次尝试自动重登录...');
    const ok = await autoLogin();
    if (ok) return await resumeAfterLogin();
  }
  if (Date.now() - lastNotifyTime > 30000) {
    const el = Math.floor((Date.now() - sessionExpiredSince) / 1000);
    notify('🚨 仍未登录', `已过期 ${el}s`, 'Basso'); beep(3); lastNotifyTime = Date.now();
  }
  try {
    const s = await checkSession();
    if (s.status === 'valid') {
      log('✅ 会话恢复!'); notify('✅ 会话恢复', '监控自动恢复', 'Glass');
      sessionState = 'normal'; sessionExpiredSince = null; consecutiveErrors = 0; autoLoginTriedAt = 0;
      await injectPanel(); return true;
    }
  } catch(e) {}
  return false;
}

async function handleUserControl(reason) {
  if (sessionState !== 'user_control') {
    sessionState = 'user_control';
    log('⏸️ 检测到用户正在控制或任务空间未分配，监控暂停；不会自动抢回浏览器控制权。');
  }
  // Retry only through the normal, non-stealing path on the next cycle.
  // If the user hands the space back, ensureTab() will succeed naturally.
  return false;
}

/**
 * 尝试抢一个空位
 * 返回 true 表示成功
 */
async function trySnipe(vacancy, groupName) {
  if (selecting) return false;
  selecting = true;
  log(`⚡ 提交选课: ${vacancy.name} [${groupName}] (bjdm=${vacancy.bjdm.substring(0,16)}...)`);
  try {
    // ★ 最终 freshness guard（审查修正）：第一门 xid 轮询可能耗时几十秒，
    //   同一轮第二/三门提交时 token 可能已超龄——每次提交前重新检查，刷新失败则跳过。
    if (!isTokenFresh(tokenBornAt)) {
      log('⏳ 提交前 token 超龄，重建刷新后重试...');
      const refreshed = await rebuildTab();
      if (!refreshed) {
        log('❌ 提交前 token 刷新失败，跳过本次提交');
        return false;
      }
      tokenBornAt = Date.now();
      await injectPanel();
    }
    const submitRes = await submitChoiceWithRecovery(vacancy.bjdm, groupName);
    log(`选课提交: ${JSON.stringify(submitRes)}`);

    if (submitRes.code === 0) {
      log(`❌ 提交失败: ${submitRes.msg || submitRes.error || ''}`);
      notify('❌ 抢课失败', `${vacancy.name}: ${submitRes.msg||submitRes.error||''}`, 'Basso');
      return false;
    }

    const xid = submitRes.msg;
    log(`⏳ 等待结果 (xid=${String(xid).substring(0,16)}...)`);
    let rc = 0, result = null;
    while (rc < CONFIG.resultMaxRetries) {
      try { result = await pollResultOnce(xid, rc); } catch(e) { result = { success: false, message: '异常: ' + e.message }; break; }
      if (result !== null) break;
      rc++; await wait(CONFIG.resultPollBase + Math.random() * 2);
    }

    if (result && result.success) {
      log(`✅✅✅ 选课成功! ${vacancy.name} [${groupName}] — ${result.message}`);
      notify('✅✅✅ 抢课成功!', `${vacancy.name} [${groupName}]`, 'Glass'); beep(10);
      return true;
    }
    log(`❌ 选课失败: ${result ? result.message : '超时'}`);
    notify('❌ 抢课失败', result ? result.message : '超时', 'Basso'); beep(3);
    return false;
  } catch (e) {
    log(`❌ 抢课异常: ${String(e.message || e)}`);
    notify('❌ 抢课异常', `${vacancy.name}: ${String(e.message || e)}`, 'Basso');
    return false;
  } finally {
    selecting = false;
  }
}

async function pollOnce() {
  pollCount++;
  const tabOk = await ensureTab();
  if (tabOk === 'user_control') { await handleUserControl('ensureTab'); return; }
  if (!tabOk) { consecutiveErrors++; if (consecutiveErrors >= 5) { try { await rebuildTab(); consecutiveErrors = 0; } catch(e) {} } return; }

  // ★ session 归一化（审查修正）：必须在保鲜之前——从 user_control/expired 恢复时，
  //   旧代码先跳过保鲜（非 normal），随后才归一化并立即查询提交，可能用 4369s 旧 token。
  if (pollCount % 3 === 0 || sessionState !== 'normal') {
    const session = await checkSession();
    if (session.status === 'user_control') { await handleUserControl(session.reason); return; }
    if (session.status === 'expired') { await handleSessionExpired(session.reason); await updatePanel('🚨 会话过期!', '', false, false, true); return; }
    if (session.status === 'error') { consecutiveErrors++; if (consecutiveErrors >= 3) { await wait(3); try { await rebuildTab(); await injectPanel(); consecutiveErrors = 0; } catch(e) {} } return; }
    if (sessionState !== 'normal') { log('✅ 会话正常'); sessionState = 'normal'; }
  }

  // ★ csrfToken 保鲜（审查修正：从"提交时"移到"查询前"）：
  //   空位出现时才重建会把 6-10s 延迟放进最稀缺的提交窗口；改为每轮查询前检查，
  //   无空位阶段提前重建，空位出现时 token 必然新鲜，提交零延迟。
  //   纯时间判断（tokenBornAt 导航开始计龄），不再使用写探针（choiceCourse 探针有误选风险）。
  //   重建失败必须禁止本轮提交（token 不可信时提交必败，还可能白送空位窗口）。
  if (sessionState === 'normal' && !selecting && !isTokenFresh(tokenBornAt)) {
    const ageText = tokenBornAt > 0 ? Math.round((Date.now() - tokenBornAt) / 1000) + 's' : '未知';
    log('⏳ csrfToken 提前保鲜（页面 token 年龄 ' + ageText + '），无空位阶段重建页签...');
    const refreshed = await rebuildTab();
    if (!refreshed) {
      log('❌ csrfToken 刷新失败，本轮跳过（token 不可信，禁止提交）');
      return;
    }
    await injectPanel();
  }

  let res;
  try { res = await queryCourses(); }
  catch(e) {
    consecutiveErrors++;
    const msg = String(e.message||e);
    if (msg.includes('user is controlling') || msg.includes('not assigned')) { await handleUserControl(msg); return; }
    log(`查询异常: ${msg} (${consecutiveErrors}次)`);
    if (consecutiveErrors >= 3) { try { await rebuildTab(); await injectPanel(); consecutiveErrors = 0; } catch(e2) {} }
    return;
  }
  consecutiveErrors = 0;

  if (!res.ok) {
    log(`查询失败: ${res.error||''} http=${res.httpCode||''}`);
    if (res.httpCode === 302 || res.httpCode === 403 || res.httpCode === 401 || (res.body && res.body.includes('login')) || (res.error||'').includes('Unauthorized')) {
      await handleSessionExpired('ajax_unauthorized'); await updatePanel('🚨 会话过期!', '', false, false, true);
    } else { try { await rebuildTab(); await injectPanel(); } catch(e) {} }
    return;
  }

  // 构建状态显示
  let statusParts = [];
  let infoHtml = '<table style="width:100%;border-collapse:collapse">';
  for (let gi = 0; gi < res.groups.length; gi++) {
    const g = res.groups[gi];
    const done = groupSuccess[gi];
    for (const c of g.classes) {
      const tag = done ? '✅已抢' : (c.hasVacancy && !c.conflict ? '🟢空位' : (c.full ? '满' : '空'));
      const conflictMark = c.conflict ? '⚠' : '✓';
      const color = done ? '#22c55e' : (c.hasVacancy && !c.conflict ? '#4ade80' : (c.full ? '#f87171' : '#fbbf24'));
      infoHtml += `<tr><td style="padding:2px 4px;color:#aaa">${escHtml(c.name)}</td><td style="padding:2px 4px;color:${color}">${c.dqrs}/${c.kxrs} ${tag}</td><td style="padding:2px 4px">${conflictMark}</td></tr>`;
      statusParts.push(`${c.name}: ${c.dqrs}/${c.kxrs}${done?'✅':(c.full?'满':'空')}${c.conflict?'⚠':'✓'}`);
    }
  }
  infoHtml += '</table>';

  // 检测空位并尝试抢课
  // 三门独立：P0 抢失败不阻塞 P1/P2（每轮依次尝试所有有空位的组）
  for (let gi = 0; gi < res.groups.length; gi++) {
    if (groupSuccess[gi]) continue; // 该组已成功

    const g = res.groups[gi];
    // 每组独立抢（每组成单课程，无需组内排序）
    // TEST- 前缀组忽略冲突过滤（用于验证提交链路——冲突课提交会到业务层）
    let candidates = g.classes.filter(c => c.hasVacancy && (g.name.indexOf('TEST-') === 0 || !c.conflict));

    if (candidates.length > 0) {
      const vacancy = candidates[0];
      // ★ 零延迟提交（审查修正）：先发选课请求，再通知/蜂鸣/UI——通知阻塞会浪费短暂空位窗口
      log(`🎯 发现空位! ${vacancy.name} [${g.name}] (${vacancy.dqrs}/${vacancy.kxrs})`);
      const success = await trySnipe(vacancy, g.name);
      // 非关键通知放到请求之后
      notify('🎯 已抢课!', `${vacancy.name} [${g.name}]`, 'Glass'); beep(5);
      await updatePanel(`⚡ 抢课: ${vacancy.name}`, infoHtml, true, false);
      if (success) {
        groupSuccess[gi] = true;
        groupFailCount[gi] = 0;
        await updatePanel(`✅ ${vacancy.name} 抢到!`, infoHtml, false, allDone());
        if (allDone()) {
          log('═══════════════════════════════════════════');
          log('  ✅ 所有任务完成! 停止监控。');
          log('═══════════════════════════════════════════');
          notify('🎉 三门课全部抢到!', '脚本已停止，可以退密码学了', 'Glass'); beep(10);
          return;
        } else {
          log(`✅ ${g.name} 完成，继续监控其他组...`);
        }
      } else {
        // 抢课失败：先确认是否其实已选上（提交成功但结果超时的情况）
        groupFailCount[gi]++;
        const synced = await syncSelectedGroups();
        if (synced && groupSuccess[gi]) {
          log(`✅ ${g.name} 实际已选上（结果超时误判），标记成功`);
          groupFailCount[gi] = 0;
          if (allDone()) {
            log('═══════════════════════════════════════════');
            log('  ✅ 所有任务完成! 停止监控。');
            log('═══════════════════════════════════════════');
            notify('🎉 三门课全部抢到!', '脚本已停止，可以退密码学了', 'Glass'); beep(10);
            return;
          }
          continue;
        }
        if (groupFailCount[gi] >= 5) {
          log(`🚨🚨 ${g.name} 连续失败 ${groupFailCount[gi]} 次，请人工检查!`);
          notify('🚨 抢课连续失败', `${g.name} 失败 ${groupFailCount[gi]} 次，需要人工介入`, 'Basso'); beep(10);
          groupFailCount[gi] = 0;
        }
      }
      // 失败不 return：继续检查下一组（P0 失败不阻塞 P1/P2）
    }
  }

  // 无空位
  log(`#${pollCount} ${statusParts.join(' | ')}`);
  await updatePanel(`第${pollCount}轮 [${new Date().toLocaleTimeString('zh-CN',{hour12:false})}]`, infoHtml, true, false, false);
}

(async function main() {
  try { writeFileSync(LOG_FILE, ''); } catch(e) {}
  log('═══════════════════════════════════════════════════');
  log('  YNU Course Raider — 目标课程全抢');
  log(`  G0/G1/G2: 三组必抢（修改 CONFIG.groups 配置你的课程）`);
  log(`  轮询: ${CONFIG.pollInterval}s | 全量查询不污染搜索框`);
  log('═══════════════════════════════════════════════════');

  const initialTab = await ensureTab();
  if (initialTab === 'user_control') {
    log('⏸️ 初始任务空间由用户控制，等待用户交还后再开始。');
  } else if (!initialTab) {
    log('❌ 无法连接'); return;
  } else {
    await cleanupExtraTabs();
    await injectPanel();
    await syncSelectedGroups();
    if (!allDone()) await pollOnce();
  }

  while (!allDone()) {
    if (sessionState === 'expired') await wait(5);
    else if (sessionState === 'user_control') await wait(3);
    else await wait(CONFIG.pollInterval);
    if (selecting || allDone()) continue;
    try { await pollOnce(); }
    catch(e) {
      const msg = String(e.message||e);
      if (msg.includes('user is controlling') || msg.includes('not assigned')) { await handleUserControl(msg); }
      else { log(`轮询异常: ${msg}`); consecutiveErrors++;
        if (consecutiveErrors >= 5) { try { await rebuildTab(); await injectPanel(); consecutiveErrors = 0; } catch(e2) {} }
        await wait(2);
      }
    }
    // 预防性定期重建：Ego 渲染进程长时间运行会卡死（02:10 实测：8.5h 后刷新触发永久超时），
    // 每 rebuildIntervalPolls 轮主动重建页签，把损失控制在几秒而非几十分钟
    if (sessionState === 'normal' && pollCount > 0 && pollCount % CONFIG.rebuildIntervalPolls === 0 && !selecting && !allDone()) {
      log('🔄 预防性重建页签...'); try { await rebuildTab(); await injectPanel(); } catch(e) {}
    }
  }
  log('守护进程结束。所有任务完成。');
})().catch(err => { log('致命错误: ' + (err.message||err)); notify('❌ 崩溃', err.message||'', 'Basso'); });
