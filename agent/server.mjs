import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = Number.parseInt(process.env.AC_AGENT_PORT ?? '47821', 10);
const VERSION = '0.1.0';
const OPENCODE_HEALTH_URL = 'http://127.0.0.1:4096/global/health';
const OPENCODE_TIMEOUT_MS = 2000;
const OPENCODE_BASE_URL = 'http://127.0.0.1:4096';
const OPENCODE_SESSION_URL = `${OPENCODE_BASE_URL}/session`;

// Espelha a regra do health check: HTTP 2xx + healthy === true.
// Retorna também a versão para a extensão exibir sem acessar o OpenCode.
// Qualquer falha (ECONNREFUSED, timeout, JSON inválido, HTTP inesperado)
// resulta em { connected: false, version: '' }. Nunca rejeita.
function checkOpenCode() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const failed = () => done({ connected: false, version: '' });
    const req = http.get(
      OPENCODE_HEALTH_URL,
      { timeout: OPENCODE_TIMEOUT_MS },
      (res) => {
        const okStatus =
          (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
          if (raw.length > 65536) {
            req.destroy();
          }
        });
        res.on('end', () => {
          if (!okStatus) {
            failed();
            return;
          }
          try {
            const data = JSON.parse(raw);
            if (data !== null && data.healthy === true) {
              done({
                connected: true,
                version:
                  typeof data.version === 'string' ? data.version : '',
              });
            } else {
              failed();
            }
          } catch {
            failed();
          }
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => failed());
    req.on('close', () => failed());
  });
}

// OpenCode gerenciado pelo Agent (ponto único de entrada no Windows).
// Resolução rápida do binário, sem WMI: AC_OPENCODE_BIN explícito,
// caminho padrão do npm global e where.exe. Binário ausente nunca
// derruba o Agent (installed=false, connected=false).
const OPENCODE_HOST = '127.0.0.1';
const OPENCODE_PORT = 4096;
const OPENCODE_SERVE_TIMEOUT_MS = 15000;
let opencodeBinCache = null; // null = ainda não resolvido; '' = ausente
let opencodeEnsureInFlight = false;

async function fileExistsQuick(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveOpencodeBin() {
  if (opencodeBinCache !== null) {
    return opencodeBinCache === '' ? null : opencodeBinCache;
  }
  const configured = (process.env.AC_OPENCODE_BIN ?? '').trim();
  if (configured.length > 0) {
    // Config explícito vence a descoberta (permite simular ausência).
    opencodeBinCache = (await fileExistsQuick(configured)) ? configured : '';
    return opencodeBinCache === '' ? null : opencodeBinCache;
  }
  const appData = process.env.APPDATA ?? '';
  if (appData.length > 0) {
    const npmBin = path.join(
      appData,
      'npm',
      'node_modules',
      'opencode-ai',
      'bin',
      'opencode.exe',
    );
    if (await fileExistsQuick(npmBin)) {
      opencodeBinCache = npmBin;
      return npmBin;
    }
  }
  const found = await new Promise((resolve) => {
    execFile(
      'where.exe',
      ['opencode.exe'],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const first =
          String(stdout ?? '')
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0)[0] ?? null;
        resolve(first);
      },
    );
  });
  if (found !== null && (await fileExistsQuick(found))) {
    opencodeBinCache = found;
    return found;
  }
  opencodeBinCache = '';
  return null;
}

function sleepMs(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Garante o OpenCode server sem duplicar: reutiliza se o health já
// responde; nunca espera o processo terminar; sem janela de console
// (detached + windowsHide). Falha silenciosa: Agent segue online.
async function ensureOpenCodeServer() {
  if (opencodeEnsureInFlight) {
    return;
  }
  opencodeEnsureInFlight = true;
  try {
    const live = await checkOpenCode();
    if (live.connected) {
      return;
    }
    const bin = await resolveOpencodeBin();
    if (bin === null) {
      return;
    }
    const recheck = await checkOpenCode();
    if (recheck.connected) {
      return;
    }
    let child = null;
    try {
      child = spawn(
        bin,
        ['serve', '--hostname', OPENCODE_HOST, '--port', String(OPENCODE_PORT)],
        { detached: true, stdio: 'ignore', windowsHide: true },
      );
    } catch {
      child = null;
    }
    if (child === null) {
      return;
    }
    child.on('error', () => {});
    child.unref();
    const deadline = Date.now() + OPENCODE_SERVE_TIMEOUT_MS;
    for (;;) {
      await sleepMs(500);
      const again = await checkOpenCode();
      if (again.connected) {
        return;
      }
      if (Date.now() >= deadline) {
        return;
      }
    }
  } finally {
    opencodeEnsureInFlight = false;
  }
};

// Constantes espelho de entrypoints/sidepanel/App.tsx (manter sincronizado).
// O agente as aplica localmente para a extensão não precisar conhecer a API 4096.
const TASK_TITLE = 'Lovable Code Assistant - Teste';
const TASK_SESSION_TIMEOUT_MS = 10000;
const TASK_MESSAGE_TIMEOUT_MS = 120000;
const TASK_MESSAGES_TIMEOUT_MS = 10000;
const TASK_MAX_INSTRUCTION = 8000;
const TASK_MAX_BODY_BYTES = 65536;
const TASK_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_COMMIT_MESSAGE = 500;
const MAX_DIFF_LINES_PER_FILE = 200;
const MAX_DIFF_TOTAL_CHARS = 100000;
const MAX_NEW_FILE_BYTES = 524288;
const AI_MODEL = {
  providerID: 'opencode',
  modelID: 'muse-spark-1.3-contributor-free',
};
const AI_VARIANT = 'medium';
// Catálogo dinâmico de modelos (GET /ai/models repassa GET /provider).
// isFree vem de cost real (input/output zerados). Sem lista hardcoded.
const AI_MODELS_TIMEOUT_MS = 15000;
const AI_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const AI_VARIANT_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// Seleção de modelo/variant vinda da UI (opcional). Inválida => padrão.
function resolveTaskModel(payload) {
  let providerID = AI_MODEL.providerID;
  let modelID = AI_MODEL.modelID;
  let variant = AI_VARIANT;
  try {
    const m = payload && payload.model;
    if (
      m &&
      typeof m.providerID === 'string' &&
      AI_ID_PATTERN.test(m.providerID) &&
      typeof m.modelID === 'string' &&
      AI_ID_PATTERN.test(m.modelID)
    ) {
      providerID = m.providerID;
      modelID = m.modelID;
    }
    if (
      payload &&
      typeof payload.variant === 'string' &&
      AI_VARIANT_PATTERN.test(payload.variant)
    ) {
      variant = payload.variant;
    }
  } catch {
    // fallback padrão abaixo
  }
  return { model: { providerID, modelID }, variant };
}

// Limite de uso do modelo: HTTP 429 ou marcadores reais do OpenCode
// (FreeUsageLimitError = cota free; GoUsageLimitError = cota de uso).
// Erros genéricos NÃO são tratados como limite.
function isModelLimitError(statusCode, text) {
  if (statusCode === 429) {
    return true;
  }
  if (typeof text !== 'string' || text.length === 0) {
    return false;
  }
  return (
    text.includes('FreeUsageLimitError') || text.includes('GoUsageLimitError')
  );
}

async function handleAiModels(req, res) {
  try {
    const r = await opencodeRequest(
      'GET',
      `${OPENCODE_BASE_URL}/provider`,
      undefined,
      AI_MODELS_TIMEOUT_MS,
    );
    if (r.networkError) {
      sendJson(res, 502, { success: false, error: 'OPENCODE_UNAVAILABLE' });
      return;
    }
    if (r.statusCode < 200 || r.statusCode >= 300) {
      sendJson(res, 502, { success: false, error: 'OPENCODE_ERROR' });
      return;
    }
    let data = null;
    try {
      data = JSON.parse(r.text);
    } catch {
      data = null;
    }
    const all = data && Array.isArray(data.all) ? data.all : [];
    const connected =
      data && Array.isArray(data.connected) ? data.connected : [];
    const models = [];
    for (const p of all) {
      if (!p || typeof p !== 'object' || typeof p.id !== 'string') {
        continue;
      }
      if (!connected.includes(p.id)) {
        continue;
      }
      const entries =
        p.models && typeof p.models === 'object'
          ? Object.entries(p.models)
          : [];
      for (const [key, m] of entries) {
        if (!m || typeof m !== 'object') {
          continue;
        }
        if (typeof m.status === 'string' && m.status !== 'active') {
          continue;
        }
        const modelID =
          typeof m.id === 'string' && m.id.length > 0 ? m.id : key;
        const providerID =
          typeof m.providerID === 'string' && m.providerID.length > 0
            ? m.providerID
            : p.id;
        const variants =
          m.variants && typeof m.variants === 'object'
            ? Object.keys(m.variants)
            : [];
        const costIn =
          m.cost && typeof m.cost.input === 'number' ? m.cost.input : NaN;
        const costOut =
          m.cost && typeof m.cost.output === 'number' ? m.cost.output : NaN;
        models.push({
          providerID,
          providerName: typeof p.name === 'string' ? p.name : p.id,
          modelID,
          name:
            typeof m.name === 'string' && m.name.length > 0
              ? m.name
              : modelID,
          variants,
          cost: {
            input: Number.isFinite(costIn) ? costIn : null,
            output: Number.isFinite(costOut) ? costOut : null,
          },
          isFree: costIn === 0 && costOut === 0,
        });
      }
    }
    models.sort(
      (a, b) =>
        Number(b.isFree) - Number(a.isFree) || a.name.localeCompare(b.name),
    );
    sendJson(res, 200, { success: true, models });
  } catch {
    try {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
    } catch {
      // processo segue ativo mesmo se a resposta falhar
    }
  }
}
const AI_TOOLS = {
  invalid: false,
  question: false,
  bash: true,
  read: true,
  glob: true,
  grep: false,
  edit: true,
  write: true,
  task: false,
  webfetch: false,
  todowrite: false,
  websearch: false,
  skill: false,
  apply_patch: false,
};
// Permissões de sessão montadas POR TAREFA com escopo do workspace.
// Ordem (última regra coincidente vence): negação ampla, liberações,
// negações de sensíveis/destrutivas. read/glob/edit/write só valem dentro
// do workspace. bash: somente CLIs de projeto (leitura git + runtimes);
// git escrita continua exclusiva dos endpoints do agent (identidade,
// divergência, OAuth isolado); comandos destrutivos sempre negados.
// Semântica OpenCode: pattern casa o comando parseado (ex. "npm run dev").
// Shell executa no diretório da sessão (workspace); external_directory segue negado.
// Permissões do Windows intactas; sem ExecutionPolicy como solução (irrelevante aqui).
const BASH_ALLOW_PATTERNS = [
  'node *',
  'npm *',
  'npx *',
  'bun *',
  'bunx *',
  'pnpm *',
  'yarn *',
  'vite *',
  'tsc *',
  'eslint *',
  'prettier *',
  'git status *',
  'git diff *',
  'git log *',
  'git branch *',
  'git remote *',
  'git rev-parse *',
  'git show *',
  'gh *',
  'dir *',
  'echo *',
  'where *',
  'set *',
  'cd *',
  'mkdir *',
  'type *',
  'code *',
];
// Negados DEPOIS dos allows (vencem): destrutivos + git escrita (via agent).
const BASH_DENY_PATTERNS = [
  'rm *',
  'rmdir *',
  'rd *',
  'del *',
  'erase *',
  'format *',
  'shutdown *',
  '*rm -rf*',
  'git push *',
  'git reset *',
  'git clean *',
  'git checkout *',
  'git restore *',
  'git commit *',
  'git add *',
];
const SENSITIVE_PATTERNS = [
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  '*.pem',
  '**/*.pem',
  '*.key',
  '**/*.key',
  '*.p12',
  '**/*.p12',
  '*.pfx',
  '**/*.pfx',
  'id_rsa',
  '**/id_rsa',
  'id_ed25519',
  '**/id_ed25519',
  '**/.ssh/**',
  '**/secrets/**',
  '**/.git/**',
];

function buildSessionPermission(ws) {
  const scope = `${ws.replace(/\\/g, '/')}/**`;
  const rules = [
    { permission: 'external_directory', pattern: '*', action: 'deny' },
  ];
  for (const tool of ['read', 'glob', 'edit', 'write']) {
    rules.push({ permission: tool, pattern: '*', action: 'deny' });
    rules.push({ permission: tool, pattern: scope, action: 'allow' });
    for (const pattern of SENSITIVE_PATTERNS) {
      rules.push({ permission: tool, pattern, action: 'deny' });
    }
  }
  for (const tool of [
    'grep',
    'task',
    'webfetch',
    'websearch',
    'skill',
    'question',
  ]) {
    rules.push({ permission: tool, pattern: '*', action: 'deny' });
  }
  // bash: nega tudo, libera CLIs de projeto e renega destrutivos/git escrita.
  rules.push({ permission: 'bash', pattern: '*', action: 'deny' });
  for (const pattern of BASH_ALLOW_PATTERNS) {
    rules.push({ permission: 'bash', pattern, action: 'allow' });
  }
  for (const pattern of BASH_DENY_PATTERNS) {
    rules.push({ permission: 'bash', pattern, action: 'deny' });
  }
  return rules;
}

function unquoteGitPath(p) {
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    try {
      return JSON.parse(p);
    } catch {
      return p.slice(1, -1);
    }
  }
  return p;
}

