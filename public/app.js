// ─────────────────────────────────────────────────────────────────────────────
// MikroTik Controller — app.js
// Frontend: login JWT, controle de botões, logs, status
// ─────────────────────────────────────────────────────────────────────────────

// ─── Estado ───────────────────────────────────────────────────────────────────
let authToken = sessionStorage.getItem('mkt_token') || null;

const SSH_MESSAGES = [
  'Iniciando conexão SSH...',
  'Autenticando credenciais...',
  'Enviando comando para o dispositivo...',
  'Aguardando resposta do RouterOS...'
];

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (authToken) {
    showMainScreen();
  } else {
    showLoginScreen();
  }

  setupLogin();
  setupNavigation();
  setupCommandCards();
  setupLogout();
});

// ─── Screens ──────────────────────────────────────────────────────────────────
function showLoginScreen() {
  document.getElementById('login-screen').classList.add('active');
  document.getElementById('main-screen').classList.remove('active');
}

function showMainScreen() {
  document.getElementById('login-screen').classList.remove('active');
  document.getElementById('main-screen').classList.add('active');
  loadStatus();
}

// ─── Login ────────────────────────────────────────────────────────────────────
function setupLogin() {
  const form   = document.getElementById('login-form');
  const errBox = document.getElementById('login-error');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = document.getElementById('inp-user').value.trim();
    const password = document.getElementById('inp-pass').value;
    const btn      = document.getElementById('btn-login');
    const btnText  = document.querySelector('.btn-login-text');
    const btnSpin  = document.querySelector('.btn-login-spinner');

    // UI: loading
    btn.disabled = true;
    btnText.textContent = 'Entrando...';
    btnSpin.classList.remove('hidden');
    errBox.classList.add('hidden');

    try {
      const res  = await fetch('/api/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username, password })
      });
      const data = await res.json();

      if (data.success && data.token) {
        authToken = data.token;
        sessionStorage.setItem('mkt_token', authToken);
        showMainScreen();
      } else {
        errBox.textContent = data.message || 'Usuário ou senha inválidos.';
        errBox.classList.remove('hidden');
      }
    } catch {
      errBox.textContent = 'Erro de conexão com o servidor.';
      errBox.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btnText.textContent = 'Entrar';
      btnSpin.classList.add('hidden');
    }
  });
}

// ─── Logout ───────────────────────────────────────────────────────────────────
function setupLogout() {
  document.getElementById('btn-logout').addEventListener('click', () => {
    authToken = null;
    sessionStorage.removeItem('mkt_token');
    showLoginScreen();
  });
}

// ─── Navigation (tabs) ────────────────────────────────────────────────────────
function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;

      // Ativa nav item
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Ativa tab panel
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.getElementById(`tab-${tab}`).classList.add('active');

      // Carrega conteúdo conforme tab
      if (tab === 'logs')   loadLogs();
      if (tab === 'status') loadStatus();
    });
  });

  // Botão refresh de logs
  document.getElementById('btn-refresh-logs').addEventListener('click', loadLogs);
}

// ─── Command Cards ────────────────────────────────────────────────────────────
function setupCommandCards() {
  document.querySelectorAll('.cmd-card').forEach(card => {
    card.addEventListener('click', () => {
      const action = card.dataset.action;
      executeAction(action);
    });
  });
}

// ─── Executar Ação ────────────────────────────────────────────────────────────
async function executeAction(action) {
  const allCards   = document.querySelectorAll('.cmd-card');
  const loading    = document.getElementById('loading-panel');
  const resultBox  = document.getElementById('result-panel');
  const sshLine    = document.getElementById('ssh-line');

  // UI: disabilita botões, esconde resultado anterior
  allCards.forEach(c => c.disabled = true);
  resultBox.classList.add('hidden');
  loading.classList.remove('hidden');

  // Anima mensagens SSH enquanto aguarda
  let msgIndex = 0;
  sshLine.textContent = SSH_MESSAGES[0];
  const msgInterval = setInterval(() => {
    msgIndex = (msgIndex + 1) % SSH_MESSAGES.length;
    sshLine.textContent = SSH_MESSAGES[msgIndex];
  }, 900);

  try {
    const res  = await fetch('/api/execute', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({ action })
    });

    // Token expirado
    if (res.status === 401 || res.status === 403) {
      authToken = null;
      sessionStorage.removeItem('mkt_token');
      showLoginScreen();
      return;
    }

    const data = await res.json();
    showResult(data.success, data.message, data.command, data.label);

  } catch (err) {
    showResult(false, 'Erro de conexão com o backend: ' + err.message, '', 'Erro de rede');
  } finally {
    clearInterval(msgInterval);
    loading.classList.add('hidden');
    allCards.forEach(c => c.disabled = false);
  }
}

