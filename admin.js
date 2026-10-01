/**
 * PIPOCAFLIX — Painel Admin (projeto SEPARADO do site, deploy separado no Vercel)
 *
 * Usa o MESMO Firebase do site (mesmo Auth e mesmo Firestore) — por isso tudo que você
 * faz aqui aparece no site na hora. O que ele faz:
 *   👑 Assinantes    lista/da/estende/revoga VIP           (coleção  vip/{email})
 *   🎫 Reports       responde tickets do suporte           (coleção  tickets + respostas)
 *   🎬 Pedidos       marca pedidos como atendido/recusado  (coleção  pedidos)
 *   ⏱️ Testes grátis  vê quem já usou / libera de novo      (coleção  trial)
 *
 * SEGURANÇA: só o e-mail da lista ADMIN_EMAILS consegue usar o painel, e — mais importante —
 * as regras do Firestore (firestore.rules, "ehAdmin()") também só deixam esse e-mail
 * ler/alterar essas coisas. A checagem daqui é só pra esconder a tela; quem realmente
 * protege os dados são as regras.
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  getFirestore, collection, doc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, query, orderBy, limit,
  onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

const ADMIN_EMAILS = ['canalpedroid@gmail.com'];
const TRIAL_MS = 3 * 60 * 60 * 1000;

const app = initializeApp({
  apiKey: "AIzaSyDQK5iw8v0eVf6auRiVkZzaRJn_I6znbeA",
  authDomain: "pipoca-flix-43de0.firebaseapp.com",
  projectId: "pipoca-flix-43de0",
  storageBucket: "pipoca-flix-43de0.firebasestorage.app",
  messagingSenderId: "504338312989",
  appId: "1:504338312989:web:b4949dd355624811017bf4"
});
const auth = getAuth(app);
const db = getFirestore(app);
const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

let admin = null;               // usuário logado (já validado)
let unsubs = [];                // listeners ativos (encerrados ao sair)

/* ───────── utilidades ───────── */
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), 2600);
}
const emailKeyOf = (email) => String(email || '').trim().toLowerCase().replace(/[.#$[\]]/g, '_');
const validEmail = (e) => /^[^@\s]+@[^@\s]+[.][^@\s]+$/.test(String(e || '').trim());
function ms(v) {                // Timestamp | string ISO | number → milissegundos
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v === 'number') return v;
  const t = Date.parse(v); return isNaN(t) ? 0 : t;
}
function fmtData(v, comHora) {
  const t = ms(v); if (!t) return '—';
  const d = new Date(t);
  return d.toLocaleDateString('pt-BR') + (comHora ? ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');
}
function tag(txt, cls) { return el('span', 'tag tag--' + cls, txt); }
function limpaListeners() { unsubs.forEach((u) => { try { u(); } catch (e) {} }); unsubs = []; }

/* ═══════════════════════ LOGIN ═══════════════════════ */
$('btnEntrar').addEventListener('click', async () => {
  $('loginErro').hidden = true;
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) {
    $('loginErro').textContent = (e && e.code === 'auth/unauthorized-domain')
      ? 'Este domínio ainda não está autorizado no Firebase. Adicione-o em Authentication → Settings → Domínios autorizados.'
      : 'Não deu pra entrar agora. Tenta de novo.';
    $('loginErro').hidden = false;
  }
});
$('btnSair').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  limpaListeners();
  if (!user) { admin = null; $('app').hidden = true; $('telaLogin').hidden = false; return; }
  const ok = user.email && user.emailVerified !== false && ADMIN_EMAILS.includes(user.email.toLowerCase());
  if (!ok) {
    await signOut(auth);
    $('loginErro').textContent = 'A conta ' + (user.email || '') + ' não tem acesso a este painel.';
    $('loginErro').hidden = false;
    $('app').hidden = true; $('telaLogin').hidden = false;
    return;
  }
  admin = user;
  $('userEmail').textContent = user.email;
  $('telaLogin').hidden = true; $('app').hidden = false;
  iniciarPainel();
});