function isSensitiveRelPath(rel) {
  const lower = rel.toLowerCase();
  const base = lower.split('/').pop() ?? '';
  if (/(^|\/)\.env(\.|$)/.test(lower)) {
    return true;
  }
  if (lower.startsWith('.ssh/') || lower.includes('/.ssh/')) {
    return true;
  }
  if (lower.startsWith('secrets/') || lower.includes('/secrets/')) {
    return true;
  }
  if (/(^|\/)\.git(\/|$)/.test(lower)) {
    return true;
  }
  if (/\.(pem|key|p12|pfx)$/.test(base)) {
    return true;
  }
  return base === 'id_rsa' || base === 'id_ed25519';
}

// Normaliza `git status --porcelain`: paths relativos ao workspace,
// status em modified/added/deleted/untracked. Nunca rejeita.
function parseGitChanges(output) {
  const files = [];
  for (let line of output.split('\n')) {
    line = line.replace(/\r$/, '');
    if (line.length < 4) {
      continue;
    }
    const x = line[0];
    const y = line[1];
    let p = line.slice(3);
    const arrow = p.indexOf(' -> ');
    if (arrow !== -1) {
      p = p.slice(arrow + 4);
    }
    p = unquoteGitPath(p);
    if (p.length === 0) {
      continue;
    }
    const rel = p.replace(/\\/g, '/');
    if (isSensitiveRelPath(rel)) {
      continue;
    }
    let status;
    if (x === '?' || y === '?') {
      status = 'untracked';
    } else if (x === 'A' || y === 'A') {
      status = 'added';
    } else if (x === 'D' || y === 'D') {
      status = 'deleted';
    } else {
      status = 'modified';
    }
    files.push({ path: rel, status });
  }
  return files;
}

function isPathInsideWorkspace(ws, resolved) {
  const rel = path.relative(ws, resolved);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

function truncateDiffLines(text) {
  const lines = text.split('\n');
  if (lines.length > MAX_DIFF_LINES_PER_FILE) {
    return {
      diff:
        lines.slice(0, MAX_DIFF_LINES_PER_FILE).join('\n') +
        '\n... (diff truncado)',
      truncated: true,
    };
  }
  return { diff: text, truncated: false };
}

function buildNewFileDiff(rel, content) {
  const lines = content.split('\n');
  let shown = lines;
  let truncated = false;
  if (lines.length > MAX_DIFF_LINES_PER_FILE) {
    shown = lines.slice(0, MAX_DIFF_LINES_PER_FILE);
    truncated = true;
  }
  let diff =
    `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n` +
    shown.map((l) => `+${l}`).join('\n');
  if (truncated) {
    diff += '\n... (diff truncado)';
  }
  return { diff, truncated };
}

// Diff de um arquivo da tarefa. Untracked: monta diff contra /dev/null.
// Tracked: `git diff` com argv estruturado. Nunca rejeita.
async function getFileDiff(ws, rel, absPath, status) {
  if (status === 'untracked') {
    let st;
    try {
      st = await fs.stat(absPath);
    } catch {
      return { diff: '', truncated: true };
    }
    if (!st.isFile() || st.size > MAX_NEW_FILE_BYTES) {
      return { diff: '', truncated: true };
    }
    let content;
    try {
      content = await fs.readFile(absPath, 'utf8');
    } catch {
      return { diff: '', truncated: true };
    }
    if (content.includes('\0')) {
      return { diff: '', truncated: true };
    }
    return buildNewFileDiff(rel, content);
  }
  const r = await runGit(
    ['diff', '--no-ext-diff', '--unified=3', '--', absPath],
    ws,
  );
  if (r.missing || !r.ok) {
    return { diff: '', truncated: true };
  }
  return truncateDiffLines(r.output.replace(/\r\n/g, '\n'));
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let size = 0;
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        done(null);
        return;
      }
      raw += chunk;
    });
    req.on('end', () => done(raw));
    req.on('error', () => done(null));
    req.on('close', () => done(raw.length > 0 ? raw : null));
  });
}

// Chamada genérica ao OpenCode local. Nunca rejeita.
// networkError=true indica falha de conexão/timeout; caso contrário,
// statusCode/text refletem a resposta HTTP recebida.
function opencodeRequest(method, url, payload, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const body = payload === undefined ? null : JSON.stringify(payload);
    const req = http.request(
      url,
      {
        method,
        timeout: timeoutMs,
        headers:
          body === null
            ? {}
            : {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
              },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
          if (raw.length > 8 * 1024 * 1024) {
            req.destroy();
          }
        });
        res.on('end', () =>
          done({
            networkError: false,
            statusCode: res.statusCode ?? 0,
            text: raw,
          }),
        );
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => done({ networkError: true, statusCode: 0, text: '' }));
    req.on('close', () => done({ networkError: true, statusCode: 0, text: '' }));
    if (body !== null) {
      req.write(body);
    }
    req.end();
  });
}

function parseListedMessages(data) {
  if (!Array.isArray(data)) {
    return null;
  }
  const parsed = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const role =
      item.info && typeof item.info.role === 'string' ? item.info.role : 'user';
    if (Array.isArray(item.parts)) {
      for (const part of item.parts) {
        if (
          part &&
          typeof part === 'object' &&
          part.type === 'text' &&
          typeof part.text === 'string'
        ) {
          parsed.push({ role, text: part.text });
        }
      }
    }
  }
  return parsed;
}

// Coleta o que o workspace contém de diferente: diff por arquivo, paths
// relativos. Retorna null se o git falhar. Nunca rejeita por si só.
async function collectTaskChanges(ws) {
  const after = await runGit(['status', '--porcelain'], ws);
  if (after.missing || !after.ok) {
    return null;
  }
  const parsed = parseGitChanges(after.output);
  let totalChars = 0;
  const filesWithDiff = [];
  for (const f of parsed) {
    const absPath = path.resolve(ws, f.path);
    if (!isPathInsideWorkspace(ws, absPath)) {
      continue;
    }
    let entry = { path: f.path, status: f.status, diff: '', truncated: true };
    if (totalChars < MAX_DIFF_TOTAL_CHARS) {
      const built = await getFileDiff(ws, f.path, absPath, f.status);
      entry = { path: f.path, status: f.status, ...built };
      totalChars += entry.diff.length;
    }
    filesWithDiff.push(entry);
  }
  return { hasChanges: filesWithDiff.length > 0, files: filesWithDiff };
}

// Recuperação parcial: a tarefa partiu de workspace limpo; se a resposta
// final falhou mas o git ficou dirty, retorna estado revisável (409
// TASK_PARTIAL com sessionId + changes) em vez de erro genérico.
// Registra pendingReview para Rejeitar funcionar. Nunca aprova/commita.
// Retorna true se respondeu. Sem alterações => false (erro normal segue).
async function tryTaskPartialRecovery(res, ws, sessionId) {
  try {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return false;
    }
    const changes = await collectTaskChanges(ws);
    if (changes === null || !changes.hasChanges) {
      return false;
    }
    pendingReview = {
      workspace: ws,
      sessionId,
      files: changes.files.map(({ path: p, status: s }) => ({
        path: p,
        status: s,
      })),
    };
    sendJson(res, 409, {
      success: false,
      error: 'TASK_PARTIAL',
      sessionId,
      changes,
    });
    return true;
  } catch {
    return false;
  }
}

