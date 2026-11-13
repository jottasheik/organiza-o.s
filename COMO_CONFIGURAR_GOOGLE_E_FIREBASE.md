# Guia de Configuração: Abordagem 2 (Zero Configuração para o Cliente)

Este sistema foi implementado na **Abordagem 2**:
* **Você (desenvolvedor)** configura o Google Cloud e o Firebase uma única vez.
* **Qualquer cliente** que acessar o seu sistema verá apenas o botão oficial **"Entrar com o Google"**.
* Ao clicar, o sistema **cria a planilha no Google Drive dele**, conecta a **Google Agenda com links automáticos do Google Meet** e sincroniza tudo com o **Firebase Firestore** sem que o cliente precise preencher nenhuma chave técnica.

---

## 1. Passo a Passo no Google Cloud Console (Única Vez)

1. Acesse o [Google Cloud Console](https://console.cloud.google.com/).
2. Crie um novo projeto (ou selecione o projeto existente do seu sistema).
3. No menu lateral, acesse **APIs e Serviços > Biblioteca** e ative as seguintes APIs:
   - **Google Calendar API** (para criar reuniões e links do Google Meet)
   - **Google Sheets API** (para criar e atualizar a planilha)
   - **Google Drive API** (para manipular arquivos criados pelo app)

4. No menu lateral, clique em **Tela de consentimento OAuth**:
   - Tipo de usuário: Selecione **Externo** e clique em **Criar**.
   - Preencha:
     - **Nome do app:** `Alta Performance - Direito Bancário` (ou o nome do seu sistema)
     - **E-mail de suporte do usuário:** Seu e-mail
     - **Dados de contato do desenvolvedor:** Seu e-mail
   - Em **Escopos**, adicione:
     - `.../auth/userinfo.email`
     - `.../auth/userinfo.profile`
     - `.../auth/calendar.events`
     - `.../auth/drive.file`
   - Em **Usuários de teste** (enquanto o app estiver em modo de teste):
     - Adicione os e-mails do Gmail que você usará para testar.
     - *(Quando for liberar para clientes reais, basta clicar em "Publicar Aplicativo").*

5. No menu lateral, clique em **Credenciais**:
   - Clique em **+ Criar Credenciais > ID do cliente OAuth**.
   - Tipo de aplicativo: **Aplicativo da Web**.
   - Nome: `Cliente Web Sistema`.
   - Em **Origens JavaScript autorizadas**, adicione:
     - `http://localhost:3000`
     - *(Se for publicar na internet, adicione seu domínio: ex: `https://seusistema.web.app`)*
   - Em **URIs de redirecionamento autorizados**, adicione:
     - `http://localhost:3000/api/auth/google/callback`
     - *(Se for publicar na internet: `https://seusistema.web.app/api/auth/google/callback`)*
   - Clique em **Criar** e copie o **Client ID** e o **Client Secret**.

---

## 2. Passo a Passo no Firebase Console (Única Vez)

1. Acesse o [Firebase Console](https://console.firebase.google.com/).
2. Selecione o mesmo projeto do Google Cloud.
3. No menu lateral, ative:
   - **Authentication > Método de login > Google** (Ativar e salvar).
   - **Firestore Database > Criar banco de dados** (Inicie em modo de produção ou teste).
4. No topo, clique na engrenagem ao lado de Visão geral do projeto > **Configurações do Projeto**:
   - Na aba **Geral**, desça até "Seus aplicativos", clique no ícone **Web (`</>`)** e copie os valores:
     - `apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`.
   - Na aba **Contas de serviço**, clique em **Gerar nova chave privada**.
     - Salve o arquivo baixado com o nome `serviceAccountKey.json` na raiz da pasta do sistema.

---

## 3. Preenchendo o Arquivo `.env`

Abra o arquivo `.env` na pasta do sistema e cole os valores:

```env
PORT=3000

# 1. GOOGLE CLOUD OAUTH
GOOGLE_CLIENT_ID=seu_client_id_aqui.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=seu_client_secret_aqui
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/google/callback

# 2. FIREBASE PÚBLICO (Frontend)
FIREBASE_API_KEY=AIzaSy...
FIREBASE_AUTH_DOMAIN=seu-projeto.firebaseapp.com
FIREBASE_PROJECT_ID=seu-projeto
FIREBASE_STORAGE_BUCKET=seu-projeto.appspot.com
FIREBASE_MESSAGING_SENDER_ID=123456789
FIREBASE_APP_ID=1:123456789:web:abcdef

# 3. FIREBASE ADMIN (Backend)
FIREBASE_SERVICE_ACCOUNT_PATH=./serviceAccountKey.json

# 4. CHAVE DE CRIPTOGRAFIA
SESSION_SECRET=alta-performance-direito-bancario-segredo-2026-xyz
```

---

## 4. Como Executar e Testar

1. Dê dois cliques em **`INICIAR_SISTEMA.bat`** (ou execute `node server.js` no terminal).
2. O sistema abrirá automaticamente em `http://localhost:3000`.
3. No topo, clique em **"Entrar com o Google"**.
4. Faça login com qualquer Gmail de teste e clique em **"Permitir"**.
5. **Pronto!** O sistema irá:
   - Criar automaticamente uma planilha no seu Google Drive com as 4 abas estruturadas: `Resumo`, `Reuniões`, `Leads` e `Prospecção`.
   - Conectar sua Google Agenda.
   - Sempre que você clicar em **"Agendar Reunião"**, a reunião será enviada para o seu Google Agenda, um link do **Google Meet** será gerado automaticamente e uma linha será inserida na sua planilha!