/* ═══════════════════════ ABAS ═══════════════════════ */
const ABAS = ['assinantes', 'reports', 'pedidos', 'testes'];
function abrirAba(nome) {
  if (!ABAS.includes(nome)) nome = 'assinantes';
  document.querySelectorAll('.aba').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.aba === nome)));
  ABAS.forEach((a) => { $('painel-' + a).hidden = a !== nome; });
  try { history.replaceState(null, '', '#' + nome); } catch (e) {}
}
document.querySelectorAll('.aba').forEach((b) => b.addEventListener('click', () => abrirAba(b.dataset.aba)));

function iniciarPainel() {
  abrirAba((location.hash || '').replace('#', ''));
  carregarVip();
  ouvirReports();
  ouvirPedidos();
  carregarTestes();
}

/* ═══════════════════════ 👑 ASSINANTES ═══════════════════════ */
let vipLista = [];

async function carregarVip() {
  try {
    const snap = await getDocs(collection(db, 'vip'));
    vipLista = [];
    snap.forEach((d) => {
      const x = d.data();
      vipLista.push({ id: d.id, email: x.email || d.id, plano: x.plano || '—', ate: ms(x.vip_ate), origem: x.origem || '' });
    });
    vipLista.sort((a, b) => b.ate - a.ate);
    desenharVip();
  } catch (e) {
    console.warn('[Admin] vip:', e && e.code || e);
    $('vazioVip').textContent = 'Não deu pra carregar os assinantes (' + (e && e.code || 'erro') + ').';
    $('vazioVip').hidden = false;
  }
}

function desenharVip() {
  const busca = $('buscaVip').value.trim().toLowerCase();
  const filtro = $('filtroVip').value;
  const agora = Date.now();
  const tb = $('tabVip').querySelector('tbody'); tb.innerHTML = '';
  const vis = vipLista.filter((v) => {
    if (busca && !v.email.toLowerCase().includes(busca)) return false;
    const ativo = v.ate > agora;
    return filtro === 'todos' || (filtro === 'ativos' ? ativo : !ativo);
  });
  $('ctAssinantes').textContent = vipLista.filter((v) => v.ate > agora).length + ' ativos / ' + vipLista.length;
  $('vazioVip').textContent = 'Nenhum assinante encontrado.';
  $('vazioVip').hidden = vis.length > 0;
  vis.forEach((v) => {
    const ativo = v.ate > agora;
    const tr = el('tr');
    tr.appendChild(el('td', 'email', v.email));
    tr.appendChild(el('td', null, v.plano + (v.origem === 'admin' ? ' 🎁' : '')));
    tr.appendChild(el('td', null, v.ate > 4000000000000 ? 'Vitalício' : fmtData(v.ate)));
    const st = el('td'); st.appendChild(ativo ? tag('Ativo', 'ok') : tag('Expirado', 'mut')); tr.appendChild(st);
    const ac = el('td'); const box = el('div', 'acoes');
    const mais = el('button', 'btn btn--sm', '+30 dias'); mais.type = 'button';
    mais.addEventListener('click', () => darVip(v.email, 30, mais));
    box.appendChild(mais);
    if (ativo) {
      const rev = el('button', 'btn btn--sm btn--bad', 'Revogar'); rev.type = 'button';
      rev.addEventListener('click', () => revogarVip(v, rev));
      box.appendChild(rev);
    }
    ac.appendChild(box); tr.appendChild(ac); tb.appendChild(tr);
  });
}

