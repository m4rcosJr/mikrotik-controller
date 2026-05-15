// ─────────────────────────────────────────────────────────────────────────────
// mikrotik-controller / server.js
// Backend principal: Express + SSH2 + JWT + Rate Limiting + Mock Mode + Logs
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

const express    = require('express');
const { Client } = require('ssh2');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const rateLimit  = require('express-rate-limit');
const jwt        = require('jsonwebtoken');

const app = express();

// ─────────────────────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limiting — máximo 30 requisições por minuto por IP
// ─────────────────────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Muitas requisições. Aguarde 1 minuto e tente novamente.'
  }
});
app.use('/api/', apiLimiter);

// ─────────────────────────────────────────────────────────────────────────────
// Log de Auditoria
// ─────────────────────────────────────────────────────────────────────────────
const LOG_DIR  = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'auditoria.log');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

function writeLog(entry) {
  const line = `[${new Date().toISOString()}] ${JSON.stringify(entry)}\n`;
  fs.appendFileSync(LOG_FILE, line, 'utf8');
  console.log(line.trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// Comandos permitidos (whitelist — única fonte de verdade)
// ─────────────────────────────────────────────────────────────────────────────
const ALLOWED_COMMANDS = {
  disable_ether1: {
    label:   'Desabilitar ether1',
    command: 'interface ether set [find default-name=ether1] disabled=yes'
  },
  disable_ether2: {
    label:   'Desabilitar ether2',
    command: 'interface ether set [find default-name=ether2] disabled=yes'
  },
  disable_ether3: {
    label:   'Desabilitar ether3',
    command: 'interface ether set [find default-name=ether3] disabled=yes'
  },
  enable_ether4: {
    label:   'Habilitar ether4',
    command: 'interface ether set [find default-name=ether4] disabled=no'
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Middleware de Autenticação JWT
// ─────────────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token      = authHeader && authHeader.split(' ')[1]; // Bearer <token>

  if (!token) {
    return res.status(401).json({ success: false, message: 'Token não fornecido.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ success: false, message: 'Token inválido ou expirado.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Função SSH — real ou mock conforme MOCK_MODE
// ─────────────────────────────────────────────────────────────────────────────
function executeSSH(command) {
  // ── MOCK MODE ──
  if (process.env.MOCK_MODE === 'true') {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        // Simula falha ocasional (~10%) para testar tratamento de erro
        if (Math.random() < 0.1) {
          return reject(new Error('[MOCK] Timeout de conexão SSH simulado'));
        }
        resolve('[MOCK] Comando executado com sucesso (modo simulação)');
      }, 600 + Math.random() * 600); // delay realista: 600ms–1200ms
    });
  }

  // ── SSH REAL ──
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output      = '';
    let errorOutput = '';

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          conn.end();
          return reject(err);
        }

        stream.on('data', (data)        => { output      += data.toString(); });
        stream.stderr.on('data', (data) => { errorOutput += data.toString(); });

        stream.on('close', (code) => {
          conn.end();
          if (code !== 0 && errorOutput) {
            reject(new Error(errorOutput.trim()));
          } else {
            resolve(output.trim() || 'Comando executado com sucesso');
          }
        });
      });
    });

    conn.on('error', (err) => reject(err));

    conn.connect({
      host:         process.env.MIKROTIK_HOST,
      port:         parseInt(process.env.MIKROTIK_PORT, 10),
      username:     process.env.MIKROTIK_USER,
      password:     process.env.MIKROTIK_PASS,
      readyTimeout: 10000,
      // MikroTik usa algoritmos legados — necessário para versões recentes do Node/ssh2
      algorithms: {
        kex: [
          'diffie-hellman-group14-sha256',
          'diffie-hellman-group14-sha1',
          'diffie-hellman-group1-sha1'
        ],
        cipher: [
          'aes128-cbc', 'aes256-cbc',
          'aes128-ctr', 'aes256-ctr',
          '3des-cbc'
        ],
        serverHostKey: ['ssh-rsa', 'ssh-dss'],
        hmac: ['hmac-sha1', 'hmac-sha2-256']
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ROTAS
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/login — retorna JWT
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  if (
    username !== process.env.APP_USER ||
    password !== process.env.APP_PASS
  ) {
    writeLog({ evento: 'LOGIN_FALHOU', username, ip: req.ip });
    return res.status(401).json({ success: false, message: 'Usuário ou senha inválidos.' });
  }

  const token = jwt.sign(
    { username },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );

  writeLog({ evento: 'LOGIN_OK', username, ip: req.ip });
  res.json({ success: true, token });
});

// POST /api/execute — executa comando no MikroTik
app.post('/api/execute', requireAuth, async (req, res) => {
  const { action } = req.body;

  if (!action || !ALLOWED_COMMANDS[action]) {
    return res.status(400).json({
      success: false,
      message: `Ação inválida: "${action}". Ações permitidas: ${Object.keys(ALLOWED_COMMANDS).join(', ')}`
    });
  }

  const { label, command } = ALLOWED_COMMANDS[action];
  const logBase = { acao: action, label, usuario: req.user.username, ip: req.ip, mock: process.env.MOCK_MODE === 'true' };

  try {
    const result = await executeSSH(command);
    writeLog({ ...logBase, evento: 'EXECUCAO_OK', resultado: result });
    res.json({ success: true, message: result, command, label });
  } catch (err) {
    writeLog({ ...logBase, evento: 'EXECUCAO_ERRO', erro: err.message });
    res.status(500).json({ success: false, message: err.message, command, label });
  }
});

// GET /api/status — health check (público)
app.get('/api/status', (req, res) => {
  res.json({
    status:   'online',
    host:     process.env.MIKROTIK_HOST,
    port:     process.env.MIKROTIK_PORT,
    mockMode: process.env.MOCK_MODE === 'true',
    comandos: Object.entries(ALLOWED_COMMANDS).map(([key, val]) => ({
      acao: key, label: val.label
    }))
  });
});

// GET /api/logs — últimas 100 linhas do log (protegido)
app.get('/api/logs', requireAuth, (req, res) => {
  if (!fs.existsSync(LOG_FILE)) {
    return res.json({ logs: [] });
  }
  const lines = fs.readFileSync(LOG_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(-100)
    .reverse()
    .map(line => {
      try {
        const match = line.match(/^\[(.+?)\] (.+)$/);
        return { ts: match[1], dados: JSON.parse(match[2]) };
      } catch {
        return { ts: null, raw: line };
      }
    });
  res.json({ logs: lines });
});

// ─────────────────────────────────────────────────────────────────────────────
// Inicialização
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('─────────────────────────────────────────');
  console.log(`🚀  Servidor: http://localhost:${PORT}`);
  console.log(`🎯  MikroTik: ${process.env.MIKROTIK_HOST}:${process.env.MIKROTIK_PORT}`);
  console.log(`🔧  Mock Mode: ${process.env.MOCK_MODE === 'true' ? 'ATIVADO (simulação)' : 'DESATIVADO (SSH real)'}`);
  console.log('─────────────────────────────────────────');
});