// POST /task — recebe intenção de alto nível e executa o fluxo real no OpenCode
// DENTRO do workspace autorizado (POST /session?directory=<workspace>).
// Exige workspace configurado e válido. Aceita { instruction, sessionId?, model?, variant? }.
// Nunca executa shell, nunca aceita paths/comandos/URLs do cliente.
// Erros nunca derrubam o processo.
async function handleTask(req, res) {
  try {
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.includes('application/json')) {
      sendJson(res, 400, { success: false, error: 'INVALID_CONTENT_TYPE' });
      return;
    }
    const raw = await readBody(req, TASK_MAX_BODY_BYTES);
    if (raw === null) {
      sendJson(res, 400, { success: false, error: 'INVALID_BODY' });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { success: false, error: 'INVALID_BODY' });
      return;
    }
    for (const field of FORBIDDEN_TASK_FIELDS) {
      if (payload && payload[field] !== undefined) {
        sendJson(res, 400, { success: false, error: 'INVALID_PAYLOAD' });
        return;
      }
    }
    const instruction =
      payload && typeof payload.instruction === 'string'
        ? payload.instruction.trim()
        : '';
    if (instruction.length === 0 || instruction.length > TASK_MAX_INSTRUCTION) {
      sendJson(res, 400, { success: false, error: 'INVALID_INSTRUCTION' });
      return;
    }
    let sessionId =
      payload && typeof payload.sessionId === 'string' ? payload.sessionId : '';
    if (sessionId.length > 0 && !TASK_SESSION_ID_PATTERN.test(sessionId)) {
      sendJson(res, 400, { success: false, error: 'INVALID_SESSION_ID' });
      return;
    }
    // Modelo/variant opcionais da UI (validados; inválidos => padrão).
    const taskModel = resolveTaskModel(payload);
    // Workspace obrigatório: sem fallback para o diretório do processo.
    if (workspacePath === null) {
      sendJson(res, 409, { success: false, error: 'WORKSPACE_NOT_CONFIGURED' });
      return;
    }
    const wsValidated = await validateWorkspacePath(workspacePath);
    if (!wsValidated.ok) {
      // configuração preservada; apenas bloqueia a execução
      sendJson(res, 409, { success: false, error: 'WORKSPACE_UNAVAILABLE' });
      return;
    }
    const ws = wsValidated.path;
    // Revisão pendente bloqueia qualquer nova tarefa (vale para todo workspace).
    if (pendingReview !== null) {
      sendJson(res, 409, { success: false, error: 'PENDING_REVIEW' });
      return;
    }
    // Aprovado aguardando commit: só libera se o git do workspace limpar
    // (commit externo) ou se não for repo.
    if (approvedReview !== null && approvedReview.workspace === ws) {
      const probeApproved = await runGit(['status', '--porcelain'], ws);
      if (probeApproved.missing) {
        sendJson(res, 503, { success: false, error: 'GIT_UNAVAILABLE' });
        return;
      }
      if (probeApproved.ok && probeApproved.output.trim().length > 0) {
        sendJson(res, 409, { success: false, error: 'CHANGES_NOT_COMMITTED' });
        return;
      }
      approvedReview = null;
    }
    // Workspace precisa estar limpo: alterações antigas não podem se misturar
    // às feitas pela IA. Sem git ou fora de repo, segue sem essa garantia.
    const gitProbe = await runGit(['status', '--porcelain'], ws);
    if (gitProbe.missing) {
      sendJson(res, 503, { success: false, error: 'GIT_UNAVAILABLE' });
      return;
    }
    const repoAvailable = gitProbe.ok;
    if (repoAvailable && gitProbe.output.length > 0) {
      sendJson(res, 409, { success: false, error: 'WORKSPACE_DIRTY' });
      return;
    }
    const health = await checkOpenCode();
    if (!health.connected) {
      sendJson(res, 503, { success: false, error: 'OPENCODE_UNAVAILABLE' });
      return;
    }
    let reuse = false;
    if (sessionId.length > 0) {
      const known = sessionDirectory.get(sessionId);
      if (known === ws) {
        reuse = true;
      } else if (known === undefined) {
        // mapa perdido (reinício do agente): confere o diretório real da sessão
        const info = await opencodeRequest(
          'GET',
          `${OPENCODE_SESSION_URL}/${encodeURIComponent(sessionId)}`,
          undefined,
          TASK_SESSION_TIMEOUT_MS,
        );
        if (
          !info.networkError &&
          info.statusCode >= 200 &&
          info.statusCode < 300
        ) {
          try {
            const data = JSON.parse(info.text);
            if (data && data.directory === ws) {
              sessionDirectory.set(sessionId, ws);
              reuse = true;
            }
          } catch {
            // reuse permanece false: cria sessão nova no workspace atual
          }
        }
      }
      // sessão conhecida de outro workspace: cria nova abaixo (sem erro)
    }
    if (!reuse) {
      const created = await opencodeRequest(
        'POST',
        `${OPENCODE_SESSION_URL}?directory=${encodeURIComponent(ws)}`,
        { title: TASK_TITLE, permission: buildSessionPermission(ws) },
        TASK_SESSION_TIMEOUT_MS,
      );
      if (created.networkError) {
        sendJson(res, 503, { success: false, error: 'OPENCODE_UNAVAILABLE' });
        return;
      }
      let createdId = '';
      try {
        const data = JSON.parse(created.text);
        if (data && typeof data.id === 'string' && data.id.length > 0) {
          createdId = data.id;
        }
      } catch {
        createdId = '';
      }
      if (created.statusCode < 200 || created.statusCode >= 300 || createdId.length === 0) {
        sendJson(res, 502, { success: false, error: 'OPENCODE_ERROR' });
        return;
      }
      sessionId = createdId;
      sessionDirectory.set(sessionId, ws);
    }
    const sent = await opencodeRequest(
      'POST',
      `${OPENCODE_SESSION_URL}/${encodeURIComponent(sessionId)}/message`,
      {
        model: taskModel.model,
        variant: taskModel.variant,
        noReply: false,
        tools: AI_TOOLS,
        parts: [{ type: 'text', text: instruction }],
      },
      TASK_MESSAGE_TIMEOUT_MS,
    );
    if (sent.networkError) {
      if (await tryTaskPartialRecovery(res, ws, sessionId)) {
        return;
      }
      sendJson(res, 503, { success: false, error: 'OPENCODE_UNAVAILABLE' });
      return;
    }
    if (sent.statusCode < 200 || sent.statusCode >= 300) {
      // Limite de uso do modelo: código próprio, sem troca automática.
      if (isModelLimitError(sent.statusCode, sent.text)) {
        sendJson(res, 429, { success: false, error: 'OPENCODE_MODEL_LIMIT' });
        return;
      }
      if (await tryTaskPartialRecovery(res, ws, sessionId)) {
        return;
      }
      sendJson(res, 502, { success: false, error: 'OPENCODE_ERROR' });
      return;
    }
    try {
      JSON.parse(sent.text);
    } catch {
      if (await tryTaskPartialRecovery(res, ws, sessionId)) {
        return;
      }
      sendJson(res, 502, { success: false, error: 'OPENCODE_ERROR' });
      return;
    }
    const listed = await opencodeRequest(
      'GET',
      `${OPENCODE_SESSION_URL}/${encodeURIComponent(sessionId)}/message`,
      undefined,
      TASK_MESSAGES_TIMEOUT_MS,
    );
    if (listed.networkError) {
      if (await tryTaskPartialRecovery(res, ws, sessionId)) {
        return;
      }
      sendJson(res, 503, { success: false, error: 'OPENCODE_UNAVAILABLE' });
      return;
    }
    let messages = null;
    if (listed.statusCode >= 200 && listed.statusCode < 300) {
      try {
        messages = parseListedMessages(JSON.parse(listed.text));
      } catch {
        messages = null;
      }
    }
    if (messages === null) {
      if (await tryTaskPartialRecovery(res, ws, sessionId)) {
        return;
      }
      sendJson(res, 502, { success: false, error: 'OPENCODE_ERROR' });
      return;
    }
    // Detecta o que a tarefa alterou: diff por arquivo, paths relativos.
    let changes = { hasChanges: false, files: [] };
    if (repoAvailable) {
      const collected = await collectTaskChanges(ws);
      if (collected !== null) {
        changes = collected;
        if (changes.hasChanges) {
          // fonte da verdade do reject: somente path+status (sem diffs)
          pendingReview = {
            workspace: ws,
            sessionId,
            files: changes.files.map(({ path: p, status: s }) => ({
              path: p,
              status: s,
            })),
          };
        }
      }
    }
    sendJson(res, 200, {
      success: true,
      taskId: crypto.randomUUID(),
      sessionId,
      workspace: { name: path.basename(ws) },
      messages,
      changes,
    });
  } catch {
    try {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
    } catch {
      // processo segue ativo mesmo se a resposta falhar
    }
  }
}

// POST /task/approve — aceita as alterações pendentes (sem commit).
// Limpa a revisão e registra "aprovado aguardando commit".
async function handleTaskApprove(req, res) {
  try {
    if (pendingReview === null) {
      sendJson(res, 409, { success: false, error: 'NO_PENDING_REVIEW' });
      return;
    }
    if (workspacePath === null) {
      sendJson(res, 409, { success: false, error: 'WORKSPACE_NOT_CONFIGURED' });
      return;
    }
    const wsValidated = await validateWorkspacePath(workspacePath);
    if (!wsValidated.ok) {
      sendJson(res, 409, { success: false, error: 'WORKSPACE_UNAVAILABLE' });
      return;
    }
    if (wsValidated.path !== pendingReview.workspace) {
      sendJson(res, 409, { success: false, error: 'WORKSPACE_MISMATCH' });
      return;
    }
    approvedReview = {
      workspace: pendingReview.workspace,
      files: pendingReview.files,
    };
    pendingReview = null;
    sendJson(res, 200, { success: true });
  } catch {
    try {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
    } catch {
      // processo segue ativo mesmo se a resposta falhar
    }
  }
}

// Restaura UM path ao estado anterior (tracked: `git restore`; untracked:
// arquivo/symlink = remove o path exato; diretório = remove recursivamente
// SOMENTE aquele diretório). Retorna null em sucesso ou código de erro.
// Nunca reset --hard, nunca clean genérico, nunca fora do workspace.
async function restoreSinglePath(ws, relPath, status) {
  const resolved = path.resolve(ws, relPath);
  if (!isPathInsideWorkspace(ws, resolved)) {
    return 'INVALID_PATH';
  }
  if (status === 'untracked') {
    // Porcelain lista diretórios com "/" final; normaliza para operar.
    const target = resolved.replace(/[\\/]+$/, '');
    if (!isPathInsideWorkspace(ws, target) || target === ws) {
      return 'INVALID_PATH';
    }
    let st = null;
    try {
      // lstat: symlink nunca é seguido (remove o link, não o alvo).
      st = await fs.lstat(target);
    } catch {
      st = null;
    }
    if (st === null) {
      return null; // já ausente: ok
    }
    if (!st.isSymbolicLink() && st.isDirectory()) {
      try {
        await fs.rm(target, { recursive: true, force: false });
      } catch {
        return 'RMDIR_FAILED';
      }
      return null;
    }
    if (!st.isFile() && !st.isSymbolicLink()) {
      return 'NOT_A_FILE';
    }
    try {
      await fs.unlink(target);
    } catch {
      return 'UNLINK_FAILED';
    }
    return null;
  }
  const restored = await runGit(['restore', '--', resolved], ws);
  if (restored.missing) {
    return 'GIT_UNAVAILABLE';
  }
  if (!restored.ok) {
    return 'RESTORE_FAILED';
  }
  return null;
}

// POST /task/reject — desfaz SOMENTE as mudanças da tarefa pendente.
// Tracked: `git restore` por arquivo. Untracked: arquivo/symlink exato ou
// diretório exato (recursivo). Nunca reset --hard, nunca clean genérico.
// Fonte da verdade: pendingReview.
async function handleTaskReject(req, res) {
  try {
    if (pendingReview === null) {
      sendJson(res, 409, { success: false, error: 'NO_PENDING_REVIEW' });
      return;
    }
    if (workspacePath === null) {
      sendJson(res, 409, { success: false, error: 'WORKSPACE_NOT_CONFIGURED' });
      return;
    }
    const wsValidated = await validateWorkspacePath(workspacePath);
    if (!wsValidated.ok) {
      sendJson(res, 409, { success: false, error: 'WORKSPACE_UNAVAILABLE' });
      return;
    }
    const ws = wsValidated.path;
    if (ws !== pendingReview.workspace) {
      sendJson(res, 409, { success: false, error: 'WORKSPACE_MISMATCH' });
      return;
    }
    for (const f of pendingReview.files) {
      if (!f || typeof f.path !== 'string' || typeof f.status !== 'string') {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
        return;
      }
      const err = await restoreSinglePath(ws, f.path, f.status);
      if (err === 'GIT_UNAVAILABLE') {
        sendJson(res, 503, { success: false, error: 'GIT_UNAVAILABLE' });
        return;
      }
      if (err !== null) {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
        return;
      }
    }
    const after = await runGit(['status', '--porcelain'], ws);
    if (after.missing || !after.ok || after.output.trim().length > 0) {
      // estado mantido: usuário pode tentar de novo ou limpar manualmente
      sendJson(res, 500, { success: false, error: 'REJECT_INCOMPLETE' });
      return;
    }
    pendingReview = null;
    approvedReview = null;
    sendJson(res, 200, { success: true });
  } catch {
    try {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
    } catch {
      // processo segue ativo mesmo se a resposta falhar
    }
  }
}

// Classifica falha de push pelo stderr. Sem --force em nenhum caminho.
function classifyPushError(stderr) {
  const text = (stderr ?? '').toLowerCase();
  const authHints = [
    'authentication failed',
    'could not read username',
    'could not read password',
    'invalid username',
    'invalid password',
    'permission denied',
    'access denied',
    'logon failed',
    'terminal prompts disabled',
    'askpass',
    '401',
    '403',
  ];
  if (authHints.some((h) => text.includes(h))) {
    return 'GIT_AUTH_REQUIRED';
  }
  const aheadHints = [
    'non-fast-forward',
    'fetch first',
    'failed to push some refs',
    'stale info',
  ];
  if (aheadHints.some((h) => text.includes(h))) {
    return 'REMOTE_AHEAD';
  }
  return 'GIT_PUSH_FAILED';
}