// Estende a partir de hoje, ou do vencimento atual se ainda estiver ativo (não "perde" dias pagos)
async function darVip(email, dias, btn) {
  email = String(email || '').trim().toLowerCase();
  if (!validEmail(email)) { toast('E-mail inválido'); return false; }
  if (btn) btn.disabled = true;
  try {
    const key = emailKeyOf(email);
    const atual = vipLista.find((v) => v.id === key);
    const base = atual && atual.ate > Date.now() ? atual.ate : Date.now();
    const ate = dias === 'vitalicio' ? Date.UTC(2099, 11, 31, 23, 59, 59) : base + Number(dias) * 86400000;
    await setDoc(doc(db, 'vip', key), {
      email: email, plano: (atual && atual.plano !== '—') ? atual.plano : 'gold',
      vip_ate: new Date(ate).toISOString(), origem: (atual && atual.origem) || 'admin',
      atualizadoEm: serverTimestamp(), atualizadoPor: admin.email.toLowerCase()
    }, { merge: true });
    toast('✅ VIP de ' + email + ' até ' + (dias === 'vitalicio' ? 'sempre' : fmtData(ate)));
    await carregarVip();
    return true;
  } catch (e) {
    console.warn('[Admin] darVip:', e && e.code || e);
    toast('⚠️ Não deu pra salvar (' + (e && e.code || 'erro') + ')');
    return false;
  } finally { if (btn) btn.disabled = false; }
}

async function revogarVip(v, btn) {
  if (!confirm('Revogar o VIP de ' + v.email + '?')) return;
  btn.disabled = true;
  try {
    await setDoc(doc(db, 'vip', v.id), { vip_ate: new Date().toISOString(), atualizadoEm: serverTimestamp(), atualizadoPor: admin.email.toLowerCase() }, { merge: true });
    toast('VIP revogado: ' + v.email);
    await carregarVip();
  } catch (e) { console.warn('[Admin] revogar:', e && e.code || e); toast('⚠️ Não deu pra revogar'); btn.disabled = false; }
}

$('formVip').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const email = $('vipEmail').value;
  const dur = $('vipDuracao').value;
  const ok = await darVip(email, dur === 'vitalicio' ? 'vitalicio' : Number(dur));
  const m = $('vipMsg');
  m.hidden = false; m.className = ok ? 'msg' : 'msg err';
  m.textContent = ok
    ? 'Pronto! ' + email.trim().toLowerCase() + ' já é VIP. (O site guarda o status por até 1 hora em cada navegador — se a pessoa já estava com o site aberto, pode precisar recarregar.)'
    : 'Não consegui salvar. Confere se as regras do Firestore foram publicadas.';
  if (ok) $('vipEmail').value = '';
});
$('buscaVip').addEventListener('input', desenharVip);
$('filtroVip').addEventListener('change', desenharVip);
$('recVip').addEventListener('click', carregarVip);

/* ═══════════════════════ 🎫 REPORTS ═══════════════════════ */
const cards = new Map();      // ticketId → { el, sig, status, unsubResp }

function ouvirReports() {
  const q = query(collection(db, 'tickets'), orderBy('ultimaAtividade', 'desc'), limit(150));
  unsubs.push(onSnapshot(q, (snap) => {
    const ids = new Set();
    snap.forEach((d) => { ids.add(d.id); montarTicket(d.id, d.data()); });
    cards.forEach((c, id) => { if (!ids.has(id)) { if (c.unsubResp) c.unsubResp(); c.el.remove(); cards.delete(id); } });
    // mantém a ordem da consulta
    const lista = $('listaReports'); let prev = null;
    snap.forEach((d) => { const c = cards.get(d.id); if (!c) return; if (prev ? prev.nextSibling !== c.el : lista.firstChild !== c.el) lista.insertBefore(c.el, prev ? prev.nextSibling : lista.firstChild); prev = c.el; });
    aplicarFiltroReports();
  }, (e) => {
    console.warn('[Admin] tickets:', e && e.code || e);
    $('vazioReports').textContent = 'Não deu pra carregar os tickets (' + (e && e.code || 'erro') + ').'; $('vazioReports').hidden = false;
  }));
}

