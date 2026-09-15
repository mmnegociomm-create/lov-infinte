import { useCallback, useEffect, useState } from 'react';

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
  read: false,
  glob: false,
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

type Status = 'checking' | 'connected' | 'disconnected';
type SessionState = 'idle' | 'creating' | 'created' | 'error';
type MessageState = 'idle' | 'sending' | 'sent' | 'error';
type ListState = 'idle' | 'loading' | 'loaded' | 'error';
type ChatState = 'idle' | 'answering' | 'error';

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
  const [aiState, setAiState] = useState<ChatState>('idle');
  const [chatText, setChatText] = useState('');

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

  const createSession = useCallback(async () => {
    setSessionState('creating');
    setSessionId('');
    setMessageText('');
    setMessageState('idle');
    setMessageId('');
    setListState('idle');
    setMessages([]);
    setAiState('idle');
    setChatText('');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(SESSION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Lovable Code Assistant - Teste' }),
        signal: controller.signal,
      });
      if (!res.ok) {
        setSessionState('error');
        return;
      }
      const data = await res.json();
      if (data && typeof data.id === 'string' && data.id.length > 0) {
        setSessionId(data.id);
        setSessionState('created');
      } else {
        setSessionState('error');
      }
    } catch {
      setSessionState('error');
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

  const sendChat = useCallback(async () => {
    const text = chatText.trim();
    if (sessionId.length === 0 || text.length === 0) {
      return;
    }
    setAiState('answering');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const res = await fetch(
        `${SESSION_URL}/${encodeURIComponent(sessionId)}/message`,
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
  }, [chatText, sessionId, loadMessages]);

  return (
    <div className="container">
      <header className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <div className="brand-text">
          <h1 className="brand-title">Lovable Code Assistant</h1>
          <p className="brand-subtitle">AI DEVELOPMENT COPILOT</p>
        </div>
      </header>
      {status === 'checking' && (
        <section className="card">
          <span className="label">OPEN CODE</span>
          <p className="status status-checking">Verificando...</p>
        </section>
      )}
      {status === 'connected' && (
        <>
          <section className="card card-status">
            <span className="label">OPEN CODE</span>
            <div className="status-row">
              <p className="status status-online">🟢 Conectado</p>
              <p className="version mono">v{version}</p>
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={checkHealth}
            >
              Verificar conexão
            </button>
          </section>
          {sessionState === 'idle' && (
            <section className="card">
              <span className="label">SESSÃO</span>
              <button
                type="button"
                className="btn btn-primary"
                onClick={createSession}
              >
                Iniciar sessão
              </button>
            </section>
          )}
          {sessionState === 'creating' && (
            <section className="card">
              <span className="label">SESSÃO</span>
              <p>Criando sessão...</p>
            </section>
          )}
          {sessionState === 'created' && (
            <>
              <section className="card">
                <span className="label">SESSÃO</span>
                <p className="success">Sessão criada com sucesso.</p>
                <p className="mono mono-truncate" title={sessionId}>
                  {sessionId}
                </p>
              </section>
              <section className="card card-chat">
                <span className="label">CHAT IA</span>
                <div className="history">
                  {listState === 'idle' && (
                    <p className="muted">
                      O histórico aparecerá aqui após carregar as mensagens.
                    </p>
                  )}
                  {listState === 'loading' && <p>Carregando mensagens...</p>}
                  {listState === 'loaded' && (
                    <>
                      {messages.length === 0 ? (
                        <p className="muted">Nenhuma mensagem nesta sessão.</p>
                      ) : (
                        <div className="messages">
                          {messages.map((m, i) => (
                            <div
                              key={i}
                              className={
                                m.role === 'assistant'
                                  ? 'msg msg-ai'
                                  : 'msg msg-user'
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
                    </>
                  )}
                  {listState === 'error' && (
                    <p className="error">
                      Não foi possível carregar as mensagens.
                    </p>
                  )}
                </div>
                <div className="chat-input">
                  <label className="field-label" htmlFor="chat-message">
                    Mensagem
                  </label>
                  <input
                    id="chat-message"
                    className="field"
                    type="text"
                    value={chatText}
                    onChange={(e) => setChatText(e.target.value)}
                    placeholder="Digite o que você quer perguntar..."
                  />
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={sendChat}
                    disabled={
                      chatText.trim().length === 0 || aiState === 'answering'
                    }
                  >
                    Enviar
                  </button>
                  {aiState === 'answering' && (
                    <p className="thinking">Muse Spark está respondendo...</p>
                  )}
                  {aiState === 'error' && (
                    <p className="error">
                      Não foi possível obter resposta do Muse Spark.
                    </p>
                  )}
                </div>
              </section>
              <section className="card card-debug">
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
                    className="btn btn-secondary"
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
                  className="btn btn-secondary"
                  onClick={loadMessages}
                >
                  Carregar mensagens
                </button>
              </section>
            </>
          )}
          {sessionState === 'error' && (
            <section className="card">
              <span className="label">SESSÃO</span>
              <p className="error">Não foi possível criar a sessão.</p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={createSession}
              >
                Iniciar sessão
              </button>
            </section>
          )}
          {sessionId.length === 0 && (
            <div className="empty-state">
              <span className="empty-orb" aria-hidden="true" />
              <p className="empty-title">PRONTO PARA COMEÇAR</p>
              <p className="muted">
                Inicie uma sessão para conversar com o assistente.
              </p>
            </div>
          )}
        </>
      )}
      {status === 'disconnected' && (
        <section className="card">
          <span className="label">OPEN CODE</span>
          <p className="status status-offline">🔴 Desconectado</p>
          <p className="muted">Inicie o OpenCode local para continuar.</p>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={checkHealth}
          >
            Tentar novamente
          </button>
        </section>
      )}
    </div>
  );
}

export default App;