// POST /git/push — push manual com o token OAuth do Agent.
// Pré-condições: workspace válido, repo, origin autorizado, branch,
// status limpo, HEAD, GitHub conectado. Helper temporário + env isolado
// (sem GCM, sem prompt). Sem force, sem dados do cliente.
async function handleGitPush(req, res) {
  let credentialFile = null;
  try {
    if (workspacePath === null) {
      sendJson(res, 409, { success: false, error: 'WORKSPACE_NOT_CONFIGURED' });
      return;
    }
    const wsValidated = await validateWorkspacePath(workspacePath);
    if (!wsValidated.ok) {
      sendJson(res, 409, { success: false, error: 'WORKSPACE_UNAVAILABLE' });
      return;
    }
    const ws = wsValidated.path;
    const inside = await runGit(['rev-parse', '--is-inside-work-tree'], ws);
    if (inside.missing) {
      sendJson(res, 503, { success: false, error: 'GIT_UNAVAILABLE' });
      return;
    }
    if (!inside.ok || inside.output.trim() !== 'true') {
      sendJson(res, 409, { success: false, error: 'NOT_A_REPOSITORY' });
      return;
    }
    const remote = await detectRemote(ws);
    if (!remote.exists) {
      sendJson(res, 409, { success: false, error: 'GIT_REMOTE_MISSING' });
      return;
    }
    const branchOut = await runGit(['branch', '--show-current'], ws);
    const branch = branchOut.ok ? branchOut.output.trim() : '';
    if (branch.length === 0) {
      sendJson(res, 409, { success: false, error: 'GIT_NO_BRANCH' });
      return;
    }
    const dirty = await runGit(['status', '--porcelain'], ws);
    if (dirty.missing) {
      sendJson(res, 503, { success: false, error: 'GIT_UNAVAILABLE' });
      return;
    }
    if (dirty.ok && dirty.output.trim().length > 0) {
      sendJson(res, 409, { success: false, error: 'WORKSPACE_DIRTY' });
      return;
    }
    const head = await runGit(['rev-parse', 'HEAD'], ws);
    if (head.missing || !head.ok) {
      sendJson(res, 409, { success: false, error: 'NOTHING_TO_PUSH' });
      return;
    }
    // Push usa o mesmo token ativo validado (identidade única).
    const auth = await getActiveGithubAuth();
    if (!auth.ok) {
      if (auth.networkError) {
        sendJson(res, 502, { success: false, error: 'GITHUB_API_ERROR' });
        return;
      }
      sendJson(res, 401, { success: false, error: 'GITHUB_AUTH_REQUIRED' });
      return;
    }
    const token = auth.token;
    // Origin precisa estar na lista autorizada da conta (sem URL do cliente).
    const listed = await listAuthorizedRepos(token);
    if (listed.invalid) {
      sendJson(res, 401, { success: false, error: 'GITHUB_AUTH_REQUIRED' });
      return;
    }
    if (listed.repos === null) {
      sendJson(res, 502, { success: false, error: 'GITHUB_API_ERROR' });
      return;
    }
    const authorized = listed.repos.some(
      (r) =>
        typeof r.clone_url === 'string' &&
        normalizeGitRemoteUrl(r.clone_url) ===
          normalizeGitRemoteUrl(remote.url),
    );
    if (!authorized) {
      sendJson(res, 409, { success: false, error: 'GITHUB_REMOTE_NOT_AUTHORIZED' });
      return;
    }
    credentialFile = await writeOAuthCredentialFile(token);
    if (credentialFile === null) {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      return;
    }
    const pushed = await runGit(
      ['-c', `credential.helper=store --file=${credentialFile}`, 'push', 'origin', branch],
      ws,
      GIT_PUSH_TIMEOUT_MS,
      OAUTH_ISOLATION_ENV,
    );
    if (pushed.missing) {
      sendJson(res, 503, { success: false, error: 'GIT_UNAVAILABLE' });
      return;
    }
    if (!pushed.ok) {
      const code = classifyPushError(pushed.errorOutput);
      const http = code === 'GIT_AUTH_REQUIRED' ? 401 : code === 'REMOTE_AHEAD' ? 409 : 502;
      sendJson(res, http, { success: false, error: code });
      return;
    }
    const hashOut = await runGit(['rev-parse', '--short', 'HEAD'], ws);
    sendJson(res, 200, {
      success: true,
      remote: 'origin',
      branch,
      commit: hashOut.ok ? hashOut.output.trim() : '',
    });
  } catch {
    try {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
    } catch {
      // processo segue ativo mesmo se a resposta falhar
    }
  } finally {
    await removeFileQuiet(credentialFile);
  }
}

// POST /git/commit — commit local SOMENTE de conjunto explícito: arquivos da
// tarefa aprovada (mesmo workspace) ou conjunto atual do status (card de
// pendentes). Nunca push. Stage restrito: `git add -- <lista>`. Sem add .,
// sem -A. Identidade git nunca configurada automaticamente.
async function handleGitCommit(req, res) {
  try {
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.includes('application/json')) {
      sendJson(res, 400, { success: false, error: 'INVALID_CONTENT_TYPE' });
      return;
    }
    const raw = await readBody(req, TASK_MAX_BODY_BYTES);
    if (raw === null) {
      sendJson(res, 400, { success: false, error: 'INVALID_BODY' });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { success: false, error: 'INVALID_BODY' });
      return;
    }
    const message =
      payload && typeof payload.message === 'string'
        ? payload.message.trim()
        : '';
    if (message.length === 0 || message.length > MAX_COMMIT_MESSAGE) {
      sendJson(res, 400, { success: false, error: 'INVALID_MESSAGE' });
      return;
    }
    if (workspacePath === null) {
      sendJson(res, 409, { success: false, error: 'WORKSPACE_NOT_CONFIGURED' });
      return;
    }
    const wsValidated = await validateWorkspacePath(workspacePath);
    if (!wsValidated.ok) {
      sendJson(res, 409, { success: false, error: 'WORKSPACE_UNAVAILABLE' });
      return;
    }
    const ws = wsValidated.path;
    // Conjunto a commitar: arquivos aprovados (mesmo workspace) ou, na
    // ausência de aprovação, o conjunto atual do status (card de pendentes).
    // Todas as guardas abaixo (identidade, divergência, add restrito) valem
    // para ambos os casos. Nunca push aqui.
    let baseFiles = null;
    if (approvedReview !== null) {
      if (ws !== approvedReview.workspace) {
        sendJson(res, 409, { success: false, error: 'WORKSPACE_MISMATCH' });
        return;
      }
      baseFiles = approvedReview.files;
    } else {
      const cur0 = await runGit(['status', '--porcelain'], ws);
      if (cur0.missing) {
        sendJson(res, 503, { success: false, error: 'GIT_UNAVAILABLE' });
        return;
      }
      if (!cur0.ok) {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
        return;
      }
      baseFiles = parseGitChanges(cur0.output).map((f) => ({
        path: f.path,
      }));
      if (baseFiles.length === 0) {
        sendJson(res, 409, { success: false, error: 'NOTHING_TO_COMMIT' });
        return;
      }
    }
    // Identidade local ausente + padrão existente => configura o repo
    // automaticamente (LOCAL) e segue. Sem padrão => 409 (tela de identidade).
    let ident = await readGitIdentity(ws);
    if (ident.unavailable) {
      sendJson(res, 503, { success: false, error: 'GIT_UNAVAILABLE' });
      return;
    }
    if (ident.name.length === 0 || ident.email.length === 0) {
      await ensureRepoIdentity(ws);
      ident = await readGitIdentity(ws);
    }
    if (ident.unavailable) {
      sendJson(res, 503, { success: false, error: 'GIT_UNAVAILABLE' });
      return;
    }
    if (ident.name.length === 0 || ident.email.length === 0) {
      sendJson(res, 409, { success: false, error: 'GIT_IDENTITY_MISSING' });
      return;
    }
    // Divergência: o git atual precisa conter exatamente os aprovados.
    const current = await runGit(['status', '--porcelain'], ws);
    if (current.missing || !current.ok) {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      return;
    }
    const currentPaths = new Set(
      parseGitChanges(current.output).map((f) => f.path),
    );
    const approvedPaths = (baseFiles ?? [])
      .filter((f) => f && typeof f.path === 'string')
      .map((f) => f.path);
    if (
      approvedPaths.length === 0 ||
      currentPaths.size !== approvedPaths.length ||
      !approvedPaths.every((p) => currentPaths.has(p))
    ) {
      sendJson(res, 409, { success: false, error: 'CHANGES_DIVERGED' });
      return;
    }
    const absPaths = [];
    for (const p of approvedPaths) {
      const resolved = path.resolve(ws, p);
      if (!isPathInsideWorkspace(ws, resolved)) {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
        return;
      }
      absPaths.push(resolved);
    }
    const staged = await runGit(['add', '--', ...absPaths], ws);
    if (staged.missing || !staged.ok) {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      return;
    }
    const committed = await runGit(['commit', '-m', message], ws);
    if (committed.missing || !committed.ok) {
      sendJson(res, 502, { success: false, error: 'GIT_COMMIT_FAILED' });
      return;
    }
    const hashOut = await runGit(['rev-parse', '--short', 'HEAD'], ws);
    const branchOut = await runGit(['branch', '--show-current'], ws);
    approvedReview = null;
    sendJson(res, 200, {
      success: true,
      commit: {
        hash: hashOut.ok ? hashOut.output.trim() : '',
        message,
        branch:
          branchOut.ok && branchOut.output.trim().length > 0
            ? branchOut.output.trim()
            : '',
      },
    });
  } catch {
    try {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
    } catch {
      // processo segue ativo mesmo se a resposta falhar
    }
  }
}

// GET /git/changes — somente leitura: status + diff por arquivo.
// Reutiliza status --porcelain, parseGitChanges e getFileDiff (com limites).
// Nunca modifica nada. No máximo GIT_CHANGES_MAX_FILES arquivos.
const GIT_CHANGES_MAX_FILES = 100;
async function handleGitChanges(req, res) {
  try {
    if (workspacePath === null) {
      sendJson(res, 409, { success: false, error: 'WORKSPACE_NOT_CONFIGURED' });
      return;
    }
    const wsValidated = await validateWorkspacePath(workspacePath);
    if (!wsValidated.ok) {
      sendJson(res, 409, { success: false, error: 'WORKSPACE_UNAVAILABLE' });
      return;
    }
    const ws = wsValidated.path;
    const st = await runGit(['status', '--porcelain'], ws);
    if (st.missing) {
      sendJson(res, 503, { success: false, error: 'GIT_UNAVAILABLE' });
      return;
    }
    if (!st.ok) {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      return;
    }
    const all = parseGitChanges(st.output);
    const files = [];
    for (const f of all.slice(0, GIT_CHANGES_MAX_FILES)) {
      const absPath = path.resolve(ws, f.path);
      if (!isPathInsideWorkspace(ws, absPath)) {
        continue;
      }
      const d = await getFileDiff(ws, f.path, absPath, f.status);
      files.push({
        path: f.path,
        status: f.status,
        diff: d.diff,
        truncated: d.truncated,
      });
    }
    sendJson(res, 200, {
      dirty: all.length > 0,
      files,
      truncatedList: all.length > files.length,
    });
  } catch {
    try {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
    } catch {
      // processo segue ativo mesmo se a resposta falhar
    }
  }
}

// POST /git/discard — desfaz o conjunto ATUAL do `git status` (tracked via
// `git restore` por arquivo; untracked só o arquivo exato, via helper
// compartilhado). Nunca reset --hard, nunca clean, nunca diretórios.
// Sensíveis já filtrados pelo parseGitChanges.
async function handleGitDiscard(req, res) {
  try {
    if (workspacePath === null) {
      sendJson(res, 409, { success: false, error: 'WORKSPACE_NOT_CONFIGURED' });
      return;
    }
    const wsValidated = await validateWorkspacePath(workspacePath);
    if (!wsValidated.ok) {
      sendJson(res, 409, { success: false, error: 'WORKSPACE_UNAVAILABLE' });
      return;
    }
    const ws = wsValidated.path;
    const st = await runGit(['status', '--porcelain'], ws);
    if (st.missing) {
      sendJson(res, 503, { success: false, error: 'GIT_UNAVAILABLE' });
      return;
    }
    if (!st.ok) {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      return;
    }
    const files = parseGitChanges(st.output);
    for (const f of files) {
      const err = await restoreSinglePath(ws, f.path, f.status);
      if (err === 'GIT_UNAVAILABLE') {
        sendJson(res, 503, { success: false, error: 'GIT_UNAVAILABLE' });
        return;
      }
      if (err !== null) {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
        return;
      }
    }
    const after = await runGit(['status', '--porcelain'], ws);
    if (after.missing || !after.ok || after.output.trim().length > 0) {
      sendJson(res, 500, { success: false, error: 'DISCARD_INCOMPLETE' });
      return;
    }
    pendingReview = null;
    approvedReview = null;
    sendJson(res, 200, { success: true, discarded: files.length });
  } catch {
    try {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
    } catch {
      // processo segue ativo mesmo se a resposta falhar
    }
  }
}