function montarTicket(id, t) {
  let c = cards.get(id);
  const resolvido = t.status === 'resolvido';
  if (!c) {
    const card = el('article', 'item'); card.dataset.status = t.status || 'aberto';
    const topo = el('div', 'item-topo');
    const quem = el('div', 'item-quem');
    const img = el('img'); img.alt = ''; img.referrerPolicy = 'no-referrer'; img.src = t.autorFoto || 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E';
    const nome = el('div'); nome.appendChild(el('b', null, t.autor || 'Anônimo')); nome.appendChild(el('small', null, (t.email || '') + ' · ' + fmtData(t.ts, true)));
    quem.appendChild(img); quem.appendChild(nome);
    const dir = el('div', 'acoes'); dir.appendChild(el('span', 'tag tag--mut', tipoRotulo(t.tipo)));
    const stTag = el('span'); stTag.className = 'st'; dir.appendChild(stTag);
    topo.appendChild(quem); topo.appendChild(dir); card.appendChild(topo);
    card.appendChild(el('p', 'item-texto', t.texto || ''));

    const thread = el('div', 'thread'); card.appendChild(thread);

    const form = el('div', 'responder');
    const ta = el('textarea'); ta.placeholder = 'Escreva a resposta pro usuário…'; ta.maxLength = 1000; ta.rows = 2; ta.setAttribute('aria-label', 'Resposta');
    const bResp = el('button', 'btn btn--pri btn--sm', 'Responder'); bResp.type = 'button';
    const bResolve = el('button', 'btn btn--ok btn--sm', 'Responder e resolver'); bResolve.type = 'button';
    const bToggle = el('button', 'btn btn--ghost btn--sm'); bToggle.type = 'button'; bToggle.className += ' toggle';
    form.appendChild(ta); form.appendChild(bResp); form.appendChild(bResolve); form.appendChild(bToggle); card.appendChild(form);

    const enviar = async (resolver) => {
      const txt = ta.value.trim();
      if (!txt && !resolver) { toast('Escreva a resposta antes 🙂'); return; }
      bResp.disabled = bResolve.disabled = true;
      try {
        const ref = doc(db, 'tickets', id);
        if (txt) await addDoc(collection(ref, 'respostas'), { uid: admin.uid, texto: txt, autor: 'PipocaFlix Suporte', autorFoto: '', isAdmin: true, ts: serverTimestamp() });
        const upd = { ultimaAtividade: serverTimestamp() }; if (resolver) upd.status = 'resolvido';
        await updateDoc(ref, upd);
        ta.value = ''; toast(resolver ? '✅ Respondido e resolvido' : '✅ Resposta enviada');
      } catch (e) { console.warn('[Admin] responder:', e && e.code || e); toast('⚠️ Não deu pra enviar (' + (e && e.code || 'erro') + ')'); }
      bResp.disabled = bResolve.disabled = false;
    };
    bResp.addEventListener('click', () => enviar(false));
    bResolve.addEventListener('click', () => enviar(true));
    bToggle.addEventListener('click', async () => {
      bToggle.disabled = true;
      try { await updateDoc(doc(db, 'tickets', id), { status: card.dataset.status === 'resolvido' ? 'aberto' : 'resolvido', ultimaAtividade: serverTimestamp() }); }
      catch (e) { toast('⚠️ Não deu pra mudar o status'); }
      bToggle.disabled = false;
    });

    // conversa em tempo real
    const unsubResp = onSnapshot(query(collection(doc(db, 'tickets', id), 'respostas'), orderBy('ts', 'asc'), limit(80)), (rs) => {
      thread.innerHTML = '';
      rs.forEach((r) => {
        const x = r.data();
        const d = el('div', 'resp' + (x.isAdmin ? ' adm' : ''));
        d.appendChild(el('small', null, (x.isAdmin ? '🛡️ ' : '') + (x.autor || 'Anônimo') + ' · ' + fmtData(x.ts, true)));
        d.appendChild(document.createTextNode(x.texto || ''));
        thread.appendChild(d);
      });
    });
    c = { el: card, unsubResp: unsubResp };
    cards.set(id, c);
    $('listaReports').appendChild(card);
  }
  c.el.dataset.status = t.status || 'aberto';
  const st = c.el.querySelector('.st'); st.className = 'st tag tag--' + (resolvido ? 'ok' : 'warn'); st.textContent = resolvido ? 'Resolvido' : 'Aberto';
  c.el.querySelector('.toggle').textContent = resolvido ? '↩️ Reabrir' : '✅ Marcar resolvido';
}

