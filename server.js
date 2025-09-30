// ==========================
// Backend Pix Inter (Node)
// ==========================
// Objetivo: rodar no Render/Railway com o .PFX do Banco Inter (sem converter),
// expor 3 rotas compatíveis com o front do Lovable:
//  POST /pix/cobranca  -> cria cobrança Pix (PUT v2/cob/{txid}) e retorna QR + copia-e-cola
//  GET  /pix/status    -> consulta status em cache (atualizado pelo webhook)
//  POST /pix/webhook   -> recebe notificação do Inter e marca pagamento
//
// ⚠️ Este código usa memória (Map) p/ status de teste. Em produção, plugue um banco (Redis/Postgres).
// ⚠️ Cadastre o webhook da sua chave Pix no Inter apontando para /pix/webhook.
// ⚠️ Validação/assinatura do webhook varia por banco; aqui tratamos validação simples e payload Pix.

import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import axios from 'axios';
import https from 'https';
import crypto from 'crypto';

// ====== Variáveis de ambiente (configure no Render/Railway) ======
// INTER_CLIENT_ID       -> client_id da integração
// INTER_CLIENT_SECRET   -> client_secret da integração
// INTER_PFX_BASE64      -> Conteúdo do .PFX convertido em Base64 (suba o .pfx e cole o base64 do arquivo)
// INTER_PFX_PASSWORD    -> Senha do .PFX
// INTER_PIX_API_BASE    -> Base da API Pix do Inter (ex.: https://cdpj.partners.bancointer.com.br) SEM barra no final
// INTER_OAUTH_URL       -> URL do token OAuth (ex.: https://cdpj.partners.bancointer.com.br/oauth/v2/token)
// PIX_KEY               -> sua chave Pix (para cadastro de webhook no Inter) – opcional aqui
// PORT                  -> porta do servidor (Render define automaticamente)

const {
  INTER_CLIENT_ID,
  INTER_CLIENT_SECRET,
  INTER_PFX_BASE64,
  INTER_PFX_PASSWORD,
  INTER_PIX_API_BASE,
  INTER_OAUTH_URL,
  PIX_KEY,
  PORT
} = process.env;

if(!INTER_CLIENT_ID || !INTER_CLIENT_SECRET || !INTER_PFX_BASE64 || !INTER_PFX_PASSWORD || !INTER_PIX_API_BASE || !INTER_OAUTH_URL){
  console.error('❌ Variáveis de ambiente faltando. Confira INTER_* e URLs.');
}

// Monta httpsAgent com PFX direto (sem conversão)
const pfxBuffer = Buffer.from(INTER_PFX_BASE64 || '', 'base64');
const httpsAgent = new https.Agent({
  pfx: pfxBuffer,
  passphrase: INTER_PFX_PASSWORD,
  keepAlive: true,
  rejectUnauthorized: true,
});

// Cache simples do token em memória
let cachedToken = null;
let tokenExpMs = 0;

async function getOAuthToken(){
  const now = Date.now();
  if(cachedToken && now < tokenExpMs - 5000){
    return cachedToken;
  }
  const params = new URLSearchParams();
  params.set('grant_type', 'client_credentials');
  // escopos do Pix – ajuste conforme seu contrato (ex.: 'pix.read pix.write')
  // Se não souber, tente sem scope; se der 403, peça ao Inter os escopos exatos da sua integração
  // params.set('scope', 'pix.read pix.write');

  const auth = Buffer.from(`${INTER_CLIENT_ID}:${INTER_CLIENT_SECRET}`).toString('base64');

  const r = await axios.post(INTER_OAUTH_URL, params.toString(), {
    headers: { 'Content-Type':'application/x-www-form-urlencoded', 'Authorization': `Basic ${auth}` },
    httpsAgent
  });
  const { access_token, expires_in } = r.data;
  cachedToken = access_token;
  tokenExpMs = now + ((expires_in || 300) * 1000);
  return cachedToken;
}

// Axios para Pix com Bearer + mTLS
async function pixClient(){
  const token = await getOAuthToken();
  return axios.create({
    baseURL: `${INTER_PIX_API_BASE}/pix/v2`,
    headers: { Authorization: `Bearer ${token}` },
    httpsAgent,
    timeout: 15000,
  });
}

// Gera TXID (até 35 chars alfanum) – aqui 26
function genTxid(){
  return crypto.randomBytes(16).toString('hex').slice(0,26);
}

// Armazenamento simples em memória para status: { [txid]: { status, e2eid, valor } }
const statusStore = new Map();

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '1mb' }));

app.get('/', (req,res)=> res.send('OK - Pix Inter backend')); // saúde