// GET /git/identity — somente leitura: user.name/user.email LOCAIS do repo.
// POST /git/identity — grava SOMENTE no repositório atual (nunca --global).
// Body: { name, email }. Nome não vazio; e-mail em formato mínimo válido.
const GIT_IDENTITY_MAX = 100;
const GIT_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
async function readGitIdentity(ws) {
  const identName = await runGit(['config', 'user.name'], ws);
  const identEmail = await runGit(['config', 'user.email'], ws);
  if (identName.missing || identEmail.missing) {
    return { unavailable: true, name: '', email: '' };
  }
  const name = identName.ok ? identName.output.trim() : '';
  const email = identEmail.ok ? identEmail.output.trim() : '';
  return { unavailable: false, name, email };
}
async function handleGitIdentityGet(req, res) {
  try {
    if (workspacePath === null) {
      sendJson(res, 409, { success: false, error: 'WORKSPACE_NOT_CONFIGURED' });
      return;
    }
    const wsValidated = await validateWorkspacePath(workspacePath);
    if (!wsValidated.ok) {
      sendJson(res, 409, { success: false, error: 'WORKSPACE_UNAVAILABLE' });
      return;
    }
    const ident = await readGitIdentity(wsValidated.path);
    if (ident.unavailable) {
      sendJson(res, 503, { success: false, error: 'GIT_UNAVAILABLE' });
      return;
    }
    sendJson(res, 200, {
      configured: ident.name.length > 0 && ident.email.length > 0,
      name: ident.name,
      email: ident.email,
    });
  } catch {
    try {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
    } catch {
      // processo segue ativo mesmo se a resposta falhar
    }
  }
}
async function handleGitIdentityPost(req, res) {
  try {
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.includes('application/json')) {
      sendJson(res, 400, { success: false, error: 'INVALID_CONTENT_TYPE' });
      return;
    }
    const raw = await readBody(req, TASK_MAX_BODY_BYTES);
    if (raw === null) {
      sendJson(res, 400, { success: false, error: 'INVALID_BODY' });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { success: false, error: 'INVALID_BODY' });
      return;
    }
    const name =
      payload && typeof payload.name === 'string'
        ? payload.name.trim()
        : '';
    const email =
      payload && typeof payload.email === 'string'
        ? payload.email.trim()
        : '';
    if (
      name.length === 0 ||
      name.length > GIT_IDENTITY_MAX ||
      !GIT_EMAIL_PATTERN.test(email) ||
      email.length > GIT_IDENTITY_MAX
    ) {
      sendJson(res, 400, { success: false, error: 'INVALID_IDENTITY' });
      return;
    }
    if (workspacePath === null) {
      sendJson(res, 409, { success: false, error: 'WORKSPACE_NOT_CONFIGURED' });
      return;
    }
    const wsValidated = await validateWorkspacePath(workspacePath);
    if (!wsValidated.ok) {
      sendJson(res, 409, { success: false, error: 'WORKSPACE_UNAVAILABLE' });
      return;
    }
    const ws = wsValidated.path;
    // SOMENTE configuração local do repositório. Sem --global em nenhum caminho.
    const setName = await runGit(['config', 'user.name', name], ws);
    if (setName.missing) {
      sendJson(res, 503, { success: false, error: 'GIT_UNAVAILABLE' });
      return;
    }
    if (!setName.ok) {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      return;
    }
    const setEmail = await runGit(['config', 'user.email', email], ws);
    if (setEmail.missing) {
      sendJson(res, 503, { success: false, error: 'GIT_UNAVAILABLE' });
      return;
    }
    if (!setEmail.ok) {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      return;
    }
    // Identidade informada UMA vez vira padrão do Infinitolov (próximos repos).
    try {
      await saveDefaultIdentity(name, email);
    } catch {
      // melhor esforço: repo atual já configurado acima
    }
    sendJson(res, 200, { success: true, name, email });
  } catch {
    try {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
    } catch {
      // processo segue ativo mesmo se a resposta falhar
    }
  }
}

// GET /git/identity-default — identidade padrão do Infinitolov (sem workspace).
// POST /git/identity-default — define a padrão (validação igual; sem token).
async function handleGitIdentityDefaultGet(req, res) {
  try {
    if (defaultGitIdentity === null) {
      sendJson(res, 200, { configured: false, name: '', email: '' });
      return;
    }
    sendJson(res, 200, {
      configured: true,
      name: defaultGitIdentity.name,
      email: defaultGitIdentity.email,
    });
  } catch {
    try {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
    } catch {
      // processo segue ativo mesmo se a resposta falhar
    }
  }
}
async function handleGitIdentityDefaultPost(req, res) {
  try {
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.includes('application/json')) {
      sendJson(res, 400, { success: false, error: 'INVALID_CONTENT_TYPE' });
      return;
    }
    const raw = await readBody(req, TASK_MAX_BODY_BYTES);
    if (raw === null) {
      sendJson(res, 400, { success: false, error: 'INVALID_BODY' });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { success: false, error: 'INVALID_BODY' });
      return;
    }
    const name =
      payload && typeof payload.name === 'string'
        ? payload.name.trim()
        : '';
    const email =
      payload && typeof payload.email === 'string'
        ? payload.email.trim()
        : '';
    if (!isValidDefaultIdentity(name, email)) {
      sendJson(res, 400, { success: false, error: 'INVALID_IDENTITY' });
      return;
    }
    if (!(await saveDefaultIdentity(name, email))) {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      return;
    }
    sendJson(res, 200, {
      success: true,
      name: name.trim(),
      email: email.trim(),
    });
  } catch {
    try {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
    } catch {
      // processo segue ativo mesmo se a resposta falhar
    }
  }
}

// Endpoints /debug/*: SOMENTE diagnóstico/desenvolvimento para as ferramentas
// de teste da tela Settings. Operações específicas e seguras (sem proxy
// genérico, sem URL/método/path arbitrário, sem shell).
async function handleDebugMessage(req, res) {
  try {
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.includes('application/json')) {
      sendJson(res, 400, { success: false, error: 'INVALID_CONTENT_TYPE' });
      return;
    }
    const raw = await readBody(req, TASK_MAX_BODY_BYTES);
    if (raw === null) {
      sendJson(res, 400, { success: false, error: 'INVALID_BODY' });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { success: false, error: 'INVALID_BODY' });
      return;
    }
    const sessionId =
      payload && typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const text =
      payload && typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!TASK_SESSION_ID_PATTERN.test(sessionId)) {
      sendJson(res, 400, { success: false, error: 'INVALID_SESSION_ID' });
      return;
    }
    if (text.length === 0 || text.length > TASK_MAX_INSTRUCTION) {
      sendJson(res, 400, { success: false, error: 'INVALID_INSTRUCTION' });
      return;
    }
    const health = await checkOpenCode();
    if (!health.connected) {
      sendJson(res, 503, { success: false, error: 'OPENCODE_UNAVAILABLE' });
      return;
    }
    const sent = await opencodeRequest(
      'POST',
      `${OPENCODE_SESSION_URL}/${encodeURIComponent(sessionId)}/message`,
      { noReply: true, parts: [{ type: 'text', text }] },
      TASK_SESSION_TIMEOUT_MS,
    );
    if (sent.networkError) {
      sendJson(res, 503, { success: false, error: 'OPENCODE_UNAVAILABLE' });
      return;
    }
    if (sent.statusCode < 200 || sent.statusCode >= 300) {
      sendJson(res, 502, { success: false, error: 'OPENCODE_ERROR' });
      return;
    }
    let messageId = '';
    try {
      const data = JSON.parse(sent.text);
      if (data && data.info && typeof data.info.id === 'string') {
        messageId = data.info.id;
      }
    } catch {
      messageId = '';
    }
    sendJson(res, 200, { success: true, messageId });
  } catch {
    try {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
    } catch {
      // processo segue ativo mesmo se a resposta falhar
    }
  }
}

async function handleDebugMessages(req, res, rawId) {
  try {
    let sessionId = '';
    try {
      sessionId = decodeURIComponent(rawId);
    } catch {
      sessionId = '';
    }
    if (!TASK_SESSION_ID_PATTERN.test(sessionId)) {
      sendJson(res, 400, { success: false, error: 'INVALID_SESSION_ID' });
      return;
    }
    const health = await checkOpenCode();
    if (!health.connected) {
      sendJson(res, 503, { success: false, error: 'OPENCODE_UNAVAILABLE' });
      return;
    }
    const listed = await opencodeRequest(
      'GET',
      `${OPENCODE_SESSION_URL}/${encodeURIComponent(sessionId)}/message`,
      undefined,
      TASK_MESSAGES_TIMEOUT_MS,
    );
    if (listed.networkError) {
      sendJson(res, 503, { success: false, error: 'OPENCODE_UNAVAILABLE' });
      return;
    }
    let messages = null;
    if (listed.statusCode >= 200 && listed.statusCode < 300) {
      try {
        messages = parseListedMessages(JSON.parse(listed.text));
      } catch {
        messages = null;
      }
    }
    if (messages === null) {
      sendJson(res, 502, { success: false, error: 'OPENCODE_ERROR' });
      return;
    }
    sendJson(res, 200, { success: true, sessionId, messages });
  } catch {
    try {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
    } catch {
      // processo segue ativo mesmo se a resposta falhar
    }
  }
}

// Workspace local autorizado (UM diretório). Fonte da verdade no agente,
// persistida em agent/config.json. Nenhum path é aceito por outras operações.
const CONFIG_PATH = fileURLToPath(new URL('config.json', import.meta.url));
const WORKSPACE_MAX_PATH = 1024;
const GIT_TIMEOUT_MS = 5000;
const GIT_PUSH_TIMEOUT_MS = 60000;
const GIT_CLONE_TIMEOUT_MS = 120000;
const GITHUB_OWNER_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
const GITHUB_REPO_PATTERN = /^[a-zA-Z0-9._-]{1,100}$/;
let workspacePath = null;
// Isolamento de sessão: sessionId -> diretório do workspace em que foi criada.
// Sessão de outro workspace nunca é reutilizada (cria-se uma nova).
const sessionDirectory = new Map();
// Revisão pendente da última tarefa com alterações (fonte da verdade do reject).
// Em memória: reiniciar o agente limpa o estado (o dirty check do git protege).
let pendingReview = null;
// APPROVED_WAITING_COMMIT: { workspace, files } da tarefa aprovada.
// Nova tarefa só depois do commit (ou git limpo por ação externa).
let approvedReview = null;
// Campos de diretório/comando nunca aceitos no payload de /task.
const FORBIDDEN_TASK_FIELDS = [
  'path',
  'cwd',
  'directory',
  'url',
  'shellCommand',
  'command',
  'args',
];

// Identidade padrão do Infinitolov (autor dos commits). Persistida em
// config.json junto ao workspace, SEMPRE separada de github.json (sem token).
// Aplicada LOCALMENTE em cada repo (nunca --global); local existente prevalece.
let defaultGitIdentity = null; // { name, email } | null

function isValidDefaultIdentity(name, email) {
  return (
    typeof name === 'string' &&
    name.trim().length > 0 &&
    name.trim().length <= GIT_IDENTITY_MAX &&
    typeof email === 'string' &&
    GIT_EMAIL_PATTERN.test(email.trim()) &&
    email.trim().length <= GIT_IDENTITY_MAX
  );
}

async function readAgentConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

async function saveDefaultIdentity(name, email) {
  if (!isValidDefaultIdentity(name, email)) {
    return false;
  }
  const clean = { name: name.trim(), email: email.trim() };
  try {
    const data = await readAgentConfig();
    data.gitIdentity = clean;
    await fs.writeFile(CONFIG_PATH, JSON.stringify(data), 'utf8');
  } catch {
    return false;
  }
  defaultGitIdentity = clean;
  return true;
}

async function loadWorkspaceConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data.workspacePath === 'string') {
      const validated = await validateWorkspacePath(data.workspacePath);
      if (validated.ok) {
        workspacePath = validated.path;
      }
    }
  } catch {
    // sem config ou config inválida: inicia sem workspace
  }
  try {
    const data = await readAgentConfig();
    const gi = data && data.gitIdentity;
    if (
      gi &&
      typeof gi === 'object' &&
      isValidDefaultIdentity(gi.name, gi.email)
    ) {
      defaultGitIdentity = { name: gi.name.trim(), email: gi.email.trim() };
    }
  } catch {
    // sem identidade padrão: segue sem ela
  }
}