function tipoRotulo(t) { return ({ duvida: '❓ Dúvida', reclamacao: '⚠️ Reclamação', pedido: '🎬 Pedido' })[t] || (t ? String(t) : 'Ticket'); }

function aplicarFiltroReports() {
  const f = $('filtroReports').value;
  let visiveis = 0, abertos = 0;
  cards.forEach((c) => {
    const s = c.el.dataset.status; if (s !== 'resolvido') abertos++;
    const mostra = f === 'todos' || s === f; c.el.hidden = !mostra; if (mostra) visiveis++;
  });
  $('vazioReports').textContent = 'Nenhum ticket por aqui.';
  $('vazioReports').hidden = visiveis > 0;
  $('ctReports').textContent = abertos + ' abertos / ' + cards.size;
  const bd = $('bdReports'); bd.hidden = abertos === 0; bd.textContent = abertos;
}
$('filtroReports').addEventListener('change', aplicarFiltroReports);

/* ═══════════════════════ 🎬 PEDIDOS ═══════════════════════ */
let pedidosLista = [];
function ouvirPedidos() {
  const q = query(collection(db, 'pedidos'), orderBy('ts', 'desc'), limit(250));
  unsubs.push(onSnapshot(q, (snap) => {
    pedidosLista = []; snap.forEach((d) => pedidosLista.push({ id: d.id, ...d.data() }));
    desenharPedidos();
  }, (e) => {
    console.warn('[Admin] pedidos:', e && e.code || e);
    $('vazioPedidos').textContent = 'Não deu pra carregar os pedidos (' + (e && e.code || 'erro') + ').'; $('vazioPedidos').hidden = false;
  }));
}
$('recPedidos').addEventListener('click', () => toast('A lista já atualiza sozinha 🙂'));

function desenharPedidos() {
  const f = $('filtroPedidos').value;
  const pend = pedidosLista.filter((p) => (p.status || 'pendente') === 'pendente').length;
  $('ctPedidos').textContent = pend + ' pendentes / ' + pedidosLista.length;
  const bd = $('bdPedidos'); bd.hidden = pend === 0; bd.textContent = pend;
  const lista = $('listaPedidos');
  // não reconstrói se a pessoa estiver digitando uma resposta
  if (lista.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  lista.innerHTML = '';
  const vis = pedidosLista.filter((p) => f === 'todos' || (p.status || 'pendente') === f);
  $('vazioPedidos').textContent = 'Nenhum pedido por aqui.';
  $('vazioPedidos').hidden = vis.length > 0;
  vis.forEach((p) => lista.appendChild(cartaoPedido(p)));
}
$('filtroPedidos').addEventListener('change', desenharPedidos);

function cartaoPedido(p) {
  const status = p.status || 'pendente';
  const card = el('article', 'item ped');
  if (p.capa && /^https:\/\//.test(p.capa)) { const i = el('img'); i.alt = ''; i.loading = 'lazy'; i.referrerPolicy = 'no-referrer'; i.src = p.capa; card.appendChild(i); }
  else card.appendChild(el('div', 'ped-capa', p.tipo === 'serie' ? '📺' : '🎬'));
  const corpo = el('div', 'ped-corpo');
  const topo = el('div', 'item-topo');
  const tit = el('div'); tit.appendChild(el('b', null, (p.titulo || '(sem título)') + (p.ano ? ' (' + p.ano + ')' : '')));
  tit.appendChild(el('small', 'item-meta', (p.tipo === 'serie' ? '📺 Série' : '🎬 Filme') + ' · pedido em ' + fmtData(p.ts, true)));
  topo.appendChild(tit);
  topo.appendChild(status === 'atendido' ? tag('✅ Atendido', 'ok') : status === 'recusado' ? tag('❌ Recusado', 'bad') : tag('⏳ Pendente', 'warn'));
  corpo.appendChild(topo);
  corpo.appendChild(el('p', 'item-meta', '👤 ' + (p.autor || 'Anônimo') + ' · ' + (p.email || '')));
  if (p.mensagem) corpo.appendChild(el('p', 'item-texto', '“' + p.mensagem + '”'));
  if (p.resposta) corpo.appendChild(el('p', 'item-meta', 'Sua resposta: ' + p.resposta));

  const form = el('div', 'responder');
  const inp = el('input'); inp.type = 'text'; inp.maxLength = 300; inp.placeholder = 'Resposta pro usuário (opcional)'; inp.value = p.resposta || ''; inp.setAttribute('aria-label', 'Resposta');
  form.appendChild(inp);
  const acao = (novo, rotulo, cls) => {
    if (novo === status) return;
    const b = el('button', 'btn btn--sm ' + cls, rotulo); b.type = 'button';
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await updateDoc(doc(db, 'pedidos', p.id), { status: novo, resposta: inp.value.trim().slice(0, 300), atendidoEm: serverTimestamp(), atendidoPor: admin.email.toLowerCase() });
        toast(novo === 'atendido' ? '✅ Marcado como atendido — o usuário já vê no perfil' : novo === 'recusado' ? 'Pedido recusado' : 'Voltou pra pendente');
      } catch (e) { console.warn('[Admin] pedido:', e && e.code || e); toast('⚠️ Não deu pra atualizar (' + (e && e.code || 'erro') + ')'); b.disabled = false; }
    });
    form.appendChild(b);
  };
  acao('atendido', '✅ Atendido', 'btn--ok'); acao('recusado', '❌ Recusar', 'btn--bad'); acao('pendente', '↩️ Pendente', 'btn--ghost');
  corpo.appendChild(form); card.appendChild(corpo);
  return card;
}