// ─── Exibir Resultado ─────────────────────────────────────────────────────────
function showResult(success, message, command, label) {
  const box   = document.getElementById('result-panel');
  const icon  = document.getElementById('result-icon');
  const title = document.getElementById('result-title');
  const cmd   = document.getElementById('result-cmd');
  const msg   = document.getElementById('result-msg');
  const time  = document.getElementById('result-time');

  box.className = 'result-panel ' + (success ? 'ok' : 'err');
  icon.textContent  = success ? '✅' : '❌';
  title.textContent = success ? `Sucesso — ${label || ''}` : `Erro — ${label || ''}`;
  cmd.textContent   = command || '';
  msg.textContent   = message;
  time.textContent  = new Date().toLocaleString('pt-BR');

  box.classList.remove('hidden');
}

// ─── Carregar Status ──────────────────────────────────────────────────────────
async function loadStatus() {
  const container = document.getElementById('status-container');
  const connDot   = document.getElementById('conn-dot');
  const connLabel = document.getElementById('conn-label');

  try {
    const res  = await fetch('/api/status');
    const data = await res.json();

    // Sidebar
    connDot.className = 'conn-dot online';
    connLabel.textContent = data.host;

    // Mock badge
    const badge = document.getElementById('mock-badge');
    if (data.mockMode) badge.classList.remove('hidden');
    else               badge.classList.add('hidden');

    // Renderiza status
    const comandosHtml = (data.comandos || [])
      .map(c => `<div class="status-row"><span class="status-row-key">${c.acao}</span><span class="status-row-value">${c.label}</span></div>`)
      .join('');

    container.innerHTML = `
      <div class="status-card">
        <h3>Dispositivo Alvo</h3>
        <div class="status-row">
          <span class="status-row-key">Host</span>
          <span class="status-row-value">${data.host}</span>
        </div>
        <div class="status-row">
          <span class="status-row-key">Porta SSH</span>
          <span class="status-row-value">${data.port}</span>
        </div>
        <div class="status-row">
          <span class="status-row-key">Modo Mock</span>
          <span class="status-row-value ${data.mockMode ? 'warn' : 'ok'}">${data.mockMode ? 'ATIVADO (simulação)' : 'Desativado (SSH real)'}</span>
        </div>
        <div class="status-row">
          <span class="status-row-key">Backend</span>
          <span class="status-row-value ok">Online ✓</span>
        </div>
      </div>
      <div class="status-card">
        <h3>Comandos Mapeados</h3>
        ${comandosHtml}
      </div>
    `;
  } catch {
    connDot.className = 'conn-dot offline';
    connLabel.textContent = 'Offline';
    container.innerHTML = `<p class="logs-empty">Não foi possível conectar ao backend.</p>`;
  }
}

// ─── Carregar Logs ────────────────────────────────────────────────────────────
async function loadLogs() {
  const container = document.getElementById('logs-container');
  container.innerHTML = '<p class="logs-empty">Carregando...</p>';

  try {
    const res  = await fetch('/api/logs', {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });

    if (res.status === 401 || res.status === 403) {
      authToken = null;
      sessionStorage.removeItem('mkt_token');
      showLoginScreen();
      return;
    }

    const data = await res.json();

    if (!data.logs || data.logs.length === 0) {
      container.innerHTML = '<p class="logs-empty">Nenhum log registrado ainda.</p>';
      return;
    }

    container.innerHTML = data.logs.map(entry => {
      const d      = entry.dados || {};
      const evento = d.evento || '—';
      const isOk   = evento.includes('OK') || evento.includes('LOGIN_OK');
      const isErr  = evento.includes('ERRO') || evento.includes('FALHOU');
      const cls    = isOk ? 'ok' : isErr ? 'err' : '';

      const ts      = entry.ts ? new Date(entry.ts).toLocaleString('pt-BR') : '—';
      const detail  = [d.usuario && `user:${d.usuario}`, d.acao && `ação:${d.acao}`, d.label && d.label, d.erro && `erro: ${d.erro}`, d.mock && '[mock]']
        .filter(Boolean).join(' · ');

      return `<div class="log-entry ${cls}">
        <span class="log-ts">${ts}</span>
        <span class="log-event">${evento}</span>
        <span class="log-detail">${detail || entry.raw || '—'}</span>
      </div>`;
    }).join('');

  } catch {
    container.innerHTML = '<p class="logs-empty">Erro ao carregar logs.</p>';
  }
}