async function validateWorkspacePath(candidate) {
  if (typeof candidate !== 'string') {
    return { ok: false };
  }
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed.length > WORKSPACE_MAX_PATH) {
    return { ok: false };
  }
  let resolved;
  try {
    resolved = path.resolve(trimmed);
  } catch {
    return { ok: false };
  }
  try {
    const st = await fs.stat(resolved);
    if (!st.isDirectory()) {
      return { ok: false };
    }
  } catch {
    return { ok: false };
  }
  return { ok: true, path: resolved };
}

// Execução Git pelo agente: executável fixo, argv estruturado por chamada,
// cwd sempre o workspace validado. Nunca shell, nunca comando do cliente.
// Processo filho 100% não interativo: herda o env do agente acrescido de
// GIT_TERMINAL_PROMPT=0 e GCM_INTERACTIVE=never (sem GUI, sem prompt;
// credenciais já armazenadas continuam funcionando). Nada global é alterado.
function runGit(args, cwd, timeoutMs = GIT_TIMEOUT_MS, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          ...extraEnv,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            missing: error.code === 'ENOENT',
            output: '',
            errorOutput: String(stderr ?? '').slice(0, 2048),
          });
          return;
        }
        // Sem trim aqui: `git status --porcelain` usa a coluna inicial
        // (ex. " M arq") e o trim destruiria o alinhamento da 1ª linha.
        resolve({
          ok: true,
          missing: false,
          output: String(stdout),
          errorOutput: '',
        });
      },
    );
  });
}

// Helper de credencial OAuth temporário (arquivo apagado após uso).
// Token nunca em argv, origin, logs ou .git/config.
// Caminho com barras normais: o git interpreta `\` como escape na string
// do credential.helper e silenciosamente ignoraria um path Windows.
async function writeOAuthCredentialFile(token) {
  const file = path.join(
    os.tmpdir(),
    `ac-cred-${crypto.randomBytes(8).toString('hex')}`,
  );
  try {
    await fs.writeFile(file, `https://x-access-token:${token}@github.com\n`, {
      mode: 0o600,
    });
  } catch {
    return null;
  }
  return file.replace(/\\/g, '/');
}

async function removeFileQuiet(file) {
  if (file === null || file === undefined) {
    return;
  }
  try {
    await fs.unlink(file);
  } catch {
    // melhor esforço: arquivo em tmp com nome aleatório
  }
}

// Isola o git de credenciais locais (GCM e configs global/system).
// Somente o helper temporário responde; nada global é alterado.
const OAUTH_ISOLATION_ENV = {
  GIT_CONFIG_GLOBAL: 'NUL',
  GIT_CONFIG_SYSTEM: 'NUL',
};

// Remove senha/token de URLs http(s) antes de expor à extensão.
// `https://user:TOKEN@host/x` -> `https://***@host/x`. SSH sem :// intacto.
function redactGitUrl(url) {
  const m = url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^@/]*@)?(.*)$/);
  if (!m) {
    return url;
  }
  const scheme = m[1];
  const userinfo = m[2] ?? '';
  const rest = m[3] ?? '';
  if (userinfo.length === 0 || !userinfo.slice(0, -1).includes(':')) {
    return url;
  }
  return `${scheme}***@${rest}`;
}

async function detectRemote(dir) {
  const none = { exists: false, name: 'origin', url: '' };
  const list = await runGit(['remote'], dir);
  if (list.missing || !list.ok) {
    return none;
  }
  const names = list.output
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (!names.includes('origin')) {
    return none;
  }
  const urlOut = await runGit(['remote', 'get-url', 'origin'], dir);
  if (urlOut.missing || !urlOut.ok) {
    return none;
  }
  return { exists: true, name: 'origin', url: redactGitUrl(urlOut.output.trim()) };
}

async function detectGit(dir) {
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], dir);
  if (inside.missing) {
    return { installed: false, isRepository: false, branch: null };
  }
  if (!inside.ok || inside.output.trim() !== 'true') {
    return { installed: true, isRepository: false, branch: null };
  }
  const current = await runGit(['branch', '--show-current'], dir);
  const branch = current.output.trim();
  return {
    installed: true,
    isRepository: true,
    branch: current.ok && branch.length > 0 ? branch : null,
    remote: await detectRemote(dir),
  };
}

async function getWorkspaceInfo() {
  if (workspacePath === null) {
    return { configured: false };
  }
  return { configured: true, path: workspacePath, git: await detectGit(workspacePath) };
}

async function handleSetWorkspace(req, res) {
  try {
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.includes('application/json')) {
      sendJson(res, 400, { success: false, error: 'INVALID_CONTENT_TYPE' });
      return;
    }
    const raw = await readBody(req, TASK_MAX_BODY_BYTES);
    if (raw === null) {
      sendJson(res, 400, { success: false, error: 'INVALID_BODY' });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { success: false, error: 'INVALID_BODY' });
      return;
    }
    const validated = await validateWorkspacePath(
      payload && typeof payload.path === 'string' ? payload.path : '',
    );
    if (!validated.ok) {
      // tentativa inválida não destrói o workspace anterior
      sendJson(res, 400, { success: false, error: 'INVALID_WORKSPACE' });
      return;
    }
    if (!(await persistWorkspaceConfig(validated.path))) {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      return;
    }
    sendJson(res, 200, {
      success: true,
      workspace: { path: validated.path, exists: true },
    });
  } catch {
    try {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
    } catch {
      // processo segue ativo mesmo se a resposta falhar
    }
  }
}

// Owner GitHub do workspace ativo (ou null se não-GitHub/sem remote).
// Usado para invalidar workspace obsoleto na troca de conta, sem apagar arquivos.
function githubOwnerFromUrl(url) {
  if (typeof url !== 'string') {
    return null;
  }
  const norm = normalizeGitRemoteUrl(url);
  let m = norm.match(/^https?:\/\/github\.com\/([^/]+)(\/.*)?$/);
  if (m) {
    return m[1];
  }
  m = norm.match(/^git@github\.com:([^/]+)(\/.*)?$/);
  if (m) {
    return m[1];
  }
  return null;
}

async function workspaceGithubOwner() {
  if (workspacePath === null) {
    return null;
  }
  const info = await detectGit(workspacePath);
  if (
    !info ||
    info.isRepository !== true ||
    !info.remote ||
    info.remote.exists !== true
  ) {
    return null;
  }
  return githubOwnerFromUrl(info.remote.url);
}

// Aplica a identidade padrão ao repo (LOCAL) quando ausente.
// Nunca sobrescreve identidade local existente. Melhor esforço: nunca falha
// a operação chamadora. Nunca --global.
async function ensureRepoIdentity(ws) {
  try {
    if (defaultGitIdentity === null) {
      return false;
    }
    const ident = await readGitIdentity(ws);
    if (ident.unavailable) {
      return false;
    }
    if (ident.name.length > 0 && ident.email.length > 0) {
      return true; // já configurado: preserva
    }
    const setName = await runGit(
      ['config', 'user.name', defaultGitIdentity.name],
      ws,
    );
    if (setName.missing || !setName.ok) {
      return false;
    }
    const setEmail = await runGit(
      ['config', 'user.email', defaultGitIdentity.email],
      ws,
    );
    if (setEmail.missing || !setEmail.ok) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Desassocia o workspace ativo (memória + config.json). Nunca apaga arquivos,
// clones ou histórico: somente a associação de "projeto ativo".
// Preserva a identidade padrão do Infinitolov.
async function clearWorkspaceAssociation() {
  workspacePath = null;
  try {
    const data = await readAgentConfig();
    delete data.workspacePath;
    await fs.writeFile(CONFIG_PATH, JSON.stringify(data), 'utf8');
    return true;
  } catch {
    return false;
  }
}

// Persiste o workspace autorizado (memória + config.json). Reutilizado
// por POST /workspace e pelo clone (fonte única de workspace).
// Preserva a identidade padrão; aplica-a ao repo quando ausente.
async function persistWorkspaceConfig(resolvedPath) {
  try {
    const data = await readAgentConfig();
    data.workspacePath = resolvedPath;
    await fs.writeFile(CONFIG_PATH, JSON.stringify(data), 'utf8');
  } catch {
    return false;
  }
  workspacePath = resolvedPath;
  try {
    await ensureRepoIdentity(resolvedPath);
  } catch {
    // melhor esforço: workspace já persistido acima
  }
  return true;
}

async function handleGetWorkspace(req, res) {
  try {
    sendJson(res, 200, await getWorkspaceInfo());
  } catch {
    try {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
    } catch {
      // processo segue ativo mesmo se a resposta falhar
    }
  }
}

// POST /workspace/clear — desassocia o projeto ativo sem apagar arquivos.
// Usado na troca de conta GitHub (workspace obsoleto de outra conta).
async function handleClearWorkspace(req, res) {
  try {
    if (!(await clearWorkspaceAssociation())) {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      return;
    }
    sendJson(res, 200, { success: true });
  } catch {
    try {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
    } catch {
      // processo segue ativo mesmo se a resposta falhar
    }
  }
}

// GitHub OAuth Device Flow (sem client_secret, sem PAT).
// Client ID público configurado; access token SOMENTE em agent/github.json
// (gitignored), junto do login validado via GET /user. Token e login nunca
// vão para a extensão, logs ou erros. Vale UMA única identidade ativa:
// status, repos, clone e push usam sempre o mesmo token validado.
const GITHUB_CLIENT_ID = 'Ov23li9egOb0e1UH3zxQ';
const GITHUB_SCOPE = 'repo';
const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API_URL = 'https://api.github.com';
const GITHUB_TIMEOUT_MS = 15000;
const GITHUB_TOKEN_PATH = fileURLToPath(new URL('github.json', import.meta.url));
let deviceFlow = null; // { device_code, expires_at } — user_code/uri vão à extensão
let githubToken = null; // access token em memória (espelho do arquivo)
let githubLogin = null; // login validado do token ativo (espelho do arquivo)

function githubRequest(method, url, body, token) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'AC-Agent',
    };
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const req = https.request(
      url,
      { method, timeout: GITHUB_TIMEOUT_MS, headers },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
          if (raw.length > 2 * 1024 * 1024) {
            req.destroy();
          }
        });
        res.on('end', () => {
          let json = null;
          try {
            json = raw.length > 0 ? JSON.parse(raw) : null;
          } catch {
            json = null;
          }
          done({
              networkError: false,
              statusCode: res.statusCode ?? 0,
              json,
            });
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => done({ networkError: true, statusCode: 0, json: null }));
    req.on('close', () => done({ networkError: true, statusCode: 0, json: null }));
    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}

async function loadGithubToken() {
  githubToken = null;
  githubLogin = null;
  let data = null;
  try {
    data = JSON.parse(await fs.readFile(GITHUB_TOKEN_PATH, 'utf8'));
  } catch {
    // sem arquivo válido: desconectado
    return;
  }
  if (
    !data ||
    typeof data.access_token !== 'string' ||
    data.access_token.length === 0
  ) {
    return;
  }
  const savedLogin = typeof data.login === 'string' ? data.login : '';
  const u = await fetchGithubUser(data.access_token);
  if (!u.ok) {
    if (u.invalid) {
      // token revogado/expirado: não reutilizar em nenhuma conta
      try {
        await fs.unlink(GITHUB_TOKEN_PATH);
      } catch {
        // arquivo já ausente: ok
      }
    }
    // falha de rede: mantém desconectado até a próxima validação em uso
    return;
  }
  if (
    savedLogin.length > 0 &&
    savedLogin.toLowerCase() !== u.user.login.toLowerCase()
  ) {
    // arquivo trocado por outra conta: sessão inválida, exige reconexão
    try {
      await fs.unlink(GITHUB_TOKEN_PATH);
    } catch {
      // arquivo já ausente: ok
    }
    return;
  }
  githubToken = data.access_token;
  githubLogin = u.user.login;
  if (savedLogin.length === 0) {
    // backfill do login em arquivos antigos (só token)
    try {
      await fs.writeFile(
        GITHUB_TOKEN_PATH,
        JSON.stringify({
          access_token: githubToken,
          scope: GITHUB_SCOPE,
          login: githubLogin,
        }),
        'utf8',
      );
    } catch {
      // melhor esforço: identidade em memória já é a validada
    }
  }
}

