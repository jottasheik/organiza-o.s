require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const googleService = require('./google-service');
const firebaseService = require('./firebase-service');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const DATA_FILE = path.join(ROOT_DIR, 'dados-sistema.json');
const CONFIG_FILE = path.join(ROOT_DIR, 'firebase-config.json');

// Inicializa Firebase Admin (se as credenciais existirem no .env ou serviceAccountKey.json)
firebaseService.initFirebaseAdmin();

app.use(cors());
app.use(cookieParser());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

// Helpers de leitura e escrita local de dados
function readJsonSafe(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (raw.trim()) return JSON.parse(raw);
    }
  } catch (err) {
    console.error(`Erro ao ler ${path.basename(filePath)}:`, err.message);
  }
  return fallback;
}

function writeJsonSafe(filePath, data) {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

// Middleware para obter o usuário da sessão
async function getSessionUser(req) {
  const uid = req.cookies?.apex_session_uid || req.headers['x-user-uid'];
  if (!uid) return null;
  return await firebaseService.getUser(uid);
}

// ============================================================
// 1. FLUXO DE LOGIN GOOGLE (ABORDAGEM 2: ZERO SETUP PARA O CLIENTE)
// ============================================================

// Redireciona o cliente para a tela de permissão oficial do Google
app.get('/api/auth/google', (req, res) => {
  try {
    const state = crypto.randomBytes(16).toString('hex');
    res.cookie('oauth_state', state, { maxAge: 10 * 60 * 1000, httpOnly: true });

    const authUrl = googleService.generateAuthUrl(state);
    res.redirect(authUrl);
  } catch (err) {
    console.error('Erro ao gerar URL do Google OAuth:', err.message);
    res.status(500).send(`
      <html>
        <body style="font-family:sans-serif;padding:40px;background:#0f172a;color:#fff;">
          <h2>Configuração de Desenvolvedor Necessária</h2>
          <p>Para o login com o Google funcionar, você precisa definir <code>GOOGLE_CLIENT_ID</code> e <code>GOOGLE_CLIENT_SECRET</code> no arquivo <code>.env</code>.</p>
          <p><a href="/" style="color:#38bdf8;">← Voltar para o Sistema</a></p>
        </body>
      </html>
    `);
  }
});

// Callback chamado pelo Google assim que o cliente clica em "Permitir"
app.get('/api/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.warn('Usuário cancelou ou houve erro no OAuth:', error);
    return res.redirect('/?auth_error=' + encodeURIComponent(error));
  }

  if (!code) {
    return res.redirect('/?auth_error=codigo_ausente');
  }

  try {
    // 1. Troca o código temporário pelos tokens de acesso e refresh permanente
    const tokens = await googleService.exchangeCodeForTokens(code);

    // 2. Obtém os dados do perfil do cliente logado
    const authClient = googleService.getOAuth2Client();
    authClient.setCredentials(tokens);
    const profile = await googleService.getUserProfile(authClient);

    const googleId = profile.id;
    const email = profile.email;
    const name = profile.name || email.split('@')[0];
    const picture = profile.picture || '';

    // 3. Verifica se o usuário já tem uma planilha vinculada no banco/storage
    let user = await firebaseService.getUser(googleId) || await firebaseService.getUser(email);
    let spreadsheetId = user?.spreadsheetId;
    let spreadsheetUrl = user?.spreadsheetUrl;

    // 4. Provisionamento Automático da Planilha se não existir
    if (!spreadsheetId) {
      try {
        console.log(`Criando planilha automática no Google Drive de ${email}...`);
        const sheetInfo = await googleService.createSpreadsheetForUser(authClient, 'Direito Bancário');
        spreadsheetId = sheetInfo.spreadsheetId;
        spreadsheetUrl = sheetInfo.spreadsheetUrl;
        console.log(`Planilha criada com sucesso! ID: ${spreadsheetId}`);

        // Sincroniza os dados locais atuais imediatamente para a nova planilha
        const currentData = readJsonSafe(DATA_FILE, { outreach: [], leads: [], meetings: [] });
        await googleService.syncAllDataToSheet(authClient, spreadsheetId, currentData);
      } catch (sheetErr) {
        console.error('Aviso ao criar planilha automática:', sheetErr.message);
      }
    }

    // 5. Criptografa e salva o refresh_token permanente do cliente
    const existingRefreshToken = user?.refreshToken ? googleService.decryptToken(user.refreshToken) : null;
    const finalRefreshToken = tokens.refresh_token || existingRefreshToken;

    const savedUser = await firebaseService.saveUser({
      googleId,
      email,
      name,
      picture,
      spreadsheetId,
      spreadsheetUrl,
      refreshToken: finalRefreshToken ? googleService.encryptToken(finalRefreshToken) : null,
      lastLoginAt: new Date().toISOString()
    });

    // 6. Gera Custom Token do Firebase (se o Admin estiver ativo)
    let firebaseToken = null;
    try {
      firebaseToken = await firebaseService.createCustomToken(savedUser.uid);
    } catch (e) {}

    // 7. Define cookie de sessão do usuário no navegador (30 dias)
    res.cookie('apex_session_uid', savedUser.uid, {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: false,
      sameSite: 'lax'
    });

    // 8. Redireciona o cliente direto para o sistema já 100% conectado!
    const redirectUrl = `/?auth_status=success&sheet_id=${spreadsheetId || ''}${firebaseToken ? '&fb_token=' + firebaseToken : ''}`;
    res.redirect(redirectUrl);

  } catch (err) {
    console.error('Erro no processamento do callback Google:', err);
    res.redirect('/?auth_error=' + encodeURIComponent(err.message));
  }
});

