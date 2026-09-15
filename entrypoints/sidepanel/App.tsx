import { useCallback, useEffect, useState } from 'react';

const HEALTH_URL = 'http://127.0.0.1:4096/global/health';
const SESSION_URL = 'http://127.0.0.1:4096/session';

const AI_MODEL = {
  providerID: 'opencode',
  modelID: 'muse-spark-1.3-contributor-free',
};
const AI_VARIANT = 'medium';
const AI_PROMPT = 'Responda exatamente com a frase: Comunicação com IA funcionando.';
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
type AiState = 'idle' | 'answering' | 'answered' | 'error';

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
  const [aiState, setAiState] = useState<AiState>('idle');
  const [aiReply, setAiReply] = useState('');

  const resetSessionData = useCallback(() => {
    setSessionState('idle');
    setSessionId('');
    setMessageText('');
    setMessageState('idle');
    setMessageId('');
    setListState('idle');
    setMessages([]);
    setAiState('idle');
    setAiReply('');
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
    setAiReply('');
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

  const testAi = useCallback(async () => {
    if (sessionId.length === 0) {
      return;
    }
    setAiState('answering');
    setAiReply('');
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
            parts: [{ type: 'text', text: AI_PROMPT }],
          }),
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        setAiState('error');
        return;
      }
      const data = await res.json();
      const texts: string[] = [];
      if (data && Array.isArray(data.parts)) {
        for (const part of data.parts) {
          if (
            part &&
            typeof part === 'object' &&
            part.type === 'text' &&
            typeof part.text === 'string'
          ) {
            texts.push(part.text);
          }
        }
      }
      setAiReply(texts.join(''));
      setAiState('answered');
    } catch {
      setAiState('error');
    } finally {
      clearTimeout(timer);
    }
  }, [sessionId]);

  return (
    <div className="container">
      <h1>Lovable Code Assistant</h1>
      <h2>OpenCode</h2>
      {status === 'checking' && <p>Verificando...</p>}
      {status === 'connected' && (
        <>
          <p>🟢 Conectado</p>
          <p>Versão: {version}</p>
          <button type="button" onClick={checkHealth}>
            Verificar novamente
          </button>
          {sessionState === 'idle' && (
            <button type="button" onClick={createSession}>
              Criar sessão de teste
            </button>
          )}
          {sessionState === 'creating' && <p>Criando sessão...</p>}
          {sessionState === 'created' && (
            <>
              <p>Sessão criada com sucesso.</p>
              <p>ID: {sessionId}</p>
              <label htmlFor="test-message">Mensagem de teste</label>
              <input
                id="test-message"
                type="text"
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                placeholder="Digite uma mensagem de teste"
              />
              {messageState === 'idle' || messageState === 'error' ? (
                <button type="button" onClick={sendMessage}>
                  Enviar sem executar IA
                </button>
              ) : null}
              {messageState === 'sending' && <p>Enviando...</p>}
              {messageState === 'sent' && (
                <>
                  <p>Mensagem registrada na sessão.</p>
                  {messageId.length > 0 && <p>ID: {messageId}</p>}
                </>
              )}
              {messageState === 'error' && (
                <p>Não foi possível registrar a mensagem.</p>
              )}
              <button type="button" onClick={loadMessages}>
                Carregar mensagens
              </button>
              {listState === 'loading' && <p>Carregando mensagens...</p>}
              {listState === 'loaded' && (
                <>
                  <h3>Mensagens da sessão</h3>
                  {messages.length === 0 ? (
                    <p>Nenhuma mensagem nesta sessão.</p>
                  ) : (
                    messages.map((m, i) => (
                      <p key={i}>
                        {m.role === 'assistant' ? 'OpenCode' : 'Você'}: {m.text}
                      </p>
                    ))
                  )}
                </>
              )}
              {listState === 'error' && (
                <p>Não foi possível carregar as mensagens.</p>
              )}
              <h3>Teste de IA</h3>
              {aiState === 'idle' || aiState === 'error' ? (
                <button type="button" onClick={testAi}>
                  Testar Muse Spark
                </button>
              ) : null}
              {aiState === 'answering' && <p>Muse Spark está respondendo...</p>}
              {aiState === 'answered' && (
                <>
                  <p>Resposta do Muse Spark</p>
                  <p>{aiReply}</p>
                </>
              )}
              {aiState === 'error' && (
                <p>Não foi possível obter resposta do Muse Spark.</p>
              )}
            </>
          )}
          {sessionState === 'error' && (
            <>
              <p>Não foi possível criar a sessão.</p>
              <button type="button" onClick={createSession}>
                Criar sessão de teste
              </button>
            </>
          )}
        </>
      )}
      {status === 'disconnected' && (
        <>
          <p>🔴 Desconectado</p>
          <p>Inicie o OpenCode local para continuar.</p>
          <button type="button" onClick={checkHealth}>
            Tentar novamente
          </button>
        </>
      )}
    </div>
  );
}

export default App;
