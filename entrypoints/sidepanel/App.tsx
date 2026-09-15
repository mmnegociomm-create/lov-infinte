import { useCallback, useEffect, useRef, useState } from 'react';

const HEALTH_URL = 'http://127.0.0.1:4096/global/health';
const SESSION_URL = 'http://127.0.0.1:4096/session';

const AI_MODEL = {
  providerID: 'opencode',
  modelID: 'muse-spark-1.3-contributor-free',
};
const AI_VARIANT = 'medium';
const AI_TOOLS: Record<string, boolean> = {
  invalid: false,
  question: false,
  bash: false,
  read: true,
  glob: true,
  grep: false,
  edit: false,
  write: false,
  task: false,
  webfetch: false,
  todowrite: false,
  websearch: false,
  skill: false,
  apply_patch: false,
};

type SessionPermissionRule = {
  permission: string;
  pattern: string;
  action: 'allow' | 'deny' | 'ask';
};

// Regras aplicadas NA SESSÃO (sem tocar a config global).
// Ordem: regra ampla primeiro, denies específicos depois
// (última regra coincidente vence).
const SESSION_PERMISSION: SessionPermissionRule[] = [
  { permission: 'external_directory', pattern: '*', action: 'deny' },
  { permission: 'read', pattern: '*', action: 'allow' },
  { permission: 'read', pattern: '.env', action: 'deny' },
  { permission: 'read', pattern: '.env.*', action: 'deny' },
  { permission: 'read', pattern: '**/.env', action: 'deny' },
  { permission: 'read', pattern: '**/.env.*', action: 'deny' },
  { permission: 'read', pattern: '*.pem', action: 'deny' },
  { permission: 'read', pattern: '**/*.pem', action: 'deny' },
  { permission: 'read', pattern: '*.key', action: 'deny' },
  { permission: 'read', pattern: '**/*.key', action: 'deny' },
  { permission: 'read', pattern: '*.p12', action: 'deny' },
  { permission: 'read', pattern: '**/*.p12', action: 'deny' },
  { permission: 'read', pattern: '*.pfx', action: 'deny' },
  { permission: 'read', pattern: '**/*.pfx', action: 'deny' },
  { permission: 'read', pattern: 'id_rsa', action: 'deny' },
  { permission: 'read', pattern: '**/id_rsa', action: 'deny' },
  { permission: 'read', pattern: 'id_ed25519', action: 'deny' },
  { permission: 'read', pattern: '**/id_ed25519', action: 'deny' },
  { permission: 'read', pattern: '**/.ssh/**', action: 'deny' },
  { permission: 'read', pattern: '**/secrets/**', action: 'deny' },
  { permission: 'read', pattern: '**/.git/**', action: 'deny' },
  { permission: 'glob', pattern: '*', action: 'allow' },
  { permission: 'glob', pattern: '.env', action: 'deny' },
  { permission: 'glob', pattern: '.env.*', action: 'deny' },
  { permission: 'glob', pattern: '**/.env', action: 'deny' },
  { permission: 'glob', pattern: '**/.env.*', action: 'deny' },
  { permission: 'glob', pattern: '*.pem', action: 'deny' },
  { permission: 'glob', pattern: '**/*.pem', action: 'deny' },
  { permission: 'glob', pattern: '*.key', action: 'deny' },
  { permission: 'glob', pattern: '**/*.key', action: 'deny' },
  { permission: 'glob', pattern: '*.p12', action: 'deny' },
  { permission: 'glob', pattern: '**/*.p12', action: 'deny' },
  { permission: 'glob', pattern: '*.pfx', action: 'deny' },
  { permission: 'glob', pattern: '**/*.pfx', action: 'deny' },
  { permission: 'glob', pattern: '**/.ssh/**', action: 'deny' },
  { permission: 'glob', pattern: '**/secrets/**', action: 'deny' },
  { permission: 'glob', pattern: '**/.git/**', action: 'deny' },
  { permission: 'grep', pattern: '*', action: 'deny' },
  { permission: 'edit', pattern: '*', action: 'deny' },
  { permission: 'bash', pattern: '*', action: 'deny' },
  { permission: 'task', pattern: '*', action: 'deny' },
  { permission: 'webfetch', pattern: '*', action: 'deny' },
  { permission: 'websearch', pattern: '*', action: 'deny' },
  { permission: 'skill', pattern: '*', action: 'deny' },
  { permission: 'question', pattern: '*', action: 'deny' },
];