async function saveGithubToken(token, login) {
  // Arquivo primeiro: se a persistência falhar, a memória nunca carrega
  // um token sem par em disco (fail-closed, sem deriva entre fontes).
  await fs.writeFile(
    GITHUB_TOKEN_PATH,
    JSON.stringify({ access_token: token, scope: GITHUB_SCOPE, login }),
    'utf8',
  );
  githubToken = token;
  githubLogin = login;
}

async function clearGithubToken() {
  githubToken = null;
  githubLogin = null;
  deviceFlow = null;
  try {
    await fs.unlink(GITHUB_TOKEN_PATH);
  } catch {
    // arquivo já ausente: ok
  }
}

// POST /github/connect — inicia Device Flow. Retorna user_code +
// verification_uri (sem device_code, sem token).
async function handleGithubConnect(req, res) {
  try {
    // Troca de conta: um novo Device Flow nunca reutiliza credencial anterior.
    // Invalida token em memória, github.json e deviceFlow pendente antes de gerar o novo fluxo.
    await clearGithubToken();
    const r = await githubRequest('POST', GITHUB_DEVICE_CODE_URL, {
      client_id: GITHUB_CLIENT_ID,
      scope: GITHUB_SCOPE,
    });
    if (r.networkError) {
      sendJson(res, 502, { success: false, error: 'GITHUB_UNAVAILABLE' });
      return;
    }
    const d = r.json;
    if (
      r.statusCode < 200 ||
      r.statusCode >= 300 ||
      !d ||
      typeof d.device_code !== 'string' ||
      typeof d.user_code !== 'string' ||
      typeof d.verification_uri !== 'string'
    ) {
      sendJson(res, 502, { success: false, error: 'GITHUB_FLOW_ERROR' });
      return;
    }
    deviceFlow = {
      device_code: d.device_code,
      expires_at: Date.now() + (typeof d.expires_in === 'number' ? d.expires_in : 900) * 1000,
    };
    sendJson(res, 200, {
      success: true,
      user_code: d.user_code,
      verification_uri: d.verification_uri,
      verification_uri_complete:
        typeof d.verification_uri_complete === 'string'
          ? d.verification_uri_complete
          : '',
      expires_in: typeof d.expires_in === 'number' ? d.expires_in : 900,
      interval: typeof d.interval === 'number' && d.interval >= 5 ? d.interval : 5,
    });
  } catch {
    try {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
    } catch {
      // processo segue ativo mesmo se a resposta falhar
    }
  }
}

// POST /github/poll — uma tentativa de polling (a extensão agenda repetições).
async function handleGithubPoll(req, res) {
  try {
    if (deviceFlow === null) {
      sendJson(res, 409, { success: false, error: 'NO_DEVICE_FLOW' });
      return;
    }
    if (Date.now() >= deviceFlow.expires_at) {
      deviceFlow = null;
      sendJson(res, 200, { success: true, authorized: false, status: 'expired' });
      return;
    }
    const deviceCode = deviceFlow.device_code;
    const r = await githubRequest('POST', GITHUB_TOKEN_URL, {
      client_id: GITHUB_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (r.networkError) {
      sendJson(res, 502, { success: false, error: 'GITHUB_UNAVAILABLE' });
      return;
    }
    const d = r.json ?? {};
    if (typeof d.access_token === 'string' && d.access_token.length > 0) {
      // Conta nova substitui completamente a anterior: valida a identidade
      // do token recebido ANTES de persistir; token inválido nunca é salvo.
      const u = await fetchGithubUser(d.access_token);
      if (!u.ok) {
        sendJson(res, 502, { success: false, error: 'GITHUB_FLOW_ERROR' });
        return;
      }
      try {
        await saveGithubToken(d.access_token, u.user.login);
      } catch {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
        return;
      }
      deviceFlow = null;
      sendJson(res, 200, { success: true, authorized: true });
      return;
    }
    const err = typeof d.error === 'string' ? d.error : '';
    if (err === 'authorization_pending') {
      sendJson(res, 200, { success: true, authorized: false, status: 'pending' });
      return;
    }
    if (err === 'slow_down') {
      sendJson(res, 200, { success: true, authorized: false, status: 'slow_down' });
      return;
    }
    if (err === 'expired_token') {
      deviceFlow = null;
      sendJson(res, 200, { success: true, authorized: false, status: 'expired' });
      return;
    }
    if (err === 'access_denied') {
      deviceFlow = null;
      sendJson(res, 200, { success: true, authorized: false, status: 'denied' });
      return;
    }
    sendJson(res, 502, { success: false, error: 'GITHUB_FLOW_ERROR' });
  } catch {
    try {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
    } catch {
      // processo segue ativo mesmo se a resposta falhar
    }
  }
}

async function fetchGithubUser(token) {
  const r = await githubRequest('GET', `${GITHUB_API_URL}/user`, undefined, token);
  if (r.networkError) {
    return { ok: false, invalid: false, user: null };
  }
  if (r.statusCode === 401) {
    return { ok: false, invalid: true, user: null };
  }
  if (
    r.statusCode < 200 ||
    r.statusCode >= 300 ||
    !r.json ||
    typeof r.json.login !== 'string'
  ) {
    return { ok: false, invalid: false, user: null };
  }
  return {
    ok: true,
    invalid: false,
    user: {
      login: r.json.login,
      avatar_url: typeof r.json.avatar_url === 'string' ? r.json.avatar_url : '',
      // Nome real pode ser null (privado/ausente); e-mail nunca vem aqui
      // (scope atual não inclui user:email). UI nunca inventa e-mail.
      name: typeof r.json.name === 'string' ? r.json.name : '',
    },
  };
}

// Identidade única ativa: o token em memória só vale se o GET /user
// confirmar o mesmo login persistido. Qualquer divergência invalida a
// sessão (limpa memória + arquivo) e exige reconexão. Nunca rejeita.
// Retorna { ok:true, token, login, user } ou { ok:false, ... }.
async function getActiveGithubAuth() {
  if (githubToken === null) {
    return { ok: false, error: 'GITHUB_NOT_CONNECTED', networkError: false };
  }
  const u = await fetchGithubUser(githubToken);
  if (!u.ok) {
    if (u.invalid) {
      await clearGithubToken();
      return { ok: false, error: 'GITHUB_TOKEN_INVALID', networkError: false };
    }
    return { ok: false, error: 'GITHUB_UNAVAILABLE', networkError: true };
  }
  if (
    githubLogin !== null &&
    githubLogin.toLowerCase() !== u.user.login.toLowerCase()
  ) {
    // login salvo != login do token atual: sessão inválida
    await clearGithubToken();
    return { ok: false, error: 'GITHUB_SESSION_INVALID', networkError: false };
  }
  githubLogin = u.user.login;
  return { ok: true, token: githubToken, login: u.user.login, user: u.user };
}

// GET /github/status — conectado + usuário, sem token.
// Reflete exclusivamente o usuário do token atualmente válido.
async function handleGithubStatus(req, res) {
  try {
    if (githubToken === null) {
      sendJson(res, 409, { success: false, error: 'GITHUB_NOT_CONNECTED' });
      return;
    }
    const auth = await getActiveGithubAuth();
    if (auth.ok) {
      sendJson(res, 200, { connected: true, user: auth.user });
      return;
    }
    sendJson(res, 200, { connected: false });
  } catch {
    try {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
    } catch {
      // processo segue ativo mesmo se a resposta falhar
    }
  }
}

// GET /github/repos — somente campos necessários, sem conteúdo de arquivos.
// Usa sempre o token ativo validado (mesma identidade do status).
async function handleGithubRepos(req, res) {
  try {
    const auth = await getActiveGithubAuth();
    if (!auth.ok) {
      if (auth.error === 'GITHUB_NOT_CONNECTED') {
        sendJson(res, 409, { success: false, error: 'GITHUB_NOT_CONNECTED' });
        return;
      }
      if (auth.networkError) {
        sendJson(res, 502, { success: false, error: 'GITHUB_UNAVAILABLE' });
        return;
      }
      sendJson(res, 401, { success: false, error: 'GITHUB_TOKEN_INVALID' });
      return;
    }
    const r = await githubRequest(
      'GET',
      `${GITHUB_API_URL}/user/repos?per_page=100&sort=updated`,
      undefined,
      auth.token,
    );
    if (r.networkError) {
      sendJson(res, 502, { success: false, error: 'GITHUB_UNAVAILABLE' });
      return;
    }
    if (r.statusCode === 401) {
      await clearGithubToken();
      sendJson(res, 401, { success: false, error: 'GITHUB_TOKEN_INVALID' });
      return;
    }
    if (r.statusCode < 200 || r.statusCode >= 300 || !Array.isArray(r.json)) {
      sendJson(res, 502, { success: false, error: 'GITHUB_API_ERROR' });
      return;
    }
    const repos = [];
    for (const item of r.json) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      repos.push({
        id: typeof item.id === 'number' ? item.id : 0,
        name: typeof item.name === 'string' ? item.name : '',
        full_name: typeof item.full_name === 'string' ? item.full_name : '',
        private: item.private === true,
        html_url: typeof item.html_url === 'string' ? item.html_url : '',
        clone_url: typeof item.clone_url === 'string' ? item.clone_url : '',
        default_branch:
          typeof item.default_branch === 'string' ? item.default_branch : '',
        owner:
          item.owner && typeof item.owner.login === 'string'
            ? { login: item.owner.login }
            : { login: '' },
      });
    }
    sendJson(res, 200, { success: true, repos });
  } catch {
    try {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
    } catch {
      // processo segue ativo mesmo se a resposta falhar
    }
  }
}

// Raiz controlada de projetos: %LOCALAPPDATA%\Infinitolov\projects\<owner>\<repo>
// O frontend nunca escolhe o destino.
function getProjectsRoot() {
  const localAppData = process.env.LOCALAPPDATA ?? '';
  if (localAppData.trim().length > 0) {
    return path.join(localAppData, 'Infinitolov', 'projects');
  }
  return path.join(os.homedir(), '.infinitolov', 'projects');
}

function normalizeGitRemoteUrl(url) {
  return url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

// Lista fresca de repos autorizados (fonte da verdade do clone).
// Recebe o token ativo já validado (nunca lê fonte antiga/diferente).
// Retorna null em falha de rede/API; array vazio se token inválido+limpo? Não:
// 401 limpa o token e retorna { invalid: true }.
async function listAuthorizedRepos(activeToken) {
  const token = activeToken ?? githubToken;
  if (token === null) {
    return { repos: null, invalid: false };
  }
  const r = await githubRequest(
    'GET',
    `${GITHUB_API_URL}/user/repos?per_page=100&sort=updated`,
    undefined,
    token,
  );
  if (r.networkError) {
    return { repos: null, invalid: false };
  }
  if (r.statusCode === 401) {
    await clearGithubToken();
    return { repos: null, invalid: true };
  }
  if (r.statusCode < 200 || r.statusCode >= 300 || !Array.isArray(r.json)) {
    return { repos: null, invalid: false };
  }
  const repos = [];
  for (const item of r.json) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    repos.push({
      id: typeof item.id === 'number' ? item.id : 0,
      name: typeof item.name === 'string' ? item.name : '',
      full_name: typeof item.full_name === 'string' ? item.full_name : '',
      private: item.private === true,
      default_branch:
        typeof item.default_branch === 'string' ? item.default_branch : '',
      clone_url: typeof item.clone_url === 'string' ? item.clone_url : '',
      ownerLogin:
        item.owner && typeof item.owner.login === 'string'
          ? item.owner.login
          : '',
    });
  }
  return { repos, invalid: false };
}

// POST /github/clone — clona repo autorizado (por repoId) para a raiz
// controlada e define como workspace. Sem URL/clone genérico, sem token
// em argv/origin/logs (credential helper temporário só p/ privado).
async function handleGithubClone(req, res) {
  let credentialFile = null;
  try {
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.includes('application/json')) {
      sendJson(res, 400, { success: false, error: 'INVALID_CONTENT_TYPE' });
      return;
    }
    const raw = await readBody(req, TASK_MAX_BODY_BYTES);
    if (raw === null) {
      sendJson(res, 400, { success: false, error: 'INVALID_BODY' });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { success: false, error: 'INVALID_BODY' });
      return;
    }
    const repoId =
      payload && typeof payload.repoId === 'number' ? payload.repoId : 0;
    if (!Number.isInteger(repoId) || repoId <= 0) {
      sendJson(res, 400, { success: false, error: 'INVALID_REPO' });
      return;
    }
    // Clone usa o mesmo token ativo validado (identidade única).
    const auth = await getActiveGithubAuth();
    if (!auth.ok) {
      if (auth.error === 'GITHUB_NOT_CONNECTED') {
        sendJson(res, 409, { success: false, error: 'GITHUB_NOT_CONNECTED' });
        return;
      }
      if (auth.networkError) {
        sendJson(res, 502, { success: false, error: 'GITHUB_API_ERROR' });
        return;
      }
      sendJson(res, 401, { success: false, error: 'GITHUB_TOKEN_INVALID' });
      return;
    }
    const token = auth.token;
    const listed = await listAuthorizedRepos(token);
    if (listed.invalid) {
      sendJson(res, 401, { success: false, error: 'GITHUB_TOKEN_INVALID' });
      return;
    }
    if (listed.repos === null) {
      sendJson(res, 502, { success: false, error: 'GITHUB_API_ERROR' });
      return;
    }
    const repo = listed.repos.find((r) => r.id === repoId);
    if (!repo) {
      sendJson(res, 404, { success: false, error: 'REPO_NOT_FOUND' });
      return;
    }
    if (
      !GITHUB_OWNER_PATTERN.test(repo.ownerLogin) ||
      !GITHUB_REPO_PATTERN.test(repo.name) ||
      typeof repo.clone_url !== 'string' ||
      !repo.clone_url.startsWith('https://github.com/')
    ) {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      return;
    }
    const root = getProjectsRoot();
    const dest = path.resolve(root, repo.ownerLogin, repo.name);
    if (!isPathInsideWorkspace(root, dest) || dest === root) {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      return;
    }
    let destStat = null;
    try {
      destStat = await fs.stat(dest);
    } catch {
      destStat = null;
    }
    if (destStat !== null) {
      // Destino ocupado: reutiliza só se for o mesmo repo; nunca apaga.
      const inside = await runGit(['rev-parse', '--is-inside-work-tree'], dest);
      const originOut = await runGit(['remote', 'get-url', 'origin'], dest);
      const same =
        !inside.missing &&
        inside.ok &&
        inside.output.trim() === 'true' &&
        !originOut.missing &&
        originOut.ok &&
        normalizeGitRemoteUrl(originOut.output.trim()) ===
          normalizeGitRemoteUrl(repo.clone_url);
      if (!same) {
        sendJson(res, 409, { success: false, error: 'DESTINATION_CONFLICT' });
        return;
      }
      const validated = await validateWorkspacePath(dest);
      if (!validated.ok) {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
        return;
      }
      if (!(await persistWorkspaceConfig(validated.path))) {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
        return;
      }
      const info = await getWorkspaceInfo();
      sendJson(res, 200, {
        success: true,
        status: 'already_cloned',
        workspace: {
          name: repo.name,
          branch:
            info.git && typeof info.git.branch === 'string'
              ? info.git.branch
              : '',
        },
      });
      return;
    }
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true });
    } catch {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      return;
    }
    const cloneArgs = ['clone'];
    if (repo.private) {
      // Credencial via helper temporário (arquivo apagado no finally).
      // Token nunca em argv, origin, logs ou .git/config.
      credentialFile = await writeOAuthCredentialFile(token);
      if (credentialFile === null) {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
        return;
      }
      cloneArgs.push('-c', `credential.helper=store --file=${credentialFile}`);
    }
    cloneArgs.push(repo.clone_url, dest);
    // Isolamento OAuth (igual ao push): sem configs global/system o GCM do
    // sistema pode responder com credencial obsoleta; o GitHub retorna 404
    // para repo privado sem acesso e o git aborta antes de tentar o helper
    // temporário. Somente o helper temporário responde.
    const cloned = await runGit(
      cloneArgs,
      root,
      GIT_CLONE_TIMEOUT_MS,
      OAUTH_ISOLATION_ENV,
    );
    if (cloned.missing || !cloned.ok) {
      if (!cloned.missing && classifyPushError(cloned.errorOutput) === 'GIT_AUTH_REQUIRED') {
        sendJson(res, 401, { success: false, error: 'GIT_AUTH_REQUIRED' });
        return;
      }
      sendJson(res, 502, { success: false, error: 'GIT_CLONE_FAILED' });
      return;
    }
    // Origin precisa ser a URL pública, sem token.
    const originOut = await runGit(['remote', 'get-url', 'origin'], dest);
    if (
      originOut.missing ||
      !originOut.ok ||
      originOut.output.includes(token) ||
      normalizeGitRemoteUrl(originOut.output.trim()) !==
        normalizeGitRemoteUrl(repo.clone_url)
    ) {
      sendJson(res, 502, { success: false, error: 'GIT_CLONE_FAILED' });
      return;
    }
    if (repo.private) {
      // O -c do clone persiste o helper no .git/config: remove (era temporário).
      // Só existe neste clone fresco, então unset-all é seguro aqui.
      await runGit(['config', '--local', '--unset-all', 'credential.helper'], dest);
    }
    const validated = await validateWorkspacePath(dest);
    if (!validated.ok) {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      return;
    }
    if (!(await persistWorkspaceConfig(validated.path))) {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      return;
    }
    const info = await getWorkspaceInfo();
    sendJson(res, 200, {
      success: true,
      status: 'cloned',
      workspace: {
        name: repo.name,
        branch:
          info.git && typeof info.git.branch === 'string' ? info.git.branch : '',
      },
    });
  } catch {
    try {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
    } catch {
      // processo segue ativo mesmo se a resposta falhar
    }
  } finally {
    await removeFileQuiet(credentialFile);
  }
}