// Retorna o status da autenticação atual e dados do usuário
app.get('/api/auth/status', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) {
    return res.json({ authenticated: false });
  }

  const hasRefreshToken = !!user.refreshToken;
  res.json({
    authenticated: true,
    user: {
      uid: user.uid,
      email: user.email,
      name: user.name,
      picture: user.picture,
      spreadsheetId: user.spreadsheetId,
      spreadsheetUrl: user.spreadsheetUrl || (user.spreadsheetId ? `https://docs.google.com/spreadsheets/d/${user.spreadsheetId}/edit` : null),
      hasGoogleSync: hasRefreshToken
    }
  });
});

// Desconectar / Logout
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('apex_session_uid');
  res.json({ ok: true });
});

// ============================================================
// 2. GOOGLE AGENDA: CRIAÇÃO AUTOMÁTICA COM GOOGLE MEET
// ============================================================

app.post('/api/google/meeting/sync', async (req, res) => {
  try {
    const user = await getSessionUser(req);
    if (!user || !user.refreshToken) {
      return res.status(401).json({ ok: false, error: 'Conta Google não conectada' });
    }

    const refreshToken = googleService.decryptToken(user.refreshToken);
    if (!refreshToken) {
      return res.status(401).json({ ok: false, error: 'Token de sincronização inválido. Conecte sua conta Google novamente.' });
    }

    const authClient = googleService.getAuthenticatedClient(refreshToken);
    const meetingData = req.body;

    // Cria ou atualiza o evento na Google Agenda com link do Meet
    const result = await googleService.createOrUpdateGoogleMeeting(authClient, meetingData);

    // Se o usuário tem planilha vinculada, já sincroniza os dados da planilha
    if (user.spreadsheetId) {
      const currentData = readJsonSafe(DATA_FILE, { outreach: [], leads: [], meetings: [] });
      // Atualiza a reunião localmente se enviada
      const idx = currentData.meetings.findIndex(m => m.id === meetingData.id);
      if (idx >= 0) {
        currentData.meetings[idx].googleEventId = result.eventId;
        currentData.meetings[idx].meetLink = result.meetLink;
        writeJsonSafe(DATA_FILE, currentData);
      }
      googleService.syncAllDataToSheet(authClient, user.spreadsheetId, currentData).catch(e => {
        console.warn('Aviso de sync em background da planilha:', e.message);
      });
    }

    res.json(result);
  } catch (err) {
    console.error('Erro ao sincronizar reunião na Google Agenda:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/google/meeting/delete', async (req, res) => {
  try {
    const user = await getSessionUser(req);
    if (!user || !user.refreshToken) {
      return res.json({ ok: true, skipped: true });
    }

    const { eventId } = req.body;
    if (!eventId) return res.json({ ok: true });

    const refreshToken = googleService.decryptToken(user.refreshToken);
    const authClient = googleService.getAuthenticatedClient(refreshToken);

    await googleService.deleteGoogleMeeting(authClient, eventId);
    res.json({ ok: true });
  } catch (err) {
    console.warn('Aviso ao excluir evento Google:', err.message);
    res.json({ ok: true });
  }
});

// ============================================================
// 3. GOOGLE PLANILHAS: SINCRONIZAÇÃO COMPLETA SOB DEMANDA
// ============================================================

app.post('/api/google/sheets/sync-all', async (req, res) => {
  try {
    const user = await getSessionUser(req);
    if (!user || !user.refreshToken) {
      return res.status(401).json({ ok: false, error: 'Conta Google não conectada' });
    }

    const refreshToken = googleService.decryptToken(user.refreshToken);
    const authClient = googleService.getAuthenticatedClient(refreshToken);

    let spreadsheetId = user.spreadsheetId || req.body.spreadsheetId;

    // Se ainda não tem planilha, cria agora
    if (!spreadsheetId) {
      const created = await googleService.createSpreadsheetForUser(authClient, 'Direito Bancário');
      spreadsheetId = created.spreadsheetId;
      await firebaseService.saveUser({ ...user, spreadsheetId, spreadsheetUrl: created.spreadsheetUrl });
    }

    const payload = req.body.data || readJsonSafe(DATA_FILE, { outreach: [], leads: [], meetings: [] });
    const result = await googleService.syncAllDataToSheet(authClient, spreadsheetId, payload);

    res.json({
      ok: true,
      spreadsheetId,
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      syncedAt: result.syncedAt
    });
  } catch (err) {
    console.error('Erro ao sincronizar planilha:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================
// 4. API DE DADOS (COMPATIBILIDADE LOCAL + FIRESTORE)
// ============================================================

app.get('/api/data', async (req, res) => {
  const user = await getSessionUser(req);
  let cloudData = null;

  if (user) {
    cloudData = await firebaseService.getUserData(user.uid);
  }

  const localData = readJsonSafe(DATA_FILE, { outreach: [], leads: [], meetings: [], savedAt: null });
  const data = cloudData || localData;

  res.json({ ok: true, data, filePath: DATA_FILE, isCloud: !!cloudData });
});

app.post('/api/data', async (req, res) => {
  try {
    const body = req.body;
    const payload = {
      app: 'alta-performance-direito-bancario',
      version: 4,
      savedAt: new Date().toISOString(),
      outreach: Array.isArray(body.outreach) ? body.outreach : [],
      leads: Array.isArray(body.leads) ? body.leads : [],
      meetings: Array.isArray(body.meetings) ? body.meetings : []
    };

    // 1. Salva sempre no disco local
    writeJsonSafe(DATA_FILE, payload);

    // 2. Se o usuário estiver conectado, salva no Firestore e na Planilha em segundo plano
    const user = await getSessionUser(req);
    if (user) {
      firebaseService.saveUserData(user.uid, payload).catch(e => console.warn('Erro Firestore sync:', e.message));

      if (user.refreshToken && user.spreadsheetId) {
        const refreshToken = googleService.decryptToken(user.refreshToken);
        if (refreshToken) {
          const authClient = googleService.getAuthenticatedClient(refreshToken);
          googleService.syncAllDataToSheet(authClient, user.spreadsheetId, payload).catch(e => {
            console.warn('Erro sync planilha background:', e.message);
          });
        }
      }
    }

    res.json({ ok: true, savedAt: payload.savedAt, filePath: DATA_FILE });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Configuração pública do Firebase para o frontend (vem do .env sem o cliente digitar nada)
app.get('/api/firebase-config', (req, res) => {
  const fileConfig = readJsonSafe(CONFIG_FILE, null);
  const envConfig = {
    apiKey: process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId: process.env.FIREBASE_APP_ID || ''
  };

  const hasEnvConfig = !!(envConfig.apiKey && envConfig.projectId);
  const config = hasEnvConfig ? envConfig : fileConfig;

  res.json({
    ok: true,
    config,
    hasServerCredentials: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
  });
});

app.post('/api/firebase-config', (req, res) => {
  try {
    writeJsonSafe(CONFIG_FILE, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ============================================================
// 5. ARQUIVOS ESTÁTICOS
// ============================================================
app.use(express.static(ROOT_DIR, { index: 'index.html' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log('==========================================================');
  console.log('  SISTEMA ALTA PERFORMANCE - DIREITO BANCÁRIO');
  console.log(`  Servidor ativo em: http://localhost:${PORT}`);
  console.log(`  Fluxo 1-Clique Google OAuth: http://localhost:${PORT}/api/auth/google`);
  console.log('==========================================================');
});
