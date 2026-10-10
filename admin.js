/**
 * PIPOCAFLIX — Painel Admin (projeto SEPARADO do site, deploy separado no Vercel)
 *
 * Usa o MESMO Firebase do site (mesmo Auth e mesmo Firestore) — por isso tudo que você
 * faz aqui aparece no site na hora. O que ele faz:
 *   👑 Assinantes    lista/da/estende/revoga VIP           (coleção  vip/{email})
 *   🎫 Reports       responde tickets do suporte           (coleção  tickets + respostas)
 *   🎬 Pedidos       marca pedidos como atendido/recusado  (coleção  pedidos)
 *   ⏱️ Testes grátis  vê quem já usou / libera de novo      (coleções trial, trial_devices, trial_fp)
 *   🎁 Convites      confere convites e dá o bônus de VIP  (coleções convites, convites_privado, convites_donos)
 *   📊 Resumo        gráfico de assinantes, conversão teste→pago, ranking de pedidos (stats_diario)
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
  getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, query, orderBy, limit,
  onSnapshot, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

const ADMIN_EMAILS = ['canalpedroid@gmail.com'];
const TRIAL_MS = 3 * 60 * 60 * 1000;
const DIA_MS = 86400000;
const VITALICIO_MS = 4000000000000;           // vip_ate acima disso = vitalício
// Bônus do convite (mantenha igual ao BONUS do site, em assets/js/convite.js)
const BONUS_CONVIDANTE = 6;                   // dias pra quem convidou
const BONUS_AMIGO = 10;                       // dias pro amigo (além do mês que ele pagou)

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
const ABAS = ['resumo', 'assinantes', 'reports', 'pedidos', 'testes', 'convites'];
function abrirAba(nome) {
  if (!ABAS.includes(nome)) nome = 'resumo';
  document.querySelectorAll('.aba').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.aba === nome)));
  ABAS.forEach((a) => { $('painel-' + a).hidden = a !== nome; });
  try { history.replaceState(null, '', '#' + nome); } catch (e) {}
}
document.querySelectorAll('.aba').forEach((b) => b.addEventListener('click', () => abrirAba(b.dataset.aba)));

function iniciarPainel() {
  abrirAba((location.hash || '').replace('#', ''));
  $('bonusTxt').textContent = '+' + BONUS_CONVIDANTE + ' dias pra quem convidou e +' + BONUS_AMIGO + ' dias pro amigo';
  ouvirReports();
  ouvirPedidos();
  // Resumo e Convites cruzam assinantes × testes × convites, então esperam os dois carregarem
  Promise.all([carregarVip(), carregarTestes()]).then(() => { carregarResumo(); carregarConvites(); });
}

/* ═══════════════════════ 👑 ASSINANTES ═══════════════════════ */
let vipLista = [];
let vipVisiveis = [];            // o que está na tela agora (usado pelo CSV)

// Quando o VIP começou. O painel não sabe qual campo o seu webhook de pagamento grava,
// então tenta vários nomes comuns; se nenhum existir, assume plano mensal (vence − 30 dias).
function inicioDoVip(x, ate) {
  const cands = [x.vip_inicio, x.inicio, x.criadoEm, x.criado_em, x.desde, x.pago_em, x.atualizadoEm];
  for (const c of cands) { const t = ms(c); if (t) return t; }
  return ate && ate < VITALICIO_MS ? ate - 30 * DIA_MS : 0;
}