type Status = 'checking' | 'connected' | 'disconnected';
type SessionState = 'idle' | 'creating' | 'created' | 'error';
type MessageState = 'idle' | 'sending' | 'sent' | 'error';
type ListState = 'idle' | 'loading' | 'loaded' | 'error';
type ChatState = 'idle' | 'preparing' | 'answering' | 'error';

// Views internas do painel (extensível: futuramente 'license').
type AppView = 'workspace' | 'settings';

type ListedMessage = {
  role: string;
  text: string;
};

function App() {
  const [status, setStatus] = useState<Status>('checking');
  const [version, setVersion] = useState('');
  const [sessionState, setSessionState] = useState<SessionState>('idle');
  const [sessionId, setSessionId] = useState('');
  const [messageText, setMessageText] = useState('');
  const [messageState, setMessageState] = useState<MessageState>('idle');
  const [messageId, setMessageId] = useState('');
  const [listState, setListState] = useState<ListState>('idle');
  const [messages, setMessages] = useState<ListedMessage[]>([]);
  const historyRef = useRef<HTMLDivElement>(null);
  const [aiState, setAiState] = useState<ChatState>('idle');
  const [chatText, setChatText] = useState('');
  const [activeView, setActiveView] = useState<AppView>('workspace');

  const resetSessionData = useCallback(() => {
    setSessionState('idle');
    setSessionId('');
    setMessageText('');
    setMessageState('idle');
    setMessageId('');
    setListState('idle');
    setMessages([]);
    setAiState('idle');
    setChatText('');
  }, []);

  const checkHealth = useCallback(async () => {
    setStatus('checking');
    setVersion('');
    resetSessionData();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(HEALTH_URL, { signal: controller.signal });
      if (!res.ok) {
        setStatus('disconnected');
        return;
      }
      const data = await res.json();
      if (data && data.healthy === true) {
        setStatus('connected');
        setVersion(typeof data.version === 'string' ? data.version : '');
      } else {
        setStatus('disconnected');
      }
    } catch {
      setStatus('disconnected');
    } finally {
      clearTimeout(timer);
    }
  }, [resetSessionData]);

  const createSession = useCallback(async (): Promise<string | null> => {
    setSessionState('creating');
    setSessionId('');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(SESSION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Lovable Code Assistant - Teste',
          permission: SESSION_PERMISSION,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        setSessionState('error');
        return null;
      }
      const data = await res.json();
      if (data && typeof data.id === 'string' && data.id.length > 0) {
        setSessionId(data.id);
        setSessionState('created');
        return data.id;
      }
      setSessionState('error');
      return null;
    } catch {
      setSessionState('error');
      return null;
    } finally {
      clearTimeout(timer);
    }
  }, []);

  const sendMessage = useCallback(async () => {
    const text = messageText.trim();
    if (sessionId.length === 0 || text.length === 0) {
      return;
    }
    setMessageState('sending');
    setMessageId('');
    setListState('idle');
    setMessages([]);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(
        `${SESSION_URL}/${encodeURIComponent(sessionId)}/message`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            noReply: true,
            parts: [{ type: 'text', text }],
          }),
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        setMessageState('error');
        return;
      }
      const data = await res.json();
      const returnedId =
        data && data.info && typeof data.info.id === 'string'
          ? data.info.id
          : '';
      if (returnedId.length > 0) {
        setMessageId(returnedId);
      }
      setMessageState('sent');
    } catch {
      setMessageState('error');
    } finally {
      clearTimeout(timer);
    }
  }, [messageText, sessionId]);

  const loadMessages = useCallback(async () => {
    if (sessionId.length === 0) {
      return;
    }
    setListState('loading');
    setMessages([]);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(
        `${SESSION_URL}/${encodeURIComponent(sessionId)}/message`,
        { signal: controller.signal },
      );
      if (!res.ok) {
        setListState('error');
        return;
      }
      const data = await res.json();
      if (!Array.isArray(data)) {
        setListState('error');
        return;
      }
      const parsed: ListedMessage[] = [];
      for (const item of data) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const role =
          item.info && typeof item.info.role === 'string'
            ? item.info.role
            : 'user';
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
      setMessages(parsed);
      setListState('loaded');
    } catch {
      setListState('error');
    } finally {
      clearTimeout(timer);
    }
  }, [sessionId]);

  useEffect(() => {
    checkHealth();
  }, [checkHealth]);

  useEffect(() => {
    const el = historyRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, listState]);

  const sendChat = useCallback(async () => {
    const text = chatText.trim();
    if (
      text.length === 0 ||
      aiState === 'answering' ||
      aiState === 'preparing'
    ) {
      return;
    }
    let id = sessionId;
    if (id.length === 0) {
      setAiState('preparing');
      const created = await createSession();
      if (!created) {
        setAiState('error');
        return;
      }
      id = created;
    }
    setAiState('answering');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const res = await fetch(
        `${SESSION_URL}/${encodeURIComponent(id)}/message`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: AI_MODEL,
            variant: AI_VARIANT,
            noReply: false,
            tools: AI_TOOLS,
            parts: [{ type: 'text', text }],
          }),
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        setAiState('error');
        return;
      }
      await res.json();
      setChatText('');
      setAiState('idle');
      await loadMessages();
    } catch {
      setAiState('error');
    } finally {
      clearTimeout(timer);
    }
  }, [chatText, sessionId, aiState, createSession, loadMessages]);

  if (activeView === 'settings') {
    return (
      <div className="container">
        <div className="settings">
          <header className="settings-header">
            <button
              type="button"
              className="btn btn-ghost btn-back"
              onClick={() => setActiveView('workspace')}
              aria-label="Voltar para o workspace"
            >
              ←
            </button>
            <h2 className="settings-title">CONFIGURAÇÕES</h2>
          </header>
          <section className="card settings-card">
            <div className="set-group">
              <span className="label">CONEXÃO</span>
              <div className="set-row">
                <span className="set-key">Status</span>
                {status === 'checking' && (
                  <span className="status status-checking">Verificando...</span>
                )}
                {status === 'connected' && (
                  <span className="status status-online">🟢 Conectado</span>
                )}
                {status === 'disconnected' && (
                  <span className="status status-offline">🔴 Desconectado</span>
                )}
              </div>
              <div className="set-row">
                <span className="set-key">Versão</span>
                <span className="mono set-val">{version}</span>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={checkHealth}
              >
                Verificar conexão
              </button>
            </div>
            <div className="set-group">
              <span className="label">MODELO E MODO</span>
              <div className="set-row">
                <span className="set-key">Modelo</span>
                <span className="set-val">Muse Spark 1.3 Free</span>
              </div>
              <div className="set-row">
                <span className="set-key">Provider</span>
                <span className="set-val muted">OpenCode Zen</span>
              </div>
              <div className="set-row">
                <span className="set-key">Modo</span>
                <span className="set-val">Medium</span>
              </div>
              <div className="set-row">
                <span className="set-key">Trabalho</span>
                <span className="set-val">Análise · Somente leitura</span>
              </div>
              <p className="muted set-note">
                Pode analisar os arquivos do projeto. Alterações estão
                bloqueadas.
              </p>
            </div>
            <div className="set-group">
              <span className="label">SESSÃO</span>
              {sessionState === 'creating' && <p>Criando sessão...</p>}
              {sessionId.length > 0 ? (
                <p className="mono mono-truncate" title={sessionId}>
                  {sessionId}
                </p>
              ) : (
                sessionState !== 'creating' && (
                  <p className="muted">Nenhuma sessão iniciada.</p>
                )
              )}
              {sessionState === 'error' && (
                <p className="error">Não foi possível criar a sessão.</p>
              )}
            </div>
            <div className="set-group set-debug">
              <span className="label">FERRAMENTAS DE TESTE</span>
              <label className="field-label" htmlFor="test-message">
                Mensagem de teste
              </label>
              <input
                id="test-message"
                className="field"
                type="text"
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                placeholder="Digite uma mensagem de teste"
              />
              {messageState === 'idle' || messageState === 'error' ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={sendMessage}
                >
                  Enviar sem executar IA
                </button>
              ) : null}
              {messageState === 'sending' && <p>Enviando...</p>}
              {messageState === 'sent' && (
                <>
                  <p className="success">Mensagem registrada na sessão.</p>
                  {messageId.length > 0 && (
                    <p className="mono">ID: {messageId}</p>
                  )}
                </>
              )}
              {messageState === 'error' && (
                <p className="error">Não foi possível registrar a mensagem.</p>
              )}
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={loadMessages}
              >
                Carregar mensagens
              </button>
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="workspace">
        <header className="ws-header">
          <span className="brand-mark brand-mark-sm" aria-hidden="true" />
          <div className="ws-titles">
            <h1 className="ws-title">LOVABLE CODE ASSISTANT</h1>
            <p className="ws-mode">ANÁLISE • SOMENTE LEITURA</p>
          </div>
          {status === 'connected' ? (
            <span className="conn conn-online" title="Conectado ao OpenCode">
              ● Online
            </span>
          ) : (
            <span className="conn conn-offline" title="Desconectado do OpenCode">
              ● Offline
            </span>
          )}
          <button
            type="button"
            className="icon-btn"
            onClick={() => setActiveView('settings')}
            aria-label="Abrir configurações"
            title="Configurações"
          >
            ⚙
          </button>
        </header>
        {status !== 'connected' ? (
          <div className="conversation">
            <section className="card">
              <span className="label">OPEN CODE</span>
              {status === 'checking' ? (
                <p className="status status-checking">Verificando...</p>
              ) : (
                <>
                  <p className="status status-offline">🔴 Desconectado</p>
                  <p className="muted">
                    Inicie o OpenCode local para continuar.
                  </p>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={checkHealth}
                  >
                    Tentar novamente
                  </button>
                </>
              )}
            </section>
          </div>
        ) : (
          <>
            <div className="conversation" ref={historyRef}>
              {messages.length === 0 &&
              listState !== 'loading' &&
              aiState !== 'preparing' &&
              aiState !== 'answering' ? (
                <div className="empty-state">
                  <span className="empty-orb" aria-hidden="true" />
                  <p className="empty-title">PRONTO PARA COMEÇAR</p>
                  <p className="muted">
                    Descreva o que você quer criar, corrigir ou analisar.
                  </p>
                  <p className="mode-badge">MODO ANÁLISE • SOMENTE LEITURA</p>
                </div>
              ) : (
                <div className="messages">
                  {messages.map((m, i) => (
                    <div
                      key={i}
                      className={
                        m.role === 'assistant' ? 'msg msg-ai' : 'msg msg-user'
                      }
                    >
                      <span className="msg-author">
                        {m.role === 'assistant' ? 'OpenCode' : 'Você'}
                      </span>
                      <span className="msg-text">{m.text}</span>
                    </div>
                  ))}
                </div>
              )}
              {listState === 'loading' && <p>Carregando mensagens...</p>}
              {listState === 'error' && (
                <p className="error">
                  Não foi possível carregar as mensagens.
                </p>
              )}
              {aiState === 'preparing' && <p>Preparando sessão...</p>}
              {aiState === 'answering' && (
                <p className="thinking">Muse Spark está respondendo...</p>
              )}
              {aiState === 'error' && (
                <p className="error">
                  Não foi possível obter resposta do Muse Spark.
                </p>
              )}
            </div>
            <div className="composer">
              <textarea
                id="chat-message"
                className="field composer-field"
                rows={2}
                value={chatText}
                onChange={(e) => setChatText(e.target.value)}
                placeholder="Descreva o que você quer fazer..."
                disabled={
                  aiState === 'answering' || aiState === 'preparing'
                }
              />
              <button
                type="button"
                className="btn btn-send"
                onClick={sendChat}
                disabled={
                  chatText.trim().length === 0 ||
                  aiState === 'answering' ||
                  aiState === 'preparing'
                }
                aria-label="Enviar mensagem"
                title="Enviar"
              >
                ➤
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default App;