// =============================
// POST /pix/cobranca
// body: { valor:number, descricao:string, pedidoId?:string, nomeCliente?:string }
// =============================
app.post('/pix/cobranca', async (req,res)=>{
  try{
    const { valor, descricao, pedidoId, nomeCliente } = req.body || {};
    if(!valor || !descricao){
      return res.status(400).json({ message: 'Informe valor e descricao' });
    }

    const txid = genTxid();
    const client = await pixClient();

    // 1) Criar cobrança: PUT /v2/cob/{txid}
    const cobBody = {
      calendario: { expiracao: 300 }, // 5 minutos
      valor: { original: Number(valor).toFixed(2) },
      chave: PIX_KEY || undefined, // opcional dependendo do provedor; pode vir do contrato
      solicitacaoPagador: descricao,
      infoAdicionais: [
        pedidoId ? { nome: 'pedidoId', valor: String(pedidoId) } : undefined,
        nomeCliente ? { nome: 'cliente', valor: String(nomeCliente) } : undefined,
      ].filter(Boolean)
    };

    await client.put(`/cob/${txid}`, cobBody);

    // 2) Consultar cobrança p/ obter loc.id
    const cob = await client.get(`/cob/${txid}`);
    const locId = cob.data?.loc?.id;
    if(!locId){
      return res.status(500).json({ message: 'Cobrança criada, mas sem loc.id' });
    }

    // 3) Buscar QR code: GET /v2/loc/{id}/qrcode (fora do /pix/v2 na maioria dos bancos do arranjo BACEN)
    // Alguns provedores expõem em /pix/v2/loc; aqui tentamos primeiro base /pix/v2, se 404 tentamos /v2
    let qrData;
    try{
      const r1 = await client.get(`/loc/${locId}/qrcode`);
      qrData = r1.data; // { qrcode, imagemQrcode }
    } catch(err){
      // fallback: tentar base do arranjo BACEN sem o prefixo /pix
      const token = await getOAuthToken();
      const r2 = await axios.get(`${INTER_PIX_API_BASE}/v2/loc/${locId}/qrcode`, {
        headers: { Authorization: `Bearer ${token}` }, httpsAgent
      });
      qrData = r2.data;
    }

    // guarda status como pendente
    statusStore.set(txid, { status: 'PENDENTE', valor: Number(valor) });

    const copiaECola = qrData?.qrcode || '';
    const qrCodeBase64 = qrData?.imagemQrcode || '';
    return res.json({ txid, copiaECola, qrCodeBase64, expiraEm: 300 });

  } catch(err){
    console.error('Erro /pix/cobranca', err.response?.status, err.response?.data || err.message);
    return res.status(500).json({ message: 'Falha ao criar cobrança', detalhe: err.response?.data || err.message });
  }
});

// =============================
// GET /pix/status?txid=
// =============================
app.get('/pix/status', async (req,res)=>{
  const { txid } = req.query;
  const item = txid ? statusStore.get(String(txid)) : null;
  if(!item){ return res.json({ txid, status: 'DESCONHECIDO' }); }
  return res.json({ txid, ...item });
});

// =============================
// POST /pix/webhook
// Inter chamará aqui quando houver Pix recebido.
// Trata dois formatos comuns:
//  - Validação (GET/HEAD/POST com header ou query de desafio)
//  - Notificação (body.pix = [ { txid, endToEndId, valor, ... } ])
// =============================
app.all('/pix/webhook', async (req,res)=>{
  try{
    // 1) Tentativa de validação simples por header
    const challenge = req.headers['x-webhook-validation'] || req.query?.validation || req.body?.validation;
    if(challenge){
      return res.status(200).send(String(challenge));
    }

    // 2) Notificação Pix padrão BACEN: { pix: [ { txid, endToEndId, valor, ... } ] }
    const payload = req.body || {};
    if(Array.isArray(payload.pix)){
      payload.pix.forEach(evt => {
        const txid = evt.txid;
        if(txid){
          const prev = statusStore.get(txid) || {};
          statusStore.set(txid, {
            ...prev,
            status: 'PAGO',
            e2eid: evt.endToEndId || prev.e2eid,
            valor: prev.valor || Number(evt.valor || 0),
            horaPagamento: evt.horario || new Date().toISOString(),
          });
        }
      });
      return res.status(200).json({ ok: true });
    }

    // 3) Outros formatos – marque recebido mas logue
    console.log('Webhook recebido (formato não reconhecido):', payload);
    return res.status(200).json({ ok: true });

  } catch(err){
    console.error('Erro webhook', err.message);
    return res.status(200).end(); // evite reentrega em loop – logar e tratar depois
  }
});

const port = Number(PORT) || 8080;
app.listen(port, ()=> console.log(`✅ Backend Pix Inter rodando na porta ${port}`));