/* ═══════════════════════ ⏱️ TESTES GRÁTIS ═══════════════════════ */
let testesLista = [];
async function carregarTestes() {
  try {
    const snap = await getDocs(collection(db, 'trial'));
    testesLista = [];
    snap.forEach((d) => { const x = d.data(); testesLista.push({ id: d.id, email: x.email || d.id, criado: ms(x.criadoEm) }); });
    testesLista.sort((a, b) => b.criado - a.criado);
    desenharTestes();
  } catch (e) {
    console.warn('[Admin] trial:', e && e.code || e);
    $('vazioTestes').textContent = 'Não deu pra carregar (' + (e && e.code || 'erro') + ').'; $('vazioTestes').hidden = false;
  }
}
function desenharTestes() {
  const busca = $('buscaTeste').value.trim().toLowerCase();
  const tb = $('tabTestes').querySelector('tbody'); tb.innerHTML = '';
  const vis = testesLista.filter((t) => !busca || t.email.toLowerCase().includes(busca));
  const agora = Date.now();
  $('ctTestes').textContent = testesLista.length;
  $('vazioTestes').textContent = 'Nenhum teste registrado.';
  $('vazioTestes').hidden = vis.length > 0;
  vis.forEach((t) => {
    const ativo = agora - t.criado < TRIAL_MS;
    const tr = el('tr');
    tr.appendChild(el('td', 'email', t.email));
    tr.appendChild(el('td', null, fmtData(t.criado, true)));
    const st = el('td'); st.appendChild(ativo ? tag('Em andamento', 'ok') : tag('Já usou', 'mut')); tr.appendChild(st);
    const ac = el('td'); const b = el('button', 'btn btn--sm', 'Liberar de novo'); b.type = 'button';
    b.addEventListener('click', async () => {
      if (!confirm('Apagar o registro de ' + t.email + '? Ele poderá fazer um novo teste de 3 horas.')) return;
      b.disabled = true;
      try { await deleteDoc(doc(db, 'trial', t.id)); toast('Teste liberado de novo: ' + t.email); await carregarTestes(); }
      catch (e) { toast('⚠️ Não deu pra apagar'); b.disabled = false; }
    });
    ac.appendChild(b); tr.appendChild(ac); tb.appendChild(tr);
  });
}
$('buscaTeste').addEventListener('input', desenharTestes);
$('recTestes').addEventListener('click', carregarTestes);
