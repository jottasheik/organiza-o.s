const { google } = require('googleapis');
const crypto = require('crypto');

// Escopos mínimos necessários para o app funcionar sem alertas excessivos:
// - drive.file: Só acessa/edita os arquivos e planilhas que o próprio app cria
// - calendar.events: Cria, altera e remove eventos na agenda do usuário
// - userinfo.email e userinfo.profile: Identifica o cliente
const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.file'
];

function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/auth/google/callback';

  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID ou GOOGLE_CLIENT_SECRET não configurados no arquivo .env');
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function getAuthenticatedClient(refreshToken) {
  const client = getOAuth2Client();
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

function generateAuthUrl(state = '') {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // Garante que o Google sempre envie o refresh_token
    scope: SCOPES,
    state: state,
    include_granted_scopes: true
  });
}

async function exchangeCodeForTokens(code) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  return tokens;
}

async function getUserProfile(client) {
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const { data } = await oauth2.userinfo.get();
  return data;
}

// ============================================================
// PROVISIONAMENTO AUTOMÁTICO DA PLANILHA GOOGLE
// ============================================================
async function createSpreadsheetForUser(client, userTitle = 'Direito Bancário') {
  const sheets = google.sheets({ version: 'v4', auth: client });

  // 1. Cria a planilha com as 4 abas estruturadas
  const response = await sheets.spreadsheets.create({
    requestBody: {
      properties: {
        title: `Alta Performance - ${userTitle} (Oficial)`
      },
      sheets: [
        { properties: { title: 'Resumo', tabColor: { red: 0.1, green: 0.45, blue: 0.85 } } },
        { properties: { title: 'Reuniões', tabColor: { red: 0.25, green: 0.35, blue: 0.95 } } },
        { properties: { title: 'Leads', tabColor: { red: 0.1, green: 0.7, blue: 0.4 } } },
        { properties: { title: 'Prospecção', tabColor: { red: 0.95, green: 0.6, blue: 0.1 } } }
      ]
    }
  });

  const spreadsheetId = response.data.spreadsheetId;

  // 2. Preenche os cabeçalhos iniciais em cada aba
  const headerData = [
    {
      range: 'Resumo!A1:C1',
      values: [['Indicador / Métrica', 'Valor Consolidado', 'Observações']]
    },
    {
      range: 'Reuniões!A1:J1',
      values: [[
        'ID Reunião',
        'Data',
        'Horário',
        'Duração (min)',
        'Cliente / Lead',
        'Tipo',
        'Local / Formato',
        'Link Google Meet',
        'Status',
        'Pauta & Anotações'
      ]]
    },
    {
      range: 'Leads!A1:I1',
      values: [[
        'ID Lead',
        'Nome Completo',
        'WhatsApp / Contato',
        'Área / Causa',
        'Primeiro Contato',
        'Data Resposta',
        'Status do Lead',
        'Valor Fechado (R$)',
        'Últimas Observações'
      ]]
    },
    {
      range: 'Prospecção!A1:C1',
      values: [[
        'Data da Prospecção',
        'Ligações / Abordagens Feitas',
        'Data de Registro'
      ]]
    }
  ];

  for (const item of headerData) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: item.range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: item.values }
    });
  }

  return {
    spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`
  };
}

// ============================================================
// SINCRONIZAÇÃO COMPLETA DE DADOS COM A PLANILHA GOOGLE
// ============================================================
async function syncAllDataToSheet(client, spreadsheetId, data) {
  const sheets = google.sheets({ version: 'v4', auth: client });

  const outreach = Array.isArray(data.outreach) ? data.outreach : [];
  const leads = Array.isArray(data.leads) ? data.leads : [];
  const meetings = Array.isArray(data.meetings) ? data.meetings : [];

  // Calcula totais para o Resumo
  const totalLeads = leads.length;
  const fechados = leads.filter(l => l.status === 'fechado');
  const totalFaturado = fechados.reduce((acc, l) => acc + (parseFloat(l.closing?.value) || 0), 0);
  const totalOutreach = outreach.reduce((acc, o) => acc + (parseInt(o.count) || 0), 0);
  const totalReunioes = meetings.length;
  const reunioesRealizadas = meetings.filter(m => m.status === 'realizada').length;

  const resumoRows = [
    ['Total de Abordagens / Ligações', totalOutreach, 'Soma histórica de ligações e mensagens'],
    ['Total de Leads Cadastrados', totalLeads, 'Total de oportunidades recebidas'],
    ['Total de Reuniões Marcadas', totalReunioes, 'Agendadas no sistema'],
    ['Reuniões Realizadas', reunioesRealizadas, 'Reuniões concluídas com sucesso'],
    ['Contratos Fechados', fechados.length, 'Leads convertidos em clientes'],
    ['Faturamento Total Fechado', `R$ ${totalFaturado.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`, 'Receita de contratos'],
    ['Última Sincronização Automática', new Date().toLocaleString('pt-BR'), 'Sincronizado automaticamente via Firebase']
  ];

  // Monta linhas de Reuniões
  const reunioesRows = meetings.map(m => {
    const lead = leads.find(l => l.id === m.leadId);
    const clientName = lead ? lead.name : (m.title || 'Cliente');
    return [
      m.id || '',
      m.date || '',
      m.time || '',
      m.duration || 30,
      clientName,
      m.type || 'Videochamada',
      m.location || 'Online',
      m.meetLink || '',
      m.status || 'agendada',
      m.notes || ''
    ];
  });

  // Monta linhas de Leads
  const leadsRows = leads.map(l => {
    const lastNote = (l.notes && l.notes.length > 0) ? l.notes[l.notes.length - 1].text : '';
    const valor = l.closing?.value ? `R$ ${parseFloat(l.closing.value).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : '-';
    return [
      l.id || '',
      l.name || '',
      l.phone || '',
      l.caseType || '',
      l.contactDate || '',
      l.replyDate || '',
      l.status || 'novo',
      valor,
      lastNote
    ];
  });

  // Monta linhas de Prospecção
  const outreachRows = outreach.map(o => [
    o.date || '',
    o.count || 0,
    new Date().toLocaleDateString('pt-BR')
  ]);

  // Limpa e atualiza cada aba
  const updateTab = async (tabName, maxCol, rows) => {
    try {
      await sheets.spreadsheets.values.clear({
        spreadsheetId,
        range: `${tabName}!A2:${maxCol}1000`
      });
      if (rows.length > 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${tabName}!A2`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: rows }
        });
      }
    } catch (e) {
      console.warn(`Aviso ao atualizar aba ${tabName}:`, e.message);
    }
  };

  await updateTab('Resumo', 'C', resumoRows);
  await updateTab('Reuniões', 'J', reunioesRows);
  await updateTab('Leads', 'I', leadsRows);
  await updateTab('Prospecção', 'C', outreachRows);

  return { ok: true, syncedAt: new Date().toISOString() };
}

// ============================================================
// INTEGRAÇÃO COM GOOGLE AGENDA + GOOGLE MEET
// ============================================================
async function createOrUpdateGoogleMeeting(client, meetingData) {
  const calendar = google.calendar({ version: 'v3', auth: client });

  // Converte data e hora para ISO 8601 com fuso horário local (-03:00)
  const duration = parseInt(meetingData.duration) || 30;
  const startIso = `${meetingData.date}T${meetingData.time}:00-03:00`;
  const startDate = new Date(startIso);
  const endDate = new Date(startDate.getTime() + duration * 60 * 1000);
  const endIso = endDate.toISOString();

  const summary = meetingData.title || `Reunião: ${meetingData.clientName || 'Cliente'}`;
  const description = [
    `Reunião agendada pelo Sistema Alta Performance`,
    meetingData.clientName ? `Cliente: ${meetingData.clientName}` : '',
    meetingData.clientPhone ? `WhatsApp: ${meetingData.clientPhone}` : '',
    meetingData.type ? `Formato: ${meetingData.type}` : '',
    meetingData.notes ? `Pauta: ${meetingData.notes}` : ''
  ].filter(Boolean).join('\n');

  const attendees = [];
  if (meetingData.clientEmail) {
    attendees.push({ email: meetingData.clientEmail, displayName: meetingData.clientName || 'Cliente' });
  }

  const requestBody = {
    summary,
    description,
    location: meetingData.location || (meetingData.type === 'presencial' ? 'Escritório' : 'Google Meet'),
    start: { dateTime: startIso },
    end: { dateTime: endIso },
    attendees,
    conferenceData: {
      createRequest: {
        requestId: `meet_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    }
  };

  let eventResponse;
  if (meetingData.googleEventId) {
    // Atualiza evento existente
    try {
      eventResponse = await calendar.events.patch({
        calendarId: 'primary',
        eventId: meetingData.googleEventId,
        requestBody,
        conferenceDataVersion: 1
      });
    } catch (e) {
      // Se o evento foi excluído manualmente na agenda, recria
      eventResponse = await calendar.events.insert({
        calendarId: 'primary',
        requestBody,
        conferenceDataVersion: 1
      });
    }
  } else {
    // Insere novo evento
    eventResponse = await calendar.events.insert({
      calendarId: 'primary',
      requestBody,
      conferenceDataVersion: 1
    });
  }

  const event = eventResponse.data;
  const meetLink = event.hangoutLink || (event.conferenceData?.entryPoints?.[0]?.uri) || '';

  return {
    ok: true,
    eventId: event.id,
    eventUrl: event.htmlLink,
    meetLink: meetLink
  };
}

async function deleteGoogleMeeting(client, eventId) {
  if (!eventId) return { ok: true };
  const calendar = google.calendar({ version: 'v3', auth: client });
  try {
    await calendar.events.delete({
      calendarId: 'primary',
      eventId: eventId
    });
    return { ok: true };
  } catch (err) {
    console.warn(`Evento ${eventId} não encontrado ou já excluído na Google Agenda:`, err.message);
    return { ok: true, notFound: true };
  }
}

// ============================================================
// CRIPTOGRAFIA DE REFRESH TOKEN (AES-256-CBC)
// ============================================================
const ENCRYPTION_KEY = crypto.scryptSync(
  process.env.SESSION_SECRET || 'chave-secreta-padrao-alta-performance-2026',
  'salt_apex',
  32
);

function encryptToken(plainText) {
  if (!plainText) return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

function decryptToken(cipherText) {
  if (!cipherText || !cipherText.includes(':')) return cipherText;
  try {
    const [ivHex, encrypted] = cipherText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('Falha ao decodificar token:', err.message);
    return null;
  }
}

module.exports = {
  SCOPES,
  getOAuth2Client,
  getAuthenticatedClient,
  generateAuthUrl,
  exchangeCodeForTokens,
  getUserProfile,
  createSpreadsheetForUser,
  syncAllDataToSheet,
  createOrUpdateGoogleMeeting,
  deleteGoogleMeeting,
  encryptToken,
  decryptToken
};