async function carregarVip() {
  try {
    const snap = await getDocs(collection(db, 'vip'));
    vipLista = [];
    snap.forEach((d) => {
      const x = d.data();
      const ate = ms(x.vip_ate);
      vipLista.push({ id: d.id, email: x.email || d.id, plano: x.plano || '—', ate: ate, origem: x.origem || '', inicio: inicioDoVip(x, ate) });
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
  vipVisiveis = vis;
  $('csvVip').textContent = '⬇️ Exportar CSV (' + vis.length + ')';
  $('csvVip').disabled = vis.length === 0;
  vis.forEach((v) => {
    const ativo = v.ate > agora;
    const tr = el('tr');
    tr.appendChild(el('td', 'email', v.email));
    tr.appendChild(el('td', null, v.plano + (v.origem === 'admin' || v.origem === 'convite' ? ' 🎁' : '')));
    tr.appendChild(el('td', null, v.ate > VITALICIO_MS ? 'Vitalício' : fmtData(v.ate)));
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

/* ───── ⬇️ Exportar e-mails em CSV ───── */
// Cuidado com planilha: célula começando com = + - @ vira fórmula no Excel/Sheets → prefixa com '
function csvCelula(v) {
  let t = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[",\n\r;]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}
$('csvVip').addEventListener('click', () => {
  if (!vipVisiveis.length) { toast('Nada pra exportar'); return; }
  const agora = Date.now();
  const linhas = [['email', 'plano', 'status', 'vence_em', 'origem']];
  vipVisiveis.forEach((v) => {
    linhas.push([v.email, v.plano === '—' ? '' : v.plano, v.ate > agora ? 'ativo' : 'expirado',
      v.ate > VITALICIO_MS ? 'vitalicio' : (v.ate ? new Date(v.ate).toISOString().slice(0, 10) : ''), v.origem]);
  });
  // BOM no começo: sem ele o Excel estraga os acentos
  const csv = '\ufeff' + linhas.map((l) => l.map(csvCelula).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = el('a'); a.href = url; a.download = 'pipocaflix-vip-' + chaveDia(agora) + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('⬇️ ' + vipVisiveis.length + ' e-mails exportados');
});

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
    snap.forEach((d) => {
      const x = d.data();
      testesLista.push({ id: d.id, email: x.email || d.id, criado: ms(x.criadoEm), uid: x.uid || '', deviceId: x.deviceId || '', fp: x.fp || '' });
    });
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
  const vis = testesLista.filter((t) => !busca || t.email.toLowerCase().includes(busca) || t.deviceId.startsWith(busca));
  const agora = Date.now();
  $('ctTestes').textContent = testesLista.length;
  $('vazioTestes').textContent = 'Nenhum teste registrado.';
  $('vazioTestes').hidden = vis.length > 0;
  vis.forEach((t) => {
    const ativo = agora - t.criado < TRIAL_MS;
    const tr = el('tr');
    tr.appendChild(el('td', 'email', t.email));
    tr.appendChild(el('td', null, fmtData(t.criado, true)));
    const ap = el('td', null, t.deviceId ? t.deviceId.slice(0, 8) : 'antigo (sem registro)');
    if (t.deviceId) ap.title = 'deviceId ' + t.deviceId + '\nfp ' + t.fp;
    tr.appendChild(ap);
    const st = el('td'); st.appendChild(ativo ? tag('Em andamento', 'ok') : tag('Já usou', 'mut')); tr.appendChild(st);
    const ac = el('td'); const b = el('button', 'btn btn--sm', 'Liberar de novo'); b.type = 'button';
    b.addEventListener('click', async () => {
      if (!confirm('Apagar o registro de ' + t.email + ' e do aparelho dele? Ele (e esse aparelho) poderão fazer um novo teste de 3 horas.')) return;
      b.disabled = true;
      try {
        // apaga o e-mail E o aparelho — se só apagasse o e-mail, o aparelho continuaria bloqueado
        const lote = writeBatch(db);
        lote.delete(doc(db, 'trial', t.id));
        if (t.deviceId) lote.delete(doc(db, 'trial_devices', t.deviceId));
        if (t.fp) lote.delete(doc(db, 'trial_fp', t.fp));
        await lote.commit();
        toast('Teste liberado de novo: ' + t.email); await carregarTestes();
      } catch (e) { console.warn('[Admin] liberar teste:', e && e.code || e); toast('⚠️ Não deu pra apagar (' + (e && e.code || 'erro') + ')'); b.disabled = false; }
    });
    ac.appendChild(b); tr.appendChild(ac); tb.appendChild(tr);
  });
}
$('buscaTeste').addEventListener('input', desenharTestes);
$('recTestes').addEventListener('click', carregarTestes);

/* ═══════════════════════ 📊 RESUMO ═══════════════════════ */
const chaveDia = (t) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const inicioDoDia = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const inicioDaSemana = (t) => { const d = new Date(inicioDoDia(t)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };   // segunda-feira
const fmtDM = (t) => new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

let snapshots = new Map();     // 'AAAA-MM-DD' → ativos (foto real gravada pelo painel)

async function carregarResumo() {
  try {
    const s = await getDocs(query(collection(db, 'stats_diario'), limit(800)));
    snapshots = new Map();
    s.forEach((d) => { const x = d.data(); if (typeof x.ativos === 'number') snapshots.set(d.id, x.ativos); });
  } catch (e) { console.warn('[Admin] stats_diario:', e && e.code || e); }

  // Foto de hoje: a cada vez que você abre o painel, o número do dia fica guardado.
  // É isso que, com o tempo, troca a estimativa por dado real no gráfico.
  const agora = Date.now();
  const ativos = vipLista.filter((v) => v.ate > agora).length;
  snapshots.set(chaveDia(agora), ativos);
  try {
    await setDoc(doc(db, 'stats_diario', chaveDia(agora)), { dia: chaveDia(agora), ativos: ativos, total: vipLista.length, testes: testesLista.length, atualizadoEm: serverTimestamp() }, { merge: true });
  } catch (e) { console.warn('[Admin] gravar foto do dia:', e && e.code || e); }

  desenharKpis(); desenharGrafico(); desenharConversao(); carregarRanking();
}
$('recResumo').addEventListener('click', async () => { await Promise.all([carregarVip(), carregarTestes()]); carregarResumo(); });
$('grPeriodo').addEventListener('change', desenharGrafico);

/* ── cartões de números ── */
function convertido(t) {
  const v = vipLista.find((x) => x.id === t.id);
  if (!v || v.origem === 'admin' || v.origem === 'convite') return null;   // presente/bônus não é venda
  if (v.inicio && v.inicio < t.criado - DIA_MS) return null;                // já era assinante antes do teste
  return v;
}
function desenharKpis() {
  const agora = Date.now();
  const ativos = vipLista.filter((v) => v.ate > agora);
  const vencendo = ativos.filter((v) => v.ate < VITALICIO_MS && v.ate - agora < 7 * DIA_MS).length;
  const t30 = testesLista.filter((t) => agora - t.criado < 30 * DIA_MS);
  const conv30 = t30.filter(convertido).length;
  const convTotal = testesLista.filter(convertido).length;
  const k = (valor, rotulo, cls) => { const d = el('div', 'kpi' + (cls ? ' kpi--' + cls : '')); d.appendChild(el('b', null, valor)); d.appendChild(el('span', null, rotulo)); return d; };
  const box = $('kpis'); box.innerHTML = '';
  box.appendChild(k(String(ativos.length), 'assinantes ativos agora', 'ok'));
  box.appendChild(k(String(vencendo), 'vencem nos próximos 7 dias', vencendo ? 'warn' : ''));
  box.appendChild(k(String(t30.length), 'testes grátis nos últimos 30 dias'));
  box.appendChild(k(t30.length ? Math.round(conv30 / t30.length * 100) + '%' : '—', 'dos testes de 30 dias já viraram assinatura (' + conv30 + ' de ' + t30.length + ')'));
  box.appendChild(k(testesLista.length ? Math.round(convTotal / testesLista.length * 100) + '%' : '—', 'conversão de todos os testes já feitos (' + convTotal + ' de ' + testesLista.length + ')'));
}

/* ── gráfico: assinantes ativos por dia ── */
function ativosEstimados(dia) {
  const ini = inicioDoDia(dia), fim = ini + DIA_MS - 1;
  return vipLista.filter((v) => v.inicio && v.inicio <= fim && v.ate >= ini).length;
}
function desenharGrafico() {
  const dias = Number($('grPeriodo').value) || 90;
  const hoje = inicioDoDia(Date.now());
  const serie = [];
  for (let i = dias - 1; i >= 0; i--) {
    const t = hoje - i * DIA_MS, k = chaveDia(t);
    const real = snapshots.has(k);
    serie.push({ t: t, n: real ? snapshots.get(k) : ativosEstimados(t), real: real });
  }
  const box = $('grafico'); box.innerHTML = '';
  const reais = serie.filter((p) => p.real).length;
  $('grLegenda').textContent = reais >= serie.length
    ? 'Todos os pontos são fotos diárias reais.'
    : 'Linha vermelha contínua = número real guardado pelo painel (' + reais + ' ' + (reais === 1 ? 'dia' : 'dias') + ' até agora). Linha cinza tracejada = estimativa a partir das datas de início e vencimento de cada VIP — renovações antigas podem fazer o passado parecer menor do que foi. Cada vez que você abre o painel, o dia de hoje vira dado real.';
  if (!vipLista.length) { box.appendChild(el('p', 'gr-vazio', 'Ainda não há assinantes cadastrados.')); return; }

  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tipo, attrs, txt) => { const e = document.createElementNS(NS, tipo); Object.keys(attrs || {}).forEach((a) => e.setAttribute(a, attrs[a])); if (txt != null) e.textContent = txt; return e; };
  const W = 720, H = 240, pl = 34, pr = 10, pt = 12, pb = 26;
  const maxN = Math.max(1, ...serie.map((p) => p.n));
  const topo = maxN <= 5 ? 5 : Math.ceil(maxN / 5) * 5;
  const X = (i) => pl + (W - pl - pr) * (serie.length === 1 ? 0 : i / (serie.length - 1));
  const Y = (n) => pt + (H - pt - pb) * (1 - n / topo);
  const svg = mk('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Assinantes ativos por dia' });
  for (let g = 0; g <= 4; g++) {
    const v = Math.round(topo * g / 4), y = Y(v);
    svg.appendChild(mk('line', { x1: pl, x2: W - pr, y1: y, y2: y, class: 'gr-grade' }));
    svg.appendChild(mk('text', { x: pl - 6, y: y + 4, 'text-anchor': 'end', class: 'gr-eixo' }, String(v)));
  }
  [0, Math.floor((serie.length - 1) / 2), serie.length - 1].forEach((i, k) => {
    svg.appendChild(mk('text', { x: X(i), y: H - 6, 'text-anchor': k === 0 ? 'start' : k === 2 ? 'end' : 'middle', class: 'gr-eixo' }, fmtDM(serie[i].t)));
  });
  svg.appendChild(mk('polyline', { points: serie.map((p, i) => X(i) + ',' + Y(p.n)).join(' '), class: 'gr-est' }));
  // trechos reais, em contínuo por cima
  let trecho = [];
  const fechar = () => { if (trecho.length > 1) svg.appendChild(mk('polyline', { points: trecho.join(' '), class: 'gr-real' })); trecho = []; };
  serie.forEach((p, i) => { if (p.real) trecho.push(X(i) + ',' + Y(p.n)); else fechar(); });
  fechar();
  serie.forEach((p, i) => {
    if (p.real && (serie.length <= 40 || i === serie.length - 1)) svg.appendChild(mk('circle', { cx: X(i), cy: Y(p.n), r: 3.5, class: 'gr-pt' }));
    const hit = mk('circle', { cx: X(i), cy: Y(p.n), r: Math.max(4, (W - pl - pr) / serie.length / 2), class: 'gr-hit' });
    hit.appendChild(mk('title', {}, fmtData(p.t) + ' — ' + p.n + ' ativos' + (p.real ? '' : ' (estimado)')));
    svg.appendChild(hit);
  });
  box.appendChild(svg);
}

/* ── conversão teste → assinante, por semana ── */
function desenharConversao() {
  const tb = $('tabConversao').querySelector('tbody'); tb.innerHTML = '';
  $('vazioConversao').hidden = testesLista.length > 0;
  const semanaAtual = inicioDaSemana(Date.now());
  for (let i = 0; i < 8; i++) {
    const ini = semanaAtual - i * 7 * DIA_MS, fim = ini + 7 * DIA_MS;
    const coorte = testesLista.filter((t) => t.criado >= ini && t.criado < fim);
    const conv = coorte.map((t) => ({ t: t, v: convertido(t) })).filter((x) => x.v);
    const mesma = conv.filter((x) => x.v.inicio && x.v.inicio < fim).length;
    const tr = el('tr');
    tr.appendChild(el('td', null, fmtDM(ini) + ' a ' + fmtDM(fim - 1) + (i === 0 ? ' (esta semana)' : '')));
    tr.appendChild(el('td', 'num', String(coorte.length)));
    tr.appendChild(el('td', 'num', String(conv.length)));
    tr.appendChild(el('td', 'num', String(mesma)));
    tr.appendChild(el('td', 'num', coorte.length ? Math.round(conv.length / coorte.length * 100) + '%' : '—'));
    tb.appendChild(tr);
  }
}

/* ── ranking de títulos mais pedidos ── */
let rankingBase = [];
async function carregarRanking() {
  try {
    const s = await getDocs(query(collection(db, 'pedidos'), limit(3000)));
    const mapa = new Map();
    s.forEach((d) => {
      const p = d.data();
      if (!p.tmdbId && !p.titulo) return;
      const chave = (p.tipo === 'serie' ? 'serie' : 'filme') + '_' + (p.tmdbId || String(p.titulo).toLowerCase());
      const st = p.status || 'pendente';
      let r = mapa.get(chave);
      if (!r) { r = { titulo: p.titulo || '(sem título)', ano: p.ano || '', tipo: p.tipo === 'serie' ? 'serie' : 'filme', capa: p.capa || '', total: 0, pendentes: 0, atendidos: 0, ultimo: 0 }; mapa.set(chave, r); }
      r.total++; if (st === 'pendente') r.pendentes++; if (st === 'atendido') r.atendidos++;
      r.ultimo = Math.max(r.ultimo, ms(p.ts));
      if (!r.capa && p.capa) r.capa = p.capa;
    });
    rankingBase = Array.from(mapa.values());
    desenharRanking();
  } catch (e) {
    console.warn('[Admin] ranking:', e && e.code || e);
    $('vazioRanking').textContent = 'Não deu pra carregar (' + (e && e.code || 'erro') + ').'; $('vazioRanking').hidden = false;
  }
}
function desenharRanking() {
  const soPend = $('filtroRanking').value === 'pendente';
  const lista = rankingBase
    .map((r) => ({ ...r, n: soPend ? r.pendentes : r.total }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n || b.ultimo - a.ultimo)
    .slice(0, 20);
  const tb = $('tabRanking').querySelector('tbody'); tb.innerHTML = '';
  $('ctRanking').textContent = lista.length ? 'top ' + lista.length : '';
  $('vazioRanking').textContent = 'Nenhum pedido por aqui.';
  $('vazioRanking').hidden = lista.length > 0;
  const topoN = lista.length ? lista[0].n : 1;
  lista.forEach((r, i) => {
    const tr = el('tr');
    tr.appendChild(el('td', 'num', String(i + 1)));
    const td = el('td'); const w = el('div', 'rank-tit');
    if (r.capa && /^https:\/\//.test(r.capa)) { const im = el('img'); im.alt = ''; im.loading = 'lazy'; im.referrerPolicy = 'no-referrer'; im.src = r.capa; w.appendChild(im); }
    else w.appendChild(el('div', 'rank-capa', r.tipo === 'serie' ? '📺' : '🎬'));
    w.appendChild(el('b', null, r.titulo + (r.ano ? ' (' + r.ano + ')' : '')));
    td.appendChild(w); tr.appendChild(td);
    tr.appendChild(el('td', null, r.tipo === 'serie' ? '📺 Série' : '🎬 Filme'));
    const tdN = el('td', 'num'); tdN.appendChild(document.createTextNode(String(r.n)));
    const barra = el('span', 'barra'); barra.style.width = Math.max(4, Math.round(r.n / topoN * 90)) + 'px'; tdN.appendChild(barra);
    tr.appendChild(tdN);
    const st = el('td');
    st.appendChild(r.pendentes > 0 ? tag('⏳ ' + r.pendentes + ' pendente' + (r.pendentes > 1 ? 's' : ''), 'warn') : tag('✅ Atendido', 'ok'));
    tr.appendChild(st);
    tr.appendChild(el('td', null, fmtData(r.ultimo)));
    tb.appendChild(tr);
  });
}
$('filtroRanking').addEventListener('change', desenharRanking);
$('recRanking').addEventListener('click', carregarRanking);

/* ═══════════════════════ 🎁 CONVITES ═══════════════════════ */
let convitesLista = [];
async function carregarConvites() {
  try {
    const [sc, sp, sd] = await Promise.all([
      getDocs(query(collection(db, 'convites'), limit(500))),
      getDocs(query(collection(db, 'convites_privado'), limit(500))),
      getDocs(query(collection(db, 'convites_donos'), limit(1000)))
    ]);
    const priv = new Map(); sp.forEach((d) => priv.set(d.id, d.data()));
    const donos = new Map(); sd.forEach((d) => donos.set(d.id, d.data()));
    convitesLista = [];
    sc.forEach((d) => {
      const c = d.data(), p = priv.get(d.id) || {}, dono = donos.get(c.conviteDe) || {};
      convitesLista.push({
        id: d.id, status: c.status || 'pendente', criado: ms(c.criadoEm), codigo: c.codigo || '',
        amigoNome: c.amigoNome || '', amigoEmail: p.amigoEmail || '', amigoMasc: c.amigoEmailMasc || '',
        convidanteEmail: dono.email || '', convidanteUid: c.conviteDe,
        mesmoAparelho: !!((p.deviceId && dono.deviceId && p.deviceId === dono.deviceId) || (p.fp && dono.fp && p.fp === dono.fp)),
        recompensadoEm: ms(c.recompensadoEm), bonusC: c.bonusConvidanteDias || 0, bonusA: c.bonusAmigoDias || 0
      });
    });
    convitesLista.sort((a, b) => b.criado - a.criado);
    desenharConvites();
  } catch (e) {
    console.warn('[Admin] convites:', e && e.code || e);
    $('vazioConvites').textContent = 'Não deu pra carregar os convites (' + (e && e.code || 'erro') + ').'; $('vazioConvites').hidden = false;
  }
}

function vipDoAmigo(c) { return c.amigoEmail ? vipLista.find((v) => v.id === emailKeyOf(c.amigoEmail)) : null; }
const convitePronto = (c) => { const v = vipDoAmigo(c); return c.status === 'pendente' && !!v && v.ate > Date.now(); };

function desenharConvites() {
  const f = $('filtroConvites').value;
  const prontos = convitesLista.filter(convitePronto).length;
  $('ctConvites').textContent = prontos + ' prontos / ' + convitesLista.length;
  const bd = $('bdConvites'); bd.hidden = prontos === 0; bd.textContent = prontos;
  const vis = convitesLista.filter((c) => f === 'todos' || (f === 'prontos' ? convitePronto(c) : c.status === f));
  const lista = $('listaConvites'); lista.innerHTML = '';
  $('vazioConvites').textContent = 'Nenhum convite por aqui.';
  $('vazioConvites').hidden = vis.length > 0;
  vis.forEach((c) => lista.appendChild(cartaoConvite(c)));
}

function cartaoConvite(c) {
  const v = vipDoAmigo(c), agora = Date.now();
  const card = el('article', 'item cv');
  const topo = el('div', 'item-topo');
  topo.appendChild(el('small', 'item-meta', 'Convite de ' + fmtData(c.criado, true) + ' · código ' + c.codigo));
  topo.appendChild(c.status === 'recompensado' ? tag('✅ Bônus liberado', 'ok') : c.status === 'recusado' ? tag('🚫 Recusado', 'bad') : tag('⏳ Pendente', 'warn'));
  card.appendChild(topo);

  const par = el('div', 'cv-par');
  const a = el('div'); a.appendChild(el('small', null, 'Quem convidou')); a.appendChild(el('b', null, c.convidanteEmail || '(e-mail não encontrado)'));
  const b = el('div'); b.appendChild(el('small', null, 'Amigo convidado')); b.appendChild(el('b', null, c.amigoEmail || c.amigoMasc || '—')); b.appendChild(el('span', null, c.amigoNome));
  par.appendChild(a); par.appendChild(b); card.appendChild(par);

  const av = el('div', 'avisos');
  if (!v) av.appendChild(tag('Amigo ainda sem VIP', 'mut'));
  else if (v.ate > agora) av.appendChild(tag('Amigo é VIP até ' + (v.ate > VITALICIO_MS ? 'sempre' : fmtData(v.ate)), 'ok'));
  else av.appendChild(tag('VIP do amigo expirou em ' + fmtData(v.ate), 'warn'));
  if (v && v.origem === 'admin') av.appendChild(tag('⚠️ VIP dado por você (não foi pagamento)', 'warn'));
  if (c.mesmoAparelho) av.appendChild(tag('⚠️ Mesmo aparelho de quem convidou', 'bad'));
  if (c.status === 'recompensado') av.appendChild(tag('+' + c.bonusC + ' dias pra quem convidou · +' + c.bonusA + ' pro amigo · ' + fmtData(c.recompensadoEm), 'ok'));
  card.appendChild(av);

  if (c.status !== 'recompensado') {
    const acoes = el('div', 'responder');
    const dar = el('button', 'btn btn--ok btn--sm', '🎁 Dar bônus (+' + BONUS_CONVIDANTE + ' / +' + BONUS_AMIGO + ' dias)'); dar.type = 'button';
    dar.disabled = !convitePronto(c) || !c.convidanteEmail;
    dar.title = dar.disabled ? 'Libera quando o amigo tiver VIP ativo' : '';
    dar.addEventListener('click', () => darBonus(c, dar));
    acoes.appendChild(dar);
    if (c.status === 'pendente') {
      const rec = el('button', 'btn btn--bad btn--sm', 'Recusar'); rec.type = 'button';
      rec.addEventListener('click', () => mudarStatusConvite(c, 'recusado', rec));
      acoes.appendChild(rec);
    } else {
      const rea = el('button', 'btn btn--ghost btn--sm', '↩️ Voltar pra pendente'); rea.type = 'button';
      rea.addEventListener('click', () => mudarStatusConvite(c, 'pendente', rea));
      acoes.appendChild(rea);
    }
    card.appendChild(acoes);
  }
  return card;
}

async function mudarStatusConvite(c, novo, btn) {
  if (novo === 'recusado' && !confirm('Recusar este convite? Ninguém ganha bônus por ele.')) return;
  btn.disabled = true;
  try {
    await updateDoc(doc(db, 'convites', c.id), { status: novo, atualizadoEm: serverTimestamp(), atualizadoPor: admin.email.toLowerCase() });
    toast(novo === 'recusado' ? 'Convite recusado' : 'Convite voltou pra pendente');
    await carregarConvites();
  } catch (e) { console.warn('[Admin] status convite:', e && e.code || e); toast('⚠️ Não deu pra atualizar (' + (e && e.code || 'erro') + ')'); btn.disabled = false; }
}

// Soma os dias a partir do vencimento atual (se ainda ativo) ou de hoje. Vitalício não muda.
function somarDias(docVip, dias) {
  const atual = docVip.exists() ? ms(docVip.data().vip_ate) : 0;
  if (atual > VITALICIO_MS) return atual;
  return Math.max(atual, Date.now()) + dias * DIA_MS;
}

async function darBonus(c, btn) {
  if (!confirm('Dar o bônus deste convite?\n\n• ' + c.convidanteEmail + ' ganha +' + BONUS_CONVIDANTE + ' dias\n• ' + c.amigoEmail + ' ganha +' + BONUS_AMIGO + ' dias\n\nIsso não pode ser feito duas vezes.')) return;
  btn.disabled = true;
  try {
    const kA = emailKeyOf(c.amigoEmail), kC = emailKeyOf(c.convidanteEmail);
    const refConv = doc(db, 'convites', c.id);
    // lê tudo de novo agora: evita dar bônus em duplicidade (duplo clique / outra aba) e usar vencimento velho
    const [sConv, sA, sC] = await Promise.all([getDoc(refConv), getDoc(doc(db, 'vip', kA)), getDoc(doc(db, 'vip', kC))]);
    if (!sConv.exists() || sConv.data().status === 'recompensado') { toast('Esse convite já foi recompensado'); await carregarConvites(); return; }
    if (!sA.exists()) { toast('O amigo ainda não tem VIP'); btn.disabled = false; return; }

    const quem = admin.email.toLowerCase();
    const ateA = somarDias(sA, BONUS_AMIGO), ateC = somarDias(sC, BONUS_CONVIDANTE);
    const lote = writeBatch(db);
    lote.set(doc(db, 'vip', kA), { email: c.amigoEmail.toLowerCase(), vip_ate: new Date(ateA).toISOString(), atualizadoEm: serverTimestamp(), atualizadoPor: quem }, { merge: true });
    lote.set(doc(db, 'vip', kC), {
      email: c.convidanteEmail.toLowerCase(), plano: sC.exists() && sC.data().plano ? sC.data().plano : 'gold',
      origem: sC.exists() && sC.data().origem ? sC.data().origem : 'convite',
      vip_ate: new Date(ateC).toISOString(), atualizadoEm: serverTimestamp(), atualizadoPor: quem
    }, { merge: true });
    lote.update(refConv, { status: 'recompensado', bonusConvidanteDias: BONUS_CONVIDANTE, bonusAmigoDias: BONUS_AMIGO, recompensadoEm: serverTimestamp(), recompensadoPor: quem });
    await lote.commit();   // os 3 acontecem juntos ou nenhum acontece

    toast('🎁 Bônus liberado! (o site guarda o status por até 1 hora em cada navegador)');
    await carregarVip(); await carregarConvites(); desenharKpis();
  } catch (e) {
    console.warn('[Admin] darBonus:', e && e.code || e);
    toast('⚠️ Não deu pra liberar (' + (e && e.code || 'erro') + ')'); btn.disabled = false;
  }
}
$('filtroConvites').addEventListener('change', desenharConvites);
$('recConvites').addEventListener('click', async () => { await carregarVip(); carregarConvites(); });