// POST /github/disconnect — logout local (apaga token).
// Revogação remota exige client_secret (backend futuro); aqui só local.
// Também desassocia workspace GitHub obsoleto (configuração apenas; arquivos
// e clones são preservados). Workspaces locais não-GitHub são mantidos.
async function handleGithubDisconnect(req, res) {
  try {
    await clearGithubToken();
    try {
      if ((await workspaceGithubOwner()) !== null) {
        await clearWorkspaceAssociation();
      }
    } catch {
      // melhor esforço: o token já foi invalidado acima
    }
    sendJson(res, 200, { success: true });
  } catch {
    try {
      sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
    } catch {
      // processo segue ativo mesmo se a resposta falhar
    }
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/status') {
    Promise.all([checkOpenCode(), resolveOpencodeBin()]).then(
      ([opencode, bin]) => {
        if (!opencode.connected && bin !== null) {
          // Autocura: OpenCode caiu depois do boot; reacende em background.
          ensureOpenCodeServer().catch(() => {});
        }
        const body = JSON.stringify({
          agent: true,
          name: 'AC Agent',
          version: VERSION,
          status: 'running',
          opencode: {
            installed: bin !== null,
            connected: opencode.connected,
            version: opencode.version,
          },
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
      },
    );
    return;
  }
  if (req.method === 'GET' && url.pathname === '/ai/models') {
    handleAiModels(req, res).catch(() => {
      try {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      } catch {
        // processo segue ativo mesmo se a resposta falhar
      }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/task') {
    handleTask(req, res).catch(() => {
      try {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      } catch {
        // processo segue ativo mesmo se a resposta falhar
      }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/task/approve') {
    handleTaskApprove(req, res).catch(() => {
      try {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      } catch {
        // processo segue ativo mesmo se a resposta falhar
      }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/task/reject') {
    handleTaskReject(req, res).catch(() => {
      try {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      } catch {
        // processo segue ativo mesmo se a resposta falhar
      }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/git/commit') {
    handleGitCommit(req, res).catch(() => {
      try {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      } catch {
        // processo segue ativo mesmo se a resposta falhar
      }
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/git/changes') {
    handleGitChanges(req, res).catch(() => {
      try {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      } catch {
        // processo segue ativo mesmo se a resposta falhar
      }
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/git/identity') {
    handleGitIdentityGet(req, res).catch(() => {
      try {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      } catch {
        // processo segue ativo mesmo se a resposta falhar
      }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/git/identity') {
    handleGitIdentityPost(req, res).catch(() => {
      try {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      } catch {
        // processo segue ativo mesmo se a resposta falhar
      }
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/git/identity-default') {
    handleGitIdentityDefaultGet(req, res).catch(() => {
      try {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      } catch {
        // processo segue ativo mesmo se a resposta falhar
      }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/git/identity-default') {
    handleGitIdentityDefaultPost(req, res).catch(() => {
      try {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      } catch {
        // processo segue ativo mesmo se a resposta falhar
      }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/git/discard') {
    handleGitDiscard(req, res).catch(() => {
      try {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      } catch {
        // processo segue ativo mesmo se a resposta falhar
      }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/git/push') {
    handleGitPush(req, res).catch(() => {
      try {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      } catch {
        // processo segue ativo mesmo se a resposta falhar
      }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/debug/message') {
    handleDebugMessage(req, res).catch(() => {
      try {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      } catch {
        // processo segue ativo mesmo se a resposta falhar
      }
    });
    return;
  }
  if (
    req.method === 'GET' &&
    url.pathname.startsWith('/debug/session/') &&
    url.pathname.endsWith('/messages')
  ) {
    const rawId = url.pathname.slice('/debug/session/'.length, -'/messages'.length);
    handleDebugMessages(req, res, rawId).catch(() => {
      try {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      } catch {
        // processo segue ativo mesmo se a resposta falhar
      }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/github/connect') {
    handleGithubConnect(req, res).catch(() => {
      try {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      } catch {
        // processo segue ativo mesmo se a resposta falhar
      }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/github/poll') {
    handleGithubPoll(req, res).catch(() => {
      try {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      } catch {
        // processo segue ativo mesmo se a resposta falhar
      }
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/github/status') {
    handleGithubStatus(req, res).catch(() => {
      try {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      } catch {
        // processo segue ativo mesmo se a resposta falhar
      }
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/github/repos') {
    handleGithubRepos(req, res).catch(() => {
      try {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      } catch {
        // processo segue ativo mesmo se a resposta falhar
      }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/github/clone') {
    handleGithubClone(req, res).catch(() => {
      try {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      } catch {
        // processo segue ativo mesmo se a resposta falhar
      }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/github/disconnect') {
    handleGithubDisconnect(req, res).catch(() => {
      try {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      } catch {
        // processo segue ativo mesmo se a resposta falhar
      }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/workspace') {
    handleSetWorkspace(req, res).catch(() => {
      try {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      } catch {
        // processo segue ativo mesmo se a resposta falhar
      }
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/workspace') {
    handleGetWorkspace(req, res).catch(() => {
      try {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      } catch {
        // processo segue ativo mesmo se a resposta falhar
      }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/workspace/clear') {
    handleClearWorkspace(req, res).catch(() => {
      try {
        sendJson(res, 500, { success: false, error: 'INTERNAL_ERROR' });
      } catch {
        // processo segue ativo mesmo se a resposta falhar
      }
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

await loadWorkspaceConfig();
await loadGithubToken();

server.listen(PORT, HOST, () => {
  console.log(`AC Agent running at http://${HOST}:${PORT}/status`);
  // Ponto único de entrada: garante o OpenCode em background sem
  // atrasar o listen nem abrir janela.
  ensureOpenCodeServer().catch(() => {});
});

function shutdown() {
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
