/* ============ Utilidades ============ */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Lê números digitados no padrão brasileiro: "1.234,50" -> 1234.5, "10,5" -> 10.5, "10.5" -> 10.5
const parseBR = v => {
    let t = String(v ?? '').trim().replace(/\s/g, '');
    if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(t);
    return Number.isFinite(n) ? n : 0;
};
const brl = n => 'R$ ' + (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function dataHora(v) {
    if (!v) return '-';
    const d = new Date(String(v).replace(' ', 'T') + 'Z');
    return isNaN(d) ? '-' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function dataCurta(v) {
    if (!v) return '-';
    const d = new Date(String(v).replace(' ', 'T') + 'Z');
    return isNaN(d) ? '-' : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Pop-up de confirmação no visual do site. Retorna Promise<boolean>. `msg` aceita HTML (já escapado por quem chama).
let cfResolve = null;
function confirmar({ icone = '❔', titulo = 'Confirmar', msg = '', ok = 'Continuar', cancelar = 'Cancelar', perigo = false } = {}) {
    return new Promise(resolve => {
        if (cfResolve) cfResolve(false);
        cfResolve = resolve;
        $('cfIco').textContent = icone;
        $('cfTitulo').textContent = titulo;
        $('cfMsg').innerHTML = msg;
        $('cfSim').textContent = ok;
        $('cfNao').textContent = cancelar;
        $('cfBox').classList.toggle('perigo', !!perigo);
        $('cfBg').classList.add('show');
        setTimeout(() => $('cfSim').focus(), 30);
    });
}
function fecharConfirmar(v) {
    $('cfBg').classList.remove('show');
    const r = cfResolve; cfResolve = null;
    if (r) r(v);
}
$('cfSim').addEventListener('click', () => fecharConfirmar(true));
$('cfNao').addEventListener('click', () => fecharConfirmar(false));
$('cfBg').addEventListener('click', e => { if (e.target === $('cfBg')) fecharConfirmar(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && cfResolve) fecharConfirmar(false); });

let toastTimer;
function toast(msg, tipo) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'show ' + (tipo || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ''; }, tipo === 'err' ? 5000 : 3000);
}

// Consultas (só leitura) podem ser repetidas com segurança; lançamentos NUNCA são repetidos (evita venda/pagamento duplicado)
const ACOES_LEITURA = /^(get_|search_)/;
async function api(action, dados = {}) {
    // sem internet: nada é enviado (a tela "Sem internet" bloqueia o app até a conexão voltar)
    if (!navigator.onLine) { marcarOffline(); return { error: MSG_SEM_NET, offline: true }; }
    const leitura = ACOES_LEITURA.test(action);
    const tentativas = leitura ? 2 : 1;
    let ultimoErro = 'Sem conexão com o servidor.';
    let falhaRede = false;
    for (let t = 0; t < tentativas; t++) {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), leitura ? 25000 : 60000);
        try {
            const r = await fetch('/api/odoo', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, ...dados }),
                signal: ctl.signal
            });
            const j = await r.json().catch(() => ({ error: 'A API não respondeu corretamente (erro ' + r.status + '). Confira se o arquivo está em api/odoo.js no GitHub.' }));
            if (!r.ok && !j.error) j.error = 'Erro ' + r.status;
            j._status = r.status;
            if (leitura && r.status >= 500 && t < tentativas - 1) { ultimoErro = j.error; await new Promise(ok => setTimeout(ok, 600)); continue; }
            return j;
        } catch (e) {
            ultimoErro = e.name === 'AbortError' ? 'O servidor demorou demais para responder. Tente novamente.' : 'Sem conexão com o servidor.';
            if (e.name !== 'AbortError') falhaRede = true;
            if (t < tentativas - 1) await new Promise(ok => setTimeout(ok, 600));
        } finally { clearTimeout(to); }
    }
    // falha de rede: confirma com um ping se é falta de internet mesmo (e então bloqueia o app)
    if (falhaRede && !(await pingOk())) { marcarOffline(); return { error: MSG_SEM_NET, offline: true }; }
    return { error: ultimoErro };
}

/* ============ Sem internet: bloqueia o app e avisa; libera sozinho quando a conexão volta ============ */
const MSG_SEM_NET = 'Sem internet. Assim que a conexão voltar, você poderá continuar.';
let semNet = false, offTimer = null;

async function pingOk() {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 6000);
    try {
        const r = await fetch('/api/odoo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'ping' }), cache: 'no-store', signal: ctl.signal });
        return r.ok;
    } catch (e) { return false; }
    finally { clearTimeout(to); }
}
function marcarOffline() {
    if (semNet) return;
    semNet = true;
    $('offStatus').textContent = 'Verificando a conexão...';
    $('offBg').classList.add('show');
    offTimer = setInterval(() => verificarConexao(false), 4000);
}
function marcarOnline() {
    if (!semNet) return;
    semNet = false;
    clearInterval(offTimer);
    $('offBg').classList.remove('show');
    toast('Conexão restabelecida.', 'ok');
}
async function verificarConexao(manual) {
    if (manual) $('offStatus').textContent = 'Verificando...';
    const ok = navigator.onLine && await pingOk();
    if (ok) { marcarOnline(); return true; }
    if (semNet) $('offStatus').textContent = manual ? 'Ainda sem conexão.' : 'Sem conexão. Tentando de novo...';
    return false;
}
window.addEventListener('offline', marcarOffline);
window.addEventListener('online', () => { if (semNet) verificarConexao(false); });

/* Tela de carregamento (bloqueia toques enquanto algo importante está sendo feito) */
let carregandoN = 0;
function mostrarCarregando(msg) {
    carregandoN++;
    $('loadingMsg').textContent = msg || 'Carregando...';
    $('loadingBg').classList.add('show');
}
function esconderCarregando() {
    carregandoN = Math.max(0, carregandoN - 1);
    if (carregandoN === 0) $('loadingBg').classList.remove('show');
}
// executa uma tarefa assíncrona com a tela de carregamento (sempre fecha, mesmo com erro)
async function comCarregando(msg, fn) {
    mostrarCarregando(msg);
    try { return await fn(); } finally { esconderCarregando(); }
}

const timers = {};
function debounce(k, fn, ms = 450) { clearTimeout(timers[k]); timers[k] = setTimeout(fn, ms); }

/* ============ Meu local (origem das vendas e transferências) ============ */
let meuLocal = null;           // { wh: {id, name}, loc: {id, name} | null }
let armazensCache = null;
let aoEscolherLocal = null;
try { armazensCache = JSON.parse(localStorage.getItem('deuris_armazens') || 'null'); } catch (e) { armazensCache = null; }

try { meuLocal = JSON.parse(localStorage.getItem('deuris_meu_local') || 'null'); } catch (e) { meuLocal = null; }

function atualizarRotuloLocal() {
    $('chipLocal').textContent = '📍 ' + (meuLocal ? meuLocal.wh.name : 'Escolher');
}

function exigirLocal(cb) {
    if (meuLocal) return cb();
    abrirSeletorLocal(true, cb);
}

function desenharSeletorLocal() {
    $('sheetLista').innerHTML = (armazensCache || []).map(w => `
        <button class="opt ${meuLocal && meuLocal.wh.id === w.id ? 'on' : ''}" onclick="escolherLocal(${w.id})">
            <span>${esc(w.name)}</span><span>${meuLocal && meuLocal.wh.id === w.id ? '✓' : ''}</span>
        </button>`).join('');
}

async function abrirSeletorLocal(obrigatorio, cb) {
    aoEscolherLocal = cb || null;
    $('sheetCancelar').style.display = obrigatorio ? 'none' : 'block';
    $('sheetBg').dataset.obrigatorio = obrigatorio ? '1' : '';
    $('sheetBg').classList.add('show');

    // já tem a lista guardada: mostra na hora e atualiza em segundo plano
    if (armazensCache && armazensCache.length) desenharSeletorLocal();
    else $('sheetLista').innerHTML = '<div class="status">Carregando...</div>';

    const d = await api('get_warehouses');
    if (d.result) {
        armazensCache = d.result;
        try { localStorage.setItem('deuris_armazens', JSON.stringify(armazensCache)); } catch (e) {}
        desenharSeletorLocal();
    } else if (!armazensCache || !armazensCache.length) {
        $('sheetLista').innerHTML = '<div class="status">' + esc(d.error || 'Não foi possível carregar os locais.') +
            '</div><button class="opt" onclick="abrirSeletorLocal(' + (obrigatorio ? 'true' : 'false') + ', aoEscolherLocal)"><span>↻ Tentar de novo</span></button>';
    }
}

function fecharSeletorLocal() {
    if ($('sheetBg').dataset.obrigatorio) return;   // na primeira vez é preciso escolher
    $('sheetBg').classList.remove('show');
    aoEscolherLocal = null;
}

function escolherLocal(id) {
    const w = (armazensCache || []).find(x => x.id === id);
    if (!w) return;
    meuLocal = {
        wh: { id: w.id, name: w.name },
        loc: Array.isArray(w.lot_stock_id) ? { id: w.lot_stock_id[0], name: w.lot_stock_id[1] } : null
    };
    try { localStorage.setItem('deuris_meu_local', JSON.stringify(meuLocal)); } catch (e) {}
    atualizarRotuloLocal();
    $('sheetBg').dataset.obrigatorio = '';
    $('sheetBg').classList.remove('show');
    toast('Seu local: ' + w.name, 'ok');

    const cb = aoEscolherLocal; aoEscolherLocal = null;
    if (cb) cb();
    else {
        const tela = pilha[pilha.length - 1];
        if (tela === 'novaVenda' && venda) carregarProdutosDoLocal();       // trocou o local no meio da venda
        else if (tela === 'estoque') buscarEstoque();
        else if (tela === 'vendas') { carregarVendas(); carregarResumoDia(); }
        else if (tela === 'transfer') carregarHistoricoTransf();
    }
}

/* ============ Navegação ============ */
const TITULOS = { home: '', estoque: 'Estoque', vendas: 'Vendas', novaVenda: 'Nova venda', transfer: 'Transferências' };
let pilha = ['home'];

function ir(tela) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $(tela).classList.add('active');
    const home = tela === 'home';
    document.querySelector('header.bar').classList.toggle('is-home', home);
    if (home) $('titulo').innerHTML = '<span class="brand"><span class="brand-dot"></span><span class="brand-txt">Integrador</span></span>';
    else $('titulo').textContent = (tela === 'novaVenda' && venda && venda.editId) ? ('Venda ' + venda.nome) : TITULOS[tela];
    // status atual da venda ao lado do número
    if (tela === 'novaVenda' && venda && venda.editId) {
        const s = venda.estado;
        const bd = s === 'cancel' ? '<span class="badge b-bad">Cancelada</span>'
            : venda.travada ? (venda.quitada ? '<span class="badge b-ok">Pago</span>' : '<span class="badge b-yellow">Parcial</span>')
            : (s === 'sale' || s === 'done') ? '<span class="badge b-yellow">Confirmada</span>'
            : '<span class="badge b-grey">Orçamento</span>';
        $('titulo').insertAdjacentHTML('beforeend', bd);
    }
    $('titulo').style.display = 'block';
    $('chipLocal').style.display = 'inline-block';
    $('btnBack').classList.toggle('show', !home);
    $('fab').classList.toggle('show', ['home', 'vendas'].includes(tela));
    window.scrollTo(0, 0);
}
// Cada tela aberta entra também no histórico do navegador: assim o botão Voltar do celular volta uma tela
// (antes ele fechava o app). histTam = quantas entradas nossas existem no histórico.
let histTam = 0, navIgnorar = false;
try { history.replaceState({ d: 0 }, ''); } catch (e) {}

function abrir(tela) {
    pilha.push(tela);
    try { history.pushState({ d: pilha.length - 1 }, ''); histTam++; } catch (e) {}
    ir(tela);
}
// Alinha o histórico com a pilha quando o app troca de tela sem passar por abrir()/voltar()
function sincronizarHistorico() {
    const alvo = pilha.length - 1;
    if (histTam > alvo) {
        const n = histTam - alvo;
        histTam = alvo;
        navIgnorar = true;
        try { history.go(-n); } catch (e) { navIgnorar = false; }
    }
}
function aplicarVoltar() {
    if (pilha.length > 1) pilha.pop();
    histTam = pilha.length - 1;
    const tela = pilha[pilha.length - 1];
    ir(tela);
    // voltando para a lista de vendas: atualiza (a venda pode ter sido paga, editada ou cancelada)
    if (tela === 'vendas') { carregarVendas(); carregarResumoDia(); }
}
function voltar() {
    if (pilha.length <= 1) return;
    if (histTam > 0) history.back(); else aplicarVoltar();   // o resto acontece no 'popstate'
}
// Telas com algo digitado que ainda não foi salvo
function telaSuja() {
    const t = pilha[pilha.length - 1];
    if (t === 'novaVenda' && venda) return venda.editId ? (!venda.travada && !venda.leitura && assinaturaVenda() !== venda.sigOrig) : (venda.linhas.length > 0 || !!venda.partner);
    if (t === 'transfer') return trf.linhas.some(l => l.pid);
    return false;
}
window.addEventListener('popstate', async () => {
    if (navIgnorar) { navIgnorar = false; return; }
    const repor = () => { try { history.pushState({ d: pilha.length - 1 }, ''); } catch (e) {} };
    // janela aberta: o Voltar fecha a janela, não a tela
    const janelas = [['cfBg', () => fecharConfirmar(false)], ['payBg', descartarPagamento], ['ajBg', fecharAjuste], ['addBg', fecharAdicionar],
        ['trpBg', () => $('trpBg').classList.remove('show')], ['sheetBg', fecharSeletorLocal]];
    for (const [id, fechar] of janelas) {
        if ($(id).classList.contains('show')) { repor(); fechar(); return; }
    }
    if (pilha.length <= 1) return;
    if (telaSuja()) {
        repor();    // desfaz o "voltar" enquanto pergunta
        const sair = await confirmar({ icone: '⚠️', titulo: 'Sair sem salvar?', msg: 'Há alterações que ainda não foram salvas e serão perdidas.', ok: 'Sair', cancelar: 'Ficar', perigo: true });
        if (!sair) return;
        navIgnorar = true;
        history.back();
    }
    aplicarVoltar();
});

/* ============ Estoque (sempre do local que o usuário escolheu) ============ */
let estReq = 0;

// Garante que temos o local de estoque (ex.: SHOP DO PÉ/Estoque) do local escolhido
async function garantirLocalDeEstoque() {
    if (!meuLocal || meuLocal.loc) return !!meuLocal;
    if (!armazensCache) {
        const d = await api('get_warehouses');
        if (d.result) armazensCache = d.result;
    }
    const w = (armazensCache || []).find(x => x.id === meuLocal.wh.id);
    if (w && Array.isArray(w.lot_stock_id)) {
        meuLocal.loc = { id: w.lot_stock_id[0], name: w.lot_stock_id[1] };
        try { localStorage.setItem('deuris_meu_local', JSON.stringify(meuLocal)); } catch (e) {}
    }
    return !!meuLocal.loc;
}

function abrirEstoque() {
    estOrdem = 'desc';   // sempre abre do maior para o menor
    exigirLocal(async () => {
        $('estBusca').value = '';
        $('estLista').innerHTML = ''; $('estTabela').style.display = 'none';
        $('estStatus').textContent = 'Carregando estoque...';
        if (pilha[pilha.length - 1] !== 'estoque') abrir('estoque');
        buscarEstoque();
    });
}

async function buscarEstoque() {
    if (!meuLocal) return;
    const query = $('estBusca').value.trim();
    const req = ++estReq;
    $('estStatus').textContent = 'Pesquisando...';

    if (!(await garantirLocalDeEstoque())) {
        if (req === estReq) $('estStatus').textContent = 'Não foi possível identificar o estoque do seu local. Atualize o arquivo api/odoo.js.';
        return;
    }
    const d = await api('get_stock', { query, location_id: meuLocal.loc.id });
    if (req !== estReq) return;
    if (!d.result) { $('estStatus').textContent = d.error || 'Erro ao carregar estoque.'; return; }
    if (d.result.length === 0) { estDados = []; $('estTabela').style.display = 'none'; $('estStatus').textContent = 'Nenhum item em estoque encontrado.'; return; }
    $('estStatus').textContent = d.result.length + ' item(ns) encontrado(s)';
    const porProduto = {};
    d.result.forEach(i => {
        if (!Array.isArray(i.product_id)) return;
        const pid = i.product_id[0];
        if (!porProduto[pid]) porProduto[pid] = { id: pid, nome: i.product_id[1], qtd: 0 };
        porProduto[pid].qtd += Number(i.quantity) || 0;
    });
    estDados = Object.values(porProduto);
    renderEstoque();
}

let estDados = [], estOrdem = 'desc';   // ordenação pela quantidade: 'desc' (maior→menor, padrão) ou 'asc'

function alternarOrdemEstoque() {
    estOrdem = estOrdem === 'desc' ? 'asc' : 'desc';
    renderEstoque();
}

function renderEstoque() {
    const itens = estDados.slice();
    itens.sort((a, b) => (estOrdem === 'desc' ? b.qtd - a.qtd : a.qtd - b.qtd) || a.nome.localeCompare(b.nome, 'pt-BR'));
    $('estOrdem').querySelector('i').textContent = estOrdem === 'desc' ? '↓' : '↑';
    $('estTabela').style.display = '';
    $('estLista').innerHTML = itens.map(i => `
        <div class="tab-row click" onclick="abrirAjuste(${i.id})">
            <div class="d">${esc(i.nome)}</div>
            <div class="q${i.qtd <= 1 ? ' zero' : ''}"><b>${fmtQtd(i.qtd)}</b>un.</div>
        </div>`).join('');
}


/* ============ Ajuste de estoque ============ */
let ajProduto = null;
const fmtQtd = n => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 3 });

function abrirAjuste(id, nome, atual) {
    const item = estDados.find(x => x.id === id);
    ajProduto = { id, nome: item ? item.nome : nome, atual: item ? item.qtd : (atual || 0) };
    $('ajNome').textContent = ajProduto.nome;
    $('ajAtual').textContent = 'Quantidade atual: ' + fmtQtd(ajProduto.atual) + ' un.';
    $('ajQtd').value = String(ajProduto.atual).replace('.', ',');
    $('ajBg').classList.add('show');
    setTimeout(() => { $('ajQtd').focus(); $('ajQtd').select(); }, 50);
}
function fecharAjuste() { $('ajBg').classList.remove('show'); ajProduto = null; }

async function salvarAjuste() {
    if (!ajProduto) return;
    const qtd = parseBR($('ajQtd').value);
    if (isNaN(qtd) || qtd < 0) return toast('Informe uma quantidade válida (0 ou mais).', 'err');
    if (qtd === ajProduto.atual) return fecharAjuste();
    if (!(await garantirLocalDeEstoque())) return toast('Não foi possível identificar o local de estoque.', 'err');
    const btn = $('ajSalvar'), btnC = $('ajCancelar');
    btn.disabled = btnC.disabled = true;
    btn.textContent = 'Salvando...';
    const d = await api('adjust_stock', { product_id: ajProduto.id, location_id: meuLocal.loc.id, quantity: qtd });
    btn.disabled = btnC.disabled = false;
    btn.textContent = 'Salvar';
    if (d.success) {
        fecharAjuste();
        prodCache = {};
        toast('Estoque ajustado!', 'ok');
        buscarEstoque();
    } else {
        toast(d.error || 'Erro ao ajustar o estoque.', 'err');
    }
}

/* ---- adicionar item que ainda não está no estoque ---- */
let addReq = 0;
async function abrirAdicionarEstoque() {
    $('addBusca').value = '';
    $('addLista').innerHTML = '';
    $('addBg').classList.add('show');
    buscarAdicionaveis();
}
function fecharAdicionar() { $('addBg').classList.remove('show'); }

let addDados = [];
async function buscarAdicionaveis() {
    const req = ++addReq;
    $('addStatus').textContent = 'Carregando...';
    if (!(await garantirLocalDeEstoque())) { $('addStatus').textContent = 'Não foi possível identificar o local de estoque.'; return; }
    const d = await api('get_addable_products', { location_id: meuLocal.loc.id, query: $('addBusca').value.trim() });
    if (req !== addReq) return;
    if (!d.products) { $('addStatus').textContent = d.error || 'Erro ao carregar produtos.'; return; }
    addDados = d.products;
    $('addStatus').textContent = d.products.length ? d.products.length + ' item(ns) zerado(s)' : 'Nenhum item encontrado.';
    $('addLista').innerHTML = d.products.map(p => `<button type="button" class="prod-item" style="grid-template-columns:1fr" onclick="escolherAdicionar(${p.id})"><span>${esc(p.display_name)}</span></button>`).join('');
}
function escolherAdicionar(id) {
    const p = addDados.find(x => x.id === id);
    if (!p) return;
    fecharAdicionar();
    abrirAjuste(id, p.display_name, 0);
}


/* ============ Transferências entre locais ============ */
let trf = { origem: '', destino: '', produtos: [], linhas: [], pickUid: null };
let trUid = 0;

function abrirTransferencias() {
    exigirLocal(async () => {
        await garantirLocalDeEstoque();
        if (!armazensCache) {
            const d = await api('get_warehouses');
            if (d.result) armazensCache = d.result;
        }
        const whs = (armazensCache || []).filter(w => Array.isArray(w.lot_stock_id));
        if (whs.length === 0) return toast('Não foi possível carregar os locais.', 'err');
        const origemPadrao = meuLocal && meuLocal.loc ? String(meuLocal.loc.id) : String(whs[0].lot_stock_id[0]);
        $('trOrigem').innerHTML = whs.map(w => `<option value="${w.lot_stock_id[0]}">${esc(w.name)}</option>`).join('');
        $('trDestino').innerHTML = '<option value="">Escolha o destino...</option>' + whs.map(w => `<option value="${w.lot_stock_id[0]}">${esc(w.name)}</option>`).join('');
        $('trOrigem').value = origemPadrao;
        trf = { origem: origemPadrao, destino: '', produtos: [], linhas: [], pickUid: null };
        travarLocaisIguais();
        adicionarLinhaTransf();
        abrir('transfer');
        carregarProdutosTransf();
        carregarHistoricoTransf();
    });
}

async function carregarProdutosTransf() {
    $('trStatus').textContent = 'Carregando produtos do local...';
    const origem = trf.origem;
    const d = await api('get_location_products', { location_id: origem });
    if (origem !== trf.origem) return;   // trocou a origem no meio do caminho
    if (!d.products) { $('trStatus').textContent = d.error || 'Erro ao carregar produtos.'; return; }
    trf.produtos = d.products;
    // mantém só as seleções que ainda existem na nova origem
    trf.linhas.forEach(l => {
        if (!l.pid) return;
        const p = trf.produtos.find(x => x.id === l.pid);
        if (p) l.estoque = p.stock_qty; else { l.pid = null; l.nome = ''; l.estoque = 0; }
    });
    $('trStatus').textContent = d.products.length ? '' : 'Este local não tem produtos em estoque.';
    renderLinhasTransf();
}

// Origem e destino nunca podem ser o mesmo local: a opção escolhida num lado fica desabilitada no outro
function travarLocaisIguais() {
    const o = $('trOrigem'), d = $('trDestino');
    if (d.value && d.value === o.value) { d.value = ''; trf.destino = ''; }
    Array.from(d.options).forEach(op => { op.disabled = !!op.value && op.value === o.value; });
    Array.from(o.options).forEach(op => { op.disabled = !!op.value && op.value === d.value; });
}

// "CASA/Stock" -> "CASA" (só o nome do local, sem a pasta de estoque)
const nomeLocalCurto = n => String(n || '-').split('/')[0].trim() || '-';

async function carregarHistoricoTransf() {
    const box = $('trHist');
    if (!meuLocal || !meuLocal.wh) { box.innerHTML = ''; return; }
    const d = await api('get_transfer_history', { warehouse_id: meuLocal.wh.id });
    if (!d.result) { box.innerHTML = `<div class="status">${esc(d.error || 'Erro ao carregar o histórico.')}</div>`; return; }
    if (d.result.length === 0) { box.innerHTML = '<div class="status">Nenhuma transferência neste local.</div>'; return; }
    box.innerHTML = d.result.map(t => `
        <div class="th-item">
            <div class="th-top"><b>${esc(t.name)}</b><span>${dataCurta(t.date_done)}</span></div>
            ${t.lines.map(l => `<div class="th-prod"><span>${esc(l.name)}</span><span>${fmtQtd(l.qty)} un.</span></div>`).join('')}
            <div class="th-rota">${esc(nomeLocalCurto(t.origin))} &gt; ${esc(nomeLocalCurto(t.dest))}</div>
        </div>`).join('');
}

function mudarOrigemTransf() {
    trf.origem = $('trOrigem').value;
    travarLocaisIguais();
    trf.produtos = [];
    trf.linhas.forEach(l => { l.pid = null; l.nome = ''; l.estoque = 0; });
    renderLinhasTransf();
    carregarProdutosTransf();
}

function adicionarLinhaTransf() {
    trf.linhas.push({ uid: ++trUid, pid: null, nome: '', estoque: 0, qty: 1 });
    renderLinhasTransf();
}
function removerLinhaTransf(uid) {
    trf.linhas = trf.linhas.filter(l => l.uid !== uid);
    if (trf.linhas.length === 0) adicionarLinhaTransf(); else renderLinhasTransf();
}
function mudarQtdTransf(uid, v) {
    const l = trf.linhas.find(x => x.uid === uid);
    if (!l) return;
    l.qty = parseBR(v);
    const w = document.getElementById('trw' + uid);
    if (w) w.textContent = l.pid && l.qty > l.estoque ? 'Atenção: só há ' + fmtQtd(l.estoque) + ' un em estoque.' : '';
}

function renderLinhasTransf() {
    $('trLinhas').innerHTML = trf.linhas.map(l => `
        <div class="tr-item">
            <button type="button" class="tr-pick${l.pid ? '' : ' vazio'}" onclick="abrirPickTransf(${l.uid})">${l.pid ? esc(l.nome) : 'Selecione o produto...'}</button>
            <label class="lbl">Qtd.</label>
            <div class="linha">
                <input type="number" inputmode="decimal" min="0" step="any" value="${l.qty || ''}" oninput="mudarQtdTransf(${l.uid}, this.value)">
                <button type="button" class="rm" onclick="removerLinhaTransf(${l.uid})" aria-label="Remover">×</button>
            </div>
            <div class="warn-txt" id="trw${l.uid}">${l.pid && l.qty > l.estoque ? 'Atenção: só há ' + fmtQtd(l.estoque) + ' un em estoque.' : ''}</div>
        </div>`).join('');
}

function abrirPickTransf(uid) {
    if (trf.produtos.length === 0) return toast('Este local não tem produtos em estoque.', 'err');
    trf.pickUid = uid;
    $('trpBusca').value = '';
    renderPickTransf();
    $('trpBg').classList.add('show');
}
function renderPickTransf() {
    const q = ($('trpBusca').value || '').trim().toLowerCase();
    const usados = new Set(trf.linhas.filter(l => l.uid !== trf.pickUid && l.pid).map(l => l.pid));   // sem duplicar produto
    const itens = trf.produtos.filter(p => !usados.has(p.id) && p.display_name.toLowerCase().includes(q));
    $('trpLista').innerHTML = itens.length
        ? itens.map(p => `<button type="button" class="prod-item" onclick="escolherProdTransf(${p.id})"><span>${esc(p.display_name)}</span><span class="q${p.stock_qty <= 1 ? ' zero' : ''}">${fmtQtd(p.stock_qty)}</span></button>`).join('')
        : '<div class="prod-vazio">Nenhum produto encontrado</div>';
}
function escolherProdTransf(pid) {
    const l = trf.linhas.find(x => x.uid === trf.pickUid);
    const p = trf.produtos.find(x => x.id === pid);
    if (!l || !p) return;
    l.pid = p.id; l.nome = p.display_name; l.estoque = p.stock_qty;
    if (!l.qty) l.qty = 1;
    $('trpBg').classList.remove('show');
    renderLinhasTransf();
}

async function salvarTransferencia() {
    if (!trf.destino) return toast('Escolha o local de destino.', 'err');
    if (trf.destino === trf.origem) return toast('A origem e o destino devem ser diferentes.', 'err');
    const linhas = trf.linhas.filter(l => l.pid);
    if (linhas.length === 0) return toast('Selecione ao menos um produto.', 'err');
    for (const l of linhas) {
        if (!(l.qty > 0)) return toast('Informe a quantidade de ' + l.nome + '.', 'err');
        if (l.qty > l.estoque) return toast(l.nome + ': só há ' + fmtQtd(l.estoque) + ' un em estoque.', 'err');
    }
    const nomeLoc = id => { const o = Array.from($('trOrigem').options).concat(Array.from($('trDestino').options)).find(x => x.value === String(id)); return o ? o.textContent : ''; };
    const resumo = linhas.map(l => '• ' + esc(l.nome) + ': <b>' + fmtQtd(l.qty) + '</b> un.').join('<br>');
    if (!(await confirmar({
        icone: '🔁', titulo: 'Confirmar transferência?', ok: 'Transferir', cancelar: 'Voltar',
        msg: '<b>' + esc(nomeLoc(trf.origem)) + '</b> &gt; <b>' + esc(nomeLoc(trf.destino)) + '</b><div style="text-align:left;margin-top:12px;font-size:14px">' + resumo + '</div>'
    }))) return;
    const btn = $('trSalvar');
    btn.disabled = true;
    btn.textContent = 'Transferindo...';
    const d = await api('quick_transfer', {
        location_id: Number(trf.origem),
        location_dest_id: Number(trf.destino),
        lines: linhas.map(l => ({ product_id: l.pid, qty: l.qty }))
    });
    btn.disabled = false;
    btn.textContent = '🔁 Transferir Estoque';
    if (d.success) {
        prodCache = {};
        toast('Transferência concluída!', 'ok');
        trf.linhas = [];
        adicionarLinhaTransf();
        carregarProdutosTransf();   // saldos atualizados
        carregarHistoricoTransf();
    } else {
        toast(d.error || 'Erro ao transferir.', 'err');
    }
}

/* ============ Vendas (só carrega depois de escolher um filtro) ============ */
let venStatus = null, venReq = 0;

function abrirVendas() {
    $('venBusca').value = '';
    $('venLista').innerHTML = '';
    abrir('vendas');
    escolherStatus('last');   // "Últimas" sempre ativado ao abrir
    carregarResumoDia();
}

// Cards do topo: valor vendido e quantidade de vendas confirmadas HOJE (no local escolhido)
async function carregarResumoDia() {
    const caixa = document.querySelector('.resumo-dia');
    if (caixa) caixa.classList.add('carregando');
    const ini = new Date(); ini.setHours(0, 0, 0, 0);
    const fim = new Date(ini); fim.setDate(fim.getDate() + 1);
    const d = await api('get_sales_summary', { warehouse_id: meuLocal ? meuLocal.wh.id : '', date_from: ini.toISOString(), date_to: fim.toISOString() });
    if (caixa) caixa.classList.remove('carregando');
    if (d && d.total !== undefined) {
        $('resVendido').textContent = brl(d.total);
        $('resQtd').textContent = d.count;
    }
}

function escolherStatus(st) {
    venStatus = st;
    document.querySelectorAll('#vendas .chip').forEach(c => c.classList.toggle('on', c.dataset.st === st));
    carregarVendas();
}

let venAcum = [];      // vendas já carregadas (a lista cresce com "Carregar mais")
async function carregarVendas(mais) {
    const query = $('venBusca').value.trim();
    const req = ++venReq;
    if (!venStatus) venStatus = 'last';
    if (!mais) venAcum = [];
    $('venStatus').textContent = 'Carregando...';
    if (mais) { const b = $('venMais'); if (b) { b.disabled = true; b.textContent = 'Carregando...'; } }
    else $('venLista').innerHTML = [1, 2, 3].map(() => '<div class="card sk"><div class="skel" style="width:55%;height:18px"></div><div class="skel" style="width:30%"></div><div class="skel" style="width:20%"></div><div class="skel" style="width:28%;height:22px;border-radius:999px"></div></div>').join('');
    // Últimas = 5 mais recentes, sem canceladas (ao pesquisar, mostra até 100); os outros filtros vêm de 50 em 50
    const limite = venStatus === 'last' ? (query ? 100 : 5) : 50;
    const d = await api('get_sales', { query, limit: limite, offset: mais ? venAcum.length : 0, warehouse_id: meuLocal ? meuLocal.wh.id : '', order_status: (venStatus === 'last' || venStatus === 'all') ? '' : venStatus, exclude_cancel: venStatus === 'last' });
    if (req !== venReq) return;
    if (!d.result) {
        if (mais) { const b = $('venMais'); if (b) { b.disabled = false; b.textContent = 'Carregar mais'; } $('venStatus').textContent = venAcum.length + ' venda(s)'; toast(d.error || 'Erro ao carregar vendas.', 'err'); return; }
        $('venLista').innerHTML = ''; $('venStatus').textContent = d.error || 'Erro ao carregar vendas.'; return;
    }
    venAcum = venAcum.concat(d.result);
    if (venAcum.length === 0) { $('venLista').innerHTML = ''; $('venStatus').textContent = 'Nenhuma venda encontrada.'; return; }
    d.result = venAcum;
    $('venStatus').textContent = d.result.length + ' venda(s)';

    // Um único status por venda: Orçamento (cinza) > Confirmada (amarelo) > Pago (verde)
    const stBadge = o => o.state === 'cancel' ? '<span class="badge b-bad">Cancelada</span>'
        : (o.state === 'sale' || o.state === 'done')
            ? (o.payment_summary === 'pago' ? '<span class="badge b-ok">Pago</span>' : o.payment_summary === 'parcial' ? '<span class="badge b-yellow">Parcial</span>' : '<span class="badge b-yellow">Confirmada</span>')
        : '<span class="badge b-grey">Orçamento</span>';

    // Sempre da data mais recente para a mais antiga
    const dataMs = o => { const t = new Date(String(o.date_order || '').replace(' ', 'T') + 'Z').getTime(); return isNaN(t) ? 0 : t; };
    d.result.sort((a, b) => (dataMs(b) - dataMs(a)) || (b.id - a.id));

    $('venLista').innerHTML = d.result.map(o => `
        <div class="card" onclick="abrirEdicaoVenda(${o.id})" style="cursor:pointer">
            <div class="row"><div class="cli">${esc(Array.isArray(o.partner_id) ? o.partner_id[1] : '-')}</div><div class="money">${brl(o.amount_total)}</div></div>
            <div class="dt">${dataCurta(o.date_order)}</div>
            <div class="num">${esc(o.name)}</div>
            <div style="margin-top:8px; display:flex; gap:6px; flex-wrap:wrap">${stBadge(o)}</div>
        </div>`).join('') + ((d.has_more && (venStatus !== 'last' || query)) ? '<button class="btn sec" id="venMais" onclick="carregarVendas(true)">Carregar mais</button>' : '');
}

/* ============ Nova venda ============ */
let venda = null;      // { partner, warehouse, produtos[], linhas[] }
let nvBuscaReq = 0;

function dataLocalAgora() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// Data escolhida (só o dia) + hora atual, para o Odoo guardar a data/hora do pedido
function dataVendaISO() {
    if (!venda.data) return null;
    const [y, m, d] = venda.data.split('-').map(Number);
    const n = new Date();
    return new Date(y, m - 1, d, n.getHours(), n.getMinutes()).toISOString();
}

// Chave única de cada venda nova: se a internet cair e o envio for repetido, o servidor não duplica a venda
function novaChave() {
    try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

function abrirNovaVenda() {
    exigirLocal(iniciarNovaVenda);
}

async function iniciarNovaVenda() {
    venda = { chave: novaChave(), partner: null, warehouse: String(meuLocal.wh.id), produtos: [], linhas: [], data: dataLocalAgora().slice(0, 10), venc: dataLocalAgora().slice(0, 10) };
    $('nvData').value = venda.data;
    $('nvVenc').value = venda.venc;
    atualizarTextoDatas();
    aplicarModoTelaVenda();
    fecharListaProdutos();
    renderCliente();
    renderLinhas();
    // evita empilhar a tela duas vezes se já estiver nela
    if (pilha[pilha.length - 1] !== 'novaVenda') abrir('novaVenda');
    carregarProdutosDoLocal();
}

function renderCliente() {
    const box = $('nvClienteBox');
    if (venda.partner) {
        box.innerHTML = `<div class="picked"><span>${esc(venda.partner.name)}</span>${venda.editId ? '' : '<button onclick="trocarCliente()">trocar</button>'}</div>`;
    } else {
        box.innerHTML = `<input type="text" id="nvCliBusca" placeholder="Buscar ou criar cliente..." style="text-transform: uppercase" autocapitalize="characters" oninput="clienteMaiusculo(this); debounce('cli', buscarCliente, 350)" autocomplete="off">
                         <div id="nvCliRes"></div>`;
    }
}
// Cliente sempre em MAIÚSCULAS, mesmo que o teclado esteja em minúsculas (mantém a posição do cursor)
function clienteMaiusculo(el) {
    const a = el.selectionStart, b = el.selectionEnd;
    const up = el.value.toUpperCase();
    if (up !== el.value) { el.value = up; try { el.setSelectionRange(a, b); } catch (e) {} }
}
function trocarCliente() { venda.partner = null; renderCliente(); }

async function buscarCliente() {
    const q = ($('nvCliBusca').value || '').trim();
    const box = $('nvCliRes');
    const req = ++nvBuscaReq;
    if (!q) { box.innerHTML = ''; return; }
    const d = await api('search_partners', { query: q });
    if (req !== nvBuscaReq || !$('nvCliRes')) return;
    const itens = (d.partners || []).map(p => `<button data-id="${p.id}" data-nome="${esc(p.name)}" onclick="escolherCliente(Number(this.dataset.id), this.dataset.nome)">${esc(p.name)}</button>`).join('');
    box.innerHTML = `<div class="results">${itens}<button class="new" onclick="criarCliente()">+ Criar cliente "${esc(q)}"</button></div>`;
}
function escolherCliente(id, name) { venda.partner = { id, name }; renderCliente(); }

async function criarCliente() {
    const nome = ($('nvCliBusca').value || '').trim().toUpperCase();
    if (!nome) return;
    const d = await api('create_partner', { name: nome });
    if (d.success) { escolherCliente(d.id, d.name); toast('Cliente criado.', 'ok'); }
    else toast(d.error || 'Não foi possível criar o cliente.', 'err');
}

let prodCache = {};      // { [id do local]: lista de produtos } — abre a seleção na hora e atualiza por baixo

function aplicarProdutosDoLocal(minha, products, fresco) {
    const btn = $('nvProdBtn');
    venda.produtos = products;
    btn.textContent = products.length ? '＋ Adicionar produto' : 'Sem estoque neste local';
    btn.disabled = products.length === 0;
    renderListaProdutos();

    // editando uma venda lançada: o estoque disponível das linhas antigas é o do local + o que a própria venda já separou
    if (venda.editId) {
        venda.linhas.forEach(l => {
            if (!l.lineId) return;
            const p = products.find(x => x.id === l.id);
            l.estoque = (p ? p.stock_qty : 0) + (l.qtyOrig || 0);
        });
        renderLinhas();
        return;
    }
    if (!fresco) { renderLinhas(); return; }     // lista guardada: não remove itens com base em dado possivelmente velho

    // remove das linhas os produtos que não existem neste local
    const antes = venda.linhas.length;
    venda.linhas = venda.linhas.filter(l => products.some(p => p.id === l.id));
    if (venda.linhas.length < antes) toast('Itens sem estoque neste local foram removidos.', 'err');
    renderLinhas();
}

async function carregarProdutosDoLocal() {
    const minha = venda;     // se o usuário trocar/sair da venda enquanto carrega, ignora a resposta antiga
    if (!venda.editId) venda.warehouse = String(meuLocal.wh.id);
    const wh = venda.warehouse;
    const btn = $('nvProdBtn');
    const guardado = prodCache[wh];
    if (guardado) aplicarProdutosDoLocal(minha, guardado, false);
    else { btn.disabled = true; btn.textContent = 'Carregando produtos...'; }
    const d = await api('get_warehouse_products', { warehouse_id: Number(wh) });
    if (venda !== minha) return;
    if (!d.products) {
        if (!guardado) btn.textContent = 'Erro ao carregar';
        toast(d.error || 'Erro ao carregar produtos.', 'err');
        return;
    }
    prodCache[wh] = d.products;
    aplicarProdutosDoLocal(minha, d.products, true);
}

function abrirListaProdutos() {
    const l = $('nvProdList');
    if (l.classList.contains('show')) return fecharListaProdutos();
    $('nvProdBusca').value = '';
    renderListaProdutos();
    l.classList.add('show');
}
function fecharListaProdutos() { $('nvProdList').classList.remove('show'); }

function renderListaProdutos() {
    const q = ($('nvProdBusca').value || '').trim().toLowerCase();
    const itens = (venda.produtos || []).filter(p => p.display_name.toLowerCase().includes(q));
    $('nvProdBody').innerHTML = itens.length
        ? itens.map(p => `<button type="button" class="prod-item" onclick="escolherProduto(${p.id})"><span>${esc(p.display_name)}</span><span class="q${p.stock_qty <= 1 ? ' zero' : ''}">${fmtQtd(p.stock_qty)}</span></button>`).join('')
        : '<div class="prod-vazio">Nenhum produto encontrado</div>';
}
function escolherProduto(id) { fecharListaProdutos(); adicionarProduto(id); }

function adicionarProduto(id) {
    if (!id) return;
    id = Number(id);
    const ja = venda.linhas.find(l => l.id === id);
    if (ja) { ja.qty += 1; renderLinhas(); return; }
    const p = venda.produtos.find(x => x.id === id);
    if (!p) return;
    venda.linhas.push({ id: p.id, nome: p.display_name, qty: 1, price: p.list_price || 0, estoque: p.stock_qty, discTipo: 'R$', discVal: 0 });
    renderLinhas();
}

function mudarQtd(id, delta) {
    const l = venda.linhas.find(x => x.id === id);
    if (!l) return;
    l.qty += delta;
    if (l.qty < 1) { removerLinha(id); return; }
    renderLinhas();
}
/* Desconto: o Odoo só aceita % por linha; se o usuário digitar em R$, converte para % */
const bruto = l => l.qty * l.price;
function pctDesc(l) {
    const v = Number(l.discVal) || 0;
    const b = l.discBase;
    if (b && l.discTipo === 'R$' && b.v === v && b.q === l.qty && b.p === l.price) return b.pct;
    if (l.discTipo === 'R$') return bruto(l) > 0 ? Math.min(100, Math.max(0, v / bruto(l) * 100)) : 0;
    return Math.min(100, Math.max(0, v));
}
const totalLinha = l => bruto(l) * (1 - pctDesc(l) / 100);
const fmtPct = n => n.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + '%';

function atualizarLinha(l) {
    const sub = document.getElementById('sub' + l.id);
    if (sub) sub.innerHTML = (pctDesc(l) > 0 ? `<small>${brl(bruto(l))}</small>` : '') + brl(totalLinha(l));
    const eq = document.getElementById('eq' + l.id);
    if (eq) eq.textContent = l.discTipo === 'R$' && pctDesc(l) > 0 ? '= ' + fmtPct(pctDesc(l)) : '';
    atualizarTotal();
}
function mudarDesc(id, v) {
    const l = venda.linhas.find(x => x.id === id);
    if (!l) return;
    l.discVal = parseBR(v);
    atualizarLinha(l);
}
function mudarTipoDesc(id, tipo) {
    const l = venda.linhas.find(x => x.id === id);
    if (!l || l.discTipo === tipo) return;
    // mantém o mesmo desconto ao alternar entre % e R$
    const p = pctDesc(l);
    l.discTipo = tipo;
    l.discVal = tipo === 'R$' ? Math.round(bruto(l) * p) / 100 : Math.round(p * 100) / 100;
    renderLinhas();
}
function removerLinha(id) {
    const l = venda.linhas.find(x => x.id === id);
    // linha que já existe na venda lançada: guarda para excluir no Odoo
    if (l && l.lineId) { venda.removidos = venda.removidos || []; venda.removidos.push(l.lineId); }
    venda.linhas = venda.linhas.filter(x => x.id !== id);
    renderLinhas();
}

function atualizarTotal() {
    $('nvTotal').textContent = brl(venda.linhas.reduce((s, l) => s + totalLinha(l), 0));
}

function renderLinhas() {
    const bloq = venda.travada || venda.leitura;
    const trv = bloq ? ' disabled' : '';
    $('nvLinhas').innerHTML = venda.linhas.map(l => `
        <div class="line">
            <div class="pname">${esc(l.nome)}</div>
            <div class="cols">
                <div class="col">
                    <label>Qtd.</label>
                    <div class="stepper">
                        <button onclick="mudarQtd(${l.id}, -1)"${trv}>−</button><span>${fmtQtd(l.qty)}</span><button onclick="mudarQtd(${l.id}, 1)"${trv}>+</button>
                    </div>
                </div>
                <div class="col">
                    <label>Desconto</label>
                    <div class="dsc">
                        <input type="number" inputmode="decimal" step="0.01" min="0" placeholder="0" value="${l.discVal || ''}" oninput="mudarDesc(${l.id}, this.value)"${trv}>
                        <select onchange="mudarTipoDesc(${l.id}, this.value)"${trv}>
                            <option value="R$"${l.discTipo === 'R$' ? ' selected' : ''}>R$</option>
                            <option value="%"${l.discTipo === '%' ? ' selected' : ''}>%</option>
                        </select>
                    </div>
                </div>
            </div>
            <div class="foot">
                <span class="eq" id="eq${l.id}"></span>
                <div class="sub" id="sub${l.id}"></div>
                ${bloq ? '' : `<button class="rm" onclick="removerLinha(${l.id})" aria-label="Remover">×</button>`}
            </div>
            ${(!bloq && l.qty > l.estoque) ? `<div class="warn-txt">Atenção: só há ${fmtQtd(l.estoque)} un em estoque.</div>` : ''}
        </div>`).join('');
    venda.linhas.forEach(atualizarLinha);
    atualizarTotal();
}

function voltarParaVendas() {
    pilha = ['home', 'vendas'];
    sincronizarHistorico();
    ir('vendas');
    $('venBusca').value = '';
    escolherStatus('last');
    carregarResumoDia();
}

/* ============ Editar venda já lançada ============ */
// Ajusta a tela "Nova venda" para o modo edição (e volta ao normal numa venda nova)
function aplicarModoTelaVenda() {
    const editando = !!(venda && venda.editId);
    const travada = !!(venda && venda.travada);                 // paga (total ou parcial)
    const leitura = !!(venda && venda.leitura);                 // cancelada
    const bloq = travada || leitura;
    const lancada = editando && ['sale', 'done'].includes(venda.estado);
    const orc = editando && ['draft', 'sent'].includes(venda.estado);
    $('nvData').disabled = bloq;
    $('nvVenc').disabled = bloq;
    atualizarTextoDatas();
    $('btnOrcamento').style.display = (!editando || orc) ? '' : 'none';
    $('btnConfirmarVenda').style.display = bloq ? 'none' : '';
    $('btnConfirmarVenda').textContent = lancada ? 'Salvar alterações' : 'Salvar';
    $('nvProdBtn').style.display = bloq ? 'none' : '';
    $('btnPagarVenda').style.display = (lancada && venda.podePagar) ? '' : 'none';
    $('btnCancelarVenda').style.display = (lancada && !travada) ? '' : 'none';
    $('btnReverterVenda').style.display = (lancada && travada) ? '' : 'none';
    // status: só sem pagamento nenhum (venda paga precisa ser revertida antes)
    $('btnVoltarOrcamento').style.display = ((lancada && !travada) || leitura) ? '' : 'none';
    $('btnVoltarOrcamento').textContent = leitura ? 'Reabrir como orçamento' : 'Voltar para orçamento';
    $('btnCancelarOrc').style.display = orc ? '' : 'none';
    $('btnExcluirOrc').style.display = orc ? '' : 'none';
    const av = $('nvAviso');
    av.style.display = bloq ? 'block' : 'none';
    av.textContent = travada ? 'Reverta a venda para fazer ajustes, cancelar ou mudar o status.' : leitura ? 'Venda cancelada. Reabra como orçamento para editar.' : '';
}

async function abrirEdicaoVenda(id) {
    return comCarregando('Abrindo venda...', () => abrirEdicaoVendaInterno(id));
}

async function abrirEdicaoVendaInterno(id) {
    const falha = m => { toast(m, 'err'); return false; };
    const d = await api('get_sale_detail', { order_id: id });
    if (!d.order) return falha(d.error || 'Erro ao abrir a venda.');
    const o = d.order;
    const emRascunho = ['draft', 'sent'].includes(o.state);      // orçamento: editável como uma venda nova
    const linhasOdoo = d.lines || [];
    // segurança: venda com valor mas sem itens = dados incompletos; não abre vazia (evita salvar e perder os itens)
    if (linhasOdoo.length === 0 && Number(o.amount_total) > 0) return falha('Os itens da venda não carregaram. Tente abrir novamente.');
    const prodIds = linhasOdoo.map(l => l.product_id[0]);
    if (new Set(prodIds).size !== prodIds.length) return falha('Esta venda tem o mesmo produto em mais de uma linha. Edite-a pelo computador.');
    if (!Array.isArray(o.warehouse_id)) return falha('A venda não tem local de estoque definido.');

    const faturaAtiva = (d.invoices || []).find(i => i.state !== 'cancel');
    const travada = (d.invoices || []).some(i => i.state !== 'cancel' && ['paid', 'in_payment', 'partial'].includes(i.payment_state));
    const ativas = (d.invoices || []).filter(i => i.state !== 'cancel');
    const quitada = ativas.length > 0 && ativas.every(i => ['paid', 'in_payment'].includes(i.payment_state));
    const vencAtual = (faturaAtiva && faturaAtiva.invoice_date_due) || o.validity_date || '';
    const dt = new Date(String(o.date_order || '').replace(' ', 'T') + 'Z');
    const p2 = n => String(n).padStart(2, '0');
    venda = {
        editId: o.id,
        estado: o.state,
        travada,
        leitura: o.state === 'cancel',          // cancelada: só leitura (dá para reabrir como orçamento)
        quitada,
        nome: o.name,
        partner: { id: o.partner_id[0], name: o.partner_id[1] },
        warehouse: String(o.warehouse_id[0]),
        produtos: [],
        removidos: [],
        data: isNaN(dt) ? '' : dt.getFullYear() + '-' + p2(dt.getMonth() + 1) + '-' + p2(dt.getDate()),
        venc: vencAtual,
        linhas: linhasOdoo.map(l => ({
            id: l.product_id[0], lineId: l.id, nome: l.product_id[1],
            qty: l.product_uom_qty, qtyOrig: emRascunho ? 0 : l.product_uom_qty,
            price: l.price_unit, estoque: l.product_uom_qty,
            // o Odoo guarda %, mas aqui sempre mostramos em R$ (o mais usado); converte o % salvo para R$
            discTipo: 'R$',
            discVal: l.discount ? Math.round(l.product_uom_qty * l.price_unit * l.discount) / 100 : 0,
            discBase: null
        })),
        invoiceId: faturaAtiva ? faturaAtiva.id : null,
        invoiceResidual: faturaAtiva ? (faturaAtiva.amount_residual > 0 ? faturaAtiva.amount_residual : faturaAtiva.amount_total) : 0,
        podePagar: !!faturaAtiva && !['paid', 'in_payment'].includes(faturaAtiva.payment_state)
    };
    // % original gravado no Odoo: enquanto o desconto, a quantidade e o preço não mudarem, ele é reenviado igual
    // (antes, converter para R$ e voltar a % fazia 10% virar 10,001% e o Odoo refazia fatura e entrega à toa)
    venda.linhas.forEach((l, i) => {
        const o = linhasOdoo[i];
        l.discBase = { pct: Number(o.discount) || 0, v: l.discVal, q: l.qty, p: l.price };
    });
    venda.dataOrig = venda.data;
    $('nvData').value = venda.data;
    $('nvVenc').value = venda.venc;
    atualizarTextoDatas();
    aplicarModoTelaVenda();
    fecharListaProdutos();
    renderCliente();
    renderLinhas();
    venda.sigOrig = assinaturaVenda();
    if (pilha[pilha.length - 1] !== 'novaVenda') abrir('novaVenda'); else ir('novaVenda');
    carregarProdutosDoLocal();
    if (!diariosCache) api('get_payment_journals').then(r => { diariosCache = (r && r.result) || null; }); // já deixa as contas prontas para o botão Pagar
    return true;
}

function atualizarTextoDatas() {
    const fmt = iso => iso ? iso.split('-').reverse().join('/') : 'dd/mm/aaaa';
    $('nvDataTxt').textContent = fmt($('nvData').value);
    $('nvVencTxt').textContent = fmt($('nvVenc').value);
    $('nvDataBox').classList.toggle('off', $('nvData').disabled);
    $('nvVencBox').classList.toggle('off', $('nvVenc').disabled);
}

/* Pagar / Cancelar a venda aberta (modo edição) */
function assinaturaVenda() {
    return JSON.stringify([venda.linhas.map(l => [l.id, l.qty, Number(pctDesc(l).toFixed(2))]), venda.data, venda.venc || '']);
}

async function pagarVendaAtual() {
    if (!venda || !venda.editId || !venda.invoiceId) return toast('Esta venda não tem fatura para pagar.', 'err');
    if (assinaturaVenda() !== venda.sigOrig) return toast('Há alterações não salvas. Toque em "Salvar alterações" antes de pagar.', 'err');
    await comCarregando('Abrindo pagamento...', () => abrirPagamento(venda.invoiceId, venda.invoiceResidual));
}

/* Reverter venda paga: cancela os pagamentos em conta e devolve ao cliente, como crédito, o que foi pago com crédito */
async function reverterVendaAtual() {
    if (!venda || !venda.editId || !venda.travada) return;
    const idVenda = venda.editId;
    const pre = await comCarregando('Verificando pagamentos...', () => api('preview_revert_sale', { order_id: idVenda }));
    if (pre.error) return toast(pre.error, 'err');
    if (!venda || venda.editId !== idVenda) return;
    const pg = pre.pagamentos || [];
    const cred = Number(pre.credito) || 0;
    if (pg.length === 0 && cred <= 0.004) {
        toast('Não encontrei pagamentos para reverter. Atualizando a venda...', 'err');
        await abrirEdicaoVenda(idVenda);
        return;
    }
    let msg = 'Os pagamentos desta venda serão <b>cancelados</b> e ela volta a ficar em aberto, para você ajustar ou cancelar.';
    if (pg.length) msg += '<div style="text-align:left;margin:12px 0 0;font-size:14px">' + pg.map(x =>
        '• ' + esc(x.conta || 'Conta') + ': <b>' + brl(x.valor) + '</b>').join('<br>') + '</div>';
    if (cred > 0.004) msg += '<div style="margin-top:10px;font-size:14px">' + brl(cred) + ' pagos com crédito voltam como <b>crédito do cliente</b>.</div>';
    if (!(await confirmar({ icone: '↩️', titulo: 'Reverter venda?', perigo: true, ok: 'Reverter', cancelar: 'Voltar', msg }))) return;

    const d = await comCarregando('Revertendo pagamentos...', () => api('revert_sale_payments', { order_id: idVenda }));
    if (d.error) {
        const parte = d.parcial ? ' Parte já foi revertida; a venda foi atualizada, confira e tente de novo.' : '';
        toast(d.error + parte, 'err');
    } else {
        const n = (d.cancelados || []).length, c = Number(d.credito_devolvido) || 0;
        const partes = [];
        if (n) partes.push(n + ' pagamento(s) cancelado(s)');
        if (c > 0.004) partes.push(brl(c) + ' devolvido(s) como crédito do cliente');
        toast('Venda revertida. ' + partes.join(' · '), 'ok');
    }
    // recarrega a venda para refletir o novo estado (travada ou liberada)
    const ok = await abrirEdicaoVenda(idVenda);
    if (!ok) voltarParaVendas();
}

async function cancelarVendaAtual() {
    if (!venda || !venda.editId || venda.travada) return;
    if (!(await confirmar({
        icone: '🗑️', titulo: 'Cancelar venda?', perigo: true, ok: 'Cancelar venda', cancelar: 'Voltar',
        msg: 'Os saldos dos itens serão devolvidos ao seu estoque.'
    }))) return;
    const btn = $('btnCancelarVenda');
    btn.disabled = true;
    const txt = btn.textContent;
    btn.textContent = 'Cancelando...';
    const d = await comCarregando('Cancelando venda...', () => api('cancel_sale_order', { order_id: venda.editId }));
    btn.disabled = false;
    btn.textContent = txt;
    if (d.success) {
        prodCache = {};
        const avisos = (d.warnings || []).join(' ');
        const devolvido = d.credito_devolvido > 0 ? ' ' + brl(d.credito_devolvido) + ' voltou como crédito do cliente.' : '';
        toast('Venda cancelada.' + devolvido + (avisos ? ' ' + avisos : ''), avisos ? 'err' : 'ok');
        voltarParaVendas();
    } else {
        toast(d.error || 'Erro ao cancelar a venda.', 'err');
    }
}

/* Mudar o status da venda: Orçamento <-> Cancelada (só quando não há nenhum pagamento) */
async function mudarStatusVenda(novo) {
    if (!venda || !venda.editId || venda.travada) return;
    const idVenda = venda.editId;
    const paraOrc = novo === 'draft';
    const lancada = ['sale', 'done'].includes(venda.estado);
    const msg = paraOrc
        ? (lancada ? 'A venda será <b>cancelada</b> (os itens voltam ao estoque) e reaberta como <b>orçamento</b>, para você editar.'
                   : 'A venda cancelada volta a ser um <b>orçamento</b> editável.')
        : 'O orçamento será <b>cancelado</b>. Você poderá reabri-lo depois.';
    if (!(await confirmar({
        icone: paraOrc ? '📝' : '🚫', titulo: paraOrc ? 'Voltar para orçamento?' : 'Cancelar orçamento?', perigo: !paraOrc,
        ok: paraOrc ? 'Voltar para orçamento' : 'Cancelar orçamento', cancelar: 'Voltar', msg
    }))) return;
    const d = await comCarregando('Mudando o status...', () => api('change_sale_status', { order_id: idVenda, status: novo }));
    if (!d.success) return toast(d.error || 'Não foi possível mudar o status.', 'err');
    prodCache = {};
    const avisos = (d.warnings || []).join(' ');
    toast((paraOrc ? 'Venda voltou para orçamento.' : 'Orçamento cancelado.') + (avisos ? ' ' + avisos : ''), avisos ? 'err' : 'ok');
    if (paraOrc) {
        const ok = await abrirEdicaoVenda(idVenda);
        if (!ok) voltarParaVendas();
    } else voltarParaVendas();
}

async function excluirOrcamentoAtual() {
    if (!venda || !venda.editId || !['draft', 'sent'].includes(venda.estado)) return;
    if (!(await confirmar({
        icone: '🗑️', titulo: 'Excluir orçamento?', perigo: true, ok: 'Excluir', cancelar: 'Voltar',
        msg: 'O orçamento será <b>excluído</b> de vez. Isso não pode ser desfeito.'
    }))) return;
    const d = await comCarregando('Excluindo orçamento...', () => api('delete_sale_order', { order_id: venda.editId }));
    if (!d.success) return toast(d.error || 'Não foi possível excluir o orçamento.', 'err');
    toast('Orçamento excluído.', 'ok');
    voltarParaVendas();
}

async function salvarEdicaoVenda() {
    if (venda.linhas.length === 0) return toast('A venda precisa ter ao menos um produto. Para desfazê-la, cancele a venda.', 'err');
    const semEstoque = venda.linhas.filter(l => l.qty > l.estoque);
    if (semEstoque.length) return toast('Estoque insuficiente: ' + semEstoque.map(l => l.nome + ' (há ' + fmtQtd(l.estoque) + ')').join('; ') + '.', 'err');
    if (!venda.data) return toast('Informe a data da venda.', 'err');
    // a data só é enviada se foi alterada; vai às 12:00 (hora mais segura contra mudança de dia por fuso)
    let dateOrder;
    if (venda.data !== venda.dataOrig) {
        const [y, m, dd] = venda.data.split('-').map(Number);
        dateOrder = new Date(y, m - 1, dd, 12, 0).toISOString();
    }
    const btn = $('btnConfirmarVenda');
    const txt = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Salvando...';
    mostrarCarregando('Salvando alterações...');
    let d;
    try { d = await api('update_sale_lines', {
        order_id: venda.editId,
        date_order: dateOrder,
        due_date: venda.venc || null,
        invoice_date: dataLocalAgora().slice(0, 10),
        lines: venda.linhas.map(l => ({ id: l.lineId || null, product_id: l.id, qty: l.qty, price: l.price, discount: Number(pctDesc(l).toFixed(4)) })),
        removed_line_ids: venda.removidos || []
    }); } finally { esconderCarregando(); }
    btn.disabled = false;
    btn.textContent = txt;
    if (d.success) {
        prodCache = {};
        const avisos = (d.warnings || []).join(' ');
        toast('Venda atualizada!' + (avisos ? ' ' + avisos : ''), avisos ? 'err' : 'ok');
        // continua na venda: recarrega do Odoo para mostrar tudo atualizado (itens, total, fatura)
        const ok = await abrirEdicaoVenda(venda.editId);
        if (!ok) voltarParaVendas();
    } else {
        toast(d.error || 'Erro ao salvar as alterações.', 'err');
    }
}

/* ============ Pagamento da fatura (crédito do cliente + uma ou mais formas de pagamento) ============ */
let pagFatura = null;
let pagTotal = 0;        // saldo da fatura a pagar
let pagCredDisp = 0;     // crédito disponível do cliente
let pagLinhas = [];      // [{ conta, valor, auto }]  (auto: a última linha completa sozinha o restante)
let diariosCache = null;

const pgNum = parseBR;
const pgFmt = n => String(Math.round(n * 100) / 100).replace('.', ',');
const pgOpcoes = sel => diariosCache.map(c => `<option value="${c.id}"${String(c.id) === String(sel) ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
const pgCredUsar = () => $('payUsarCred').checked ? Math.round(pgNum($('payCredValor').value) * 100) / 100 : 0;

// quanto falta pagar nas contas depois do crédito
function pgBase() { return Math.max(0, Math.round((pagTotal - Math.min(pgCredUsar(), pagTotal)) * 100) / 100); }

function pgRecalcAuto() {
    const base = pgBase();
    $('payContas').style.display = base <= 0.005 ? 'none' : '';
    const n = pagLinhas.length;
    if (n) {
        const ult = pagLinhas[n - 1];
        if (ult.auto) {
            const outras = pagLinhas.slice(0, -1).reduce((s, l) => s + pgNum(l.valor), 0);
            ult.valor = pgFmt(Math.max(0, base - outras));
            const el = document.getElementById('payV' + (n - 1));
            if (el) el.value = ult.valor;
        }
    }
    const box = $('payRest');
    if (base <= 0.005) {
        box.className = 'pg-rest ok';
        box.textContent = pgCredUsar() > 0 ? 'Venda paga com o crédito do cliente ✓' : '';
        return;
    }
    const soma = pagLinhas.reduce((s, l) => s + pgNum(l.valor), 0);
    const rest = Math.round((base - soma) * 100) / 100;
    box.className = 'pg-rest' + (rest < 0 ? ' info' : rest === 0 ? ' ok' : '');
    box.textContent = rest < 0 ? 'Excedente de ' + brl(-rest) + ' vira crédito do cliente'
        : rest === 0 ? 'Total a pagar: ' + brl(base) + ' ✓'
        : 'Restante: ' + brl(rest) + ' (ficará em aberto)';
}

function pgRender() {
    $('payLinhas').innerHTML = pagLinhas.map((l, i) => `
        <div class="pgl">
            <div><label class="f">Conta</label><select id="payC${i}" onchange="pagLinhas[${i}].conta=this.value">${pgOpcoes(l.conta)}</select></div>
            <div><label class="f">Valor</label><input type="text" id="payV${i}" inputmode="decimal" autocomplete="off" value="${esc(l.valor)}" oninput="pgEditou(${i}, this.value)"></div>
            <button type="button" class="pg-x" ${pagLinhas.length > 1 ? '' : 'hidden'} onclick="removerLinhaPagamento(${i})">✕</button>
        </div>`).join('');
    pgRecalcAuto();
}

function pgEditou(i, v) {
    pagLinhas[i].valor = v;
    pagLinhas[i].auto = false;
    pgRecalcAuto();
}

function pgToggleCred() {
    const on = $('payUsarCred').checked;
    $('payCredCampo').style.display = on ? '' : 'none';
    $('payCredValor').value = on ? pgFmt(Math.min(pagCredDisp, pagTotal)) : '';
    pagLinhas.forEach((l, i) => { l.auto = i === pagLinhas.length - 1; });
    pgRecalcAuto();
}

function pgCredEditou() {
    pagLinhas.forEach((l, i) => { l.auto = i === pagLinhas.length - 1; });
    pgRecalcAuto();
}

function addLinhaPagamento() {
    if (pagLinhas.length) pagLinhas[pagLinhas.length - 1].auto = false;
    const usadas = pagLinhas.map(l => String(l.conta));
    const livre = diariosCache.find(c => !usadas.includes(String(c.id)));
    pagLinhas.push({ conta: String((livre || diariosCache[0]).id), valor: '', auto: true });
    pgRender();
}

function removerLinhaPagamento(i) {
    pagLinhas.splice(i, 1);
    if (pagLinhas.length) pagLinhas[pagLinhas.length - 1].auto = true;
    pgRender();
}

// mostra/esconde o bloco de crédito conforme o saldo disponível
function pgMostrarCredito() {
    const tem = pagCredDisp > 0.005 && pagTotal > 0.005;
    $('payCredBox').style.display = tem ? '' : 'none';
    $('payCredVal').textContent = brl(pagCredDisp);
    $('payUsarCred').checked = false;
    $('payCredCampo').style.display = 'none';
    $('payCredValor').value = '';
}

async function abrirPagamento(invoiceId, total) {
    pagFatura = invoiceId;
    // contas e crédito do cliente em paralelo (antes eram uma consulta depois da outra)
    const pCred = api('get_customer_credit', { invoice_id: invoiceId });
    if (!diariosCache) {
        const d = await api('get_payment_journals');
        diariosCache = d.result || [];
    }
    if (diariosCache.length === 0) { toast('Nenhuma conta de pagamento encontrada.', 'err'); pagFatura = null; return; }
    let ultima = null;
    try { ultima = localStorage.getItem('ultimaContaPgto'); } catch (e) {}
    const conta = diariosCache.some(c => String(c.id) === String(ultima)) ? String(ultima) : String(diariosCache[0].id);
    pagTotal = Math.round(total * 100) / 100;
    pagLinhas = [{ conta, valor: pgFmt(pagTotal), auto: true }];
    // crédito que o cliente já tem (se a consulta falhar, segue sem crédito)
    pagCredDisp = 0;
    try { const c = await pCred; pagCredDisp = Number(c.credit) || 0; } catch (e) {}
    pgMostrarCredito();
    pgRender();
    $('payData').value = dataLocalAgora().slice(0, 10);
    $('payBg').classList.add('show');
}

// O servidor avisou que o saldo da fatura já é outro (pagamento provavelmente já registrado): fecha e recarrega a venda
async function aposConflito(d) {
    if (!d || d._status !== 409) return false;
    descartarPagamento();
    const id = venda && venda.editId;
    if (id) await abrirEdicaoVenda(id);
    return true;
}

function descartarPagamento() {
    // fecha só o modal: o usuário continua na tela da venda em que estava
    $('payBg').classList.remove('show');
    pagFatura = null;
}

async function criarPagamento() {
    if (pagTotal <= 0.005) { $('payBg').classList.remove('show'); pagFatura = null; toast('Fatura já quitada.', 'ok'); return voltarParaVendas(); }
    if (!$('payData').value) return toast('Informe a data do pagamento.', 'err');

    // ---- validações (antes de lançar qualquer coisa) ----
    let usarCred = pgCredUsar();
    if ($('payUsarCred').checked) {
        if (!(usarCred > 0)) return toast('Informe o valor do crédito a usar.', 'err');
        if (usarCred > pagCredDisp + 0.005) return toast('O crédito informado é maior que o disponível (' + brl(pagCredDisp) + ').', 'err');
        if (usarCred > pagTotal + 0.005) return toast('O crédito informado é maior que o saldo da fatura (' + brl(pagTotal) + ').', 'err');
    }
    const base = Math.max(0, Math.round((pagTotal - usarCred) * 100) / 100);
    const pagaEmContas = base > 0.005;
    const valores = pagLinhas.map(l => Math.round(pgNum(l.valor) * 100) / 100);
    if (pagaEmContas && valores.some(v => v <= 0)) return toast('Informe o valor de cada forma de pagamento.', 'err');
    const soma = pagaEmContas ? Math.round(valores.reduce((s, v) => s + v, 0) * 100) / 100 : 0;

    const btn = $('payCriar'), btnD = $('payDescartar');
    btn.disabled = btnD.disabled = true;
    btn.textContent = 'Processando...';
    mostrarCarregando('Registrando pagamento...');
    let fechado = false;
    const fim = () => { if (!fechado) { fechado = true; esconderCarregando(); } btn.disabled = btnD.disabled = false; btn.textContent = 'Criar pagamento'; };

    // ---- 1) crédito do cliente (já pago antes: não pede conta) ----
    if (usarCred > 0) {
        const d = await api('apply_customer_credit', { invoice_id: pagFatura, amount: usarCred, expected_residual: pagTotal });
        if (!d.success) { fim(); toast(d.error || 'Erro ao usar o crédito.', 'err'); await aposConflito(d); return; }
        pagTotal = Math.round((pagTotal - usarCred) * 100) / 100;
        pagCredDisp = Math.max(0, Math.round((pagCredDisp - usarCred) * 100) / 100);
        pgMostrarCredito();
        pagLinhas.forEach((l, i) => { l.auto = i === pagLinhas.length - 1; });
    }

    // ---- 2) formas de pagamento (contas) ----
    let feitos = 0, erro = null, conflito = false;
    if (pagaEmContas) {
        // uma única chamada com todas as formas de pagamento (o servidor trava o pedido só no fim)
        const d = await api('register_payments', {
            order_id: pagFatura,
            expected_residual: pagTotal,
            payment_date: $('payData').value,
            payments: pagLinhas.map((l, i) => ({ journal_id: l.conta, amount: valores[i] }))
        });
        if (d.success) feitos = pagLinhas.length;
        else { feitos = Number(d.registered) || 0; erro = d.error || 'Erro ao registrar o pagamento.'; conflito = d._status === 409; }
    }
    fim();

    if (!erro) {
        try { if (pagaEmContas) localStorage.setItem('ultimaContaPgto', String(pagLinhas[0].conta)); } catch (e) {}
        $('payBg').classList.remove('show');
        pagFatura = null;
        const falta = Math.round((base - soma) * 100) / 100;
        const exc = Math.round((soma - base) * 100) / 100;
        let msg = 'Pagamento registrado!';
        if (pagaEmContas && falta > 0.005) msg = 'Pagamento parcial registrado. Resta ' + brl(falta) + '.';
        else if (pagaEmContas && exc > 0.005) msg = 'Pagamento registrado! ' + brl(exc) + ' ficou como crédito do cliente.';
        else if (!pagaEmContas) msg = 'Venda paga com o crédito do cliente!';
        toast(msg, 'ok');
        voltarParaVendas();
        return;
    }
    if (feitos > 0) {
        // parte já foi lançada: remove o que entrou e deixa na tela só o que falta
        const pago = valores.slice(0, feitos).reduce((s, v) => s + v, 0);
        pagTotal = Math.max(0, Math.round((pagTotal - pago) * 100) / 100);
        pagLinhas = pagLinhas.slice(feitos);
        pagLinhas[pagLinhas.length - 1].auto = true;
        pgRender();
        toast(erro + ' Falta ' + brl(pagTotal) + '.', 'err');
    } else {
        pgRender();
        toast(erro + (usarCred > 0 ? ' O crédito já foi usado (' + brl(usarCred) + ').' : ''), 'err');
        if (conflito) await aposConflito({ _status: 409 });
    }
}

async function salvarVenda(lancar) {
    if (venda.editId && ['sale', 'done'].includes(venda.estado)) return salvarEdicaoVenda();
    if (!meuLocal) return toast('Escolha o seu local.', 'err');
    if (venda.linhas.length === 0) return toast('Adicione ao menos um produto.', 'err');
    if (lancar) {
        const semEstoque = venda.linhas.filter(l => l.qty > l.estoque);
        if (semEstoque.length) return toast('Estoque insuficiente: ' + semEstoque.map(l => l.nome + ' (há ' + fmtQtd(l.estoque) + ')').join('; ') + '.', 'err');
    }
    if (!venda.data) return toast('Informe a data da venda.', 'err');

    // Sem cliente: avisa e usa o cliente padrão "CLIENTE" (já cadastrado no Odoo), para o campo não ficar em branco
    if (!venda.partner) {
        if (!(await confirmar({
            icone: '👤', titulo: 'Nenhum cliente informado',
            msg: 'A venda será lançada com o cliente <b>CLIENTE</b>, para o campo não ficar em branco.<br>Deseja continuar?',
            ok: 'Continuar', cancelar: 'Voltar'
        }))) return;
        const dc = await api('search_partners', { query: 'CLIENTE', exact: true });
        const padrao = (dc.partners || []).find(p => String(p.name).trim().toUpperCase() === 'CLIENTE');
        if (!padrao) return toast('Não encontrei o cliente "CLIENTE" no Odoo. Selecione um cliente.', 'err');
        venda.partner = { id: padrao.id, name: padrao.name };
        renderCliente();
    }

    const btnA = $('btnConfirmarVenda'), btnB = $('btnOrcamento');
    const txtA = btnA.textContent, txtB = btnB.textContent;
    btnA.disabled = btnB.disabled = true;
    (lancar ? btnA : btnB).textContent = 'Processando...';

    mostrarCarregando(lancar ? 'Lançando venda...' : 'Salvando rascunho...');
    let d;
    const emOrc = !!venda.editId;      // orçamento já existente: atualiza o mesmo pedido
    try { d = await api('save_sale_order', {
        order_id: emOrc ? venda.editId : undefined,
        removed_line_ids: emOrc ? (venda.removidos || []) : undefined,
        partner_id: venda.partner.id,
        warehouse_id: emOrc ? Number(venda.warehouse) : meuLocal.wh.id,
        lines: venda.linhas.map(l => ({ id: l.lineId || undefined, product_id: l.id, qty: l.qty, price: l.price, discount: Number(pctDesc(l).toFixed(4)) })),
        date_order: (emOrc && venda.data === venda.dataOrig) ? null : dataVendaISO(),
        invoice_date: dataLocalAgora().slice(0, 10),
        due_date: venda.venc || null,
        client_key: emOrc ? undefined : venda.chave,
        confirm: lancar
    }); } finally { esconderCarregando(); btnA.disabled = btnB.disabled = false; btnA.textContent = txtA; btnB.textContent = txtB; }

    if (d.success) {
        prodCache = {};     // o estoque mudou
        const avisos = (d.warnings || []).join(' ');
        if (lancar && d.confirmed === false) {
            // salvou, mas o Odoo não confirmou: NÃO diz "lançada" (o estoque não foi baixado)
            toast('Venda salva como orçamento, mas NÃO foi confirmada. ' + avisos, 'err');
            voltarParaVendas();
            return;
        }
        toast(lancar ? ('Venda lançada!' + (avisos ? ' ' + avisos : '')) : 'Rascunho salvo!', avisos ? 'err' : 'ok');
        // venda lançada: continua dentro dela (já em modo edição, com o botão Pagar), tudo atualizado
        if (lancar && d.id) {
            const ok = await abrirEdicaoVenda(d.id);
            if (!ok) voltarParaVendas();
        } else {
            voltarParaVendas();   // rascunho (orçamento) não é editável no app
        }
    } else {
        const repetivel = d.offline || !d._status || d._status >= 500;     // erro de regra (ex.: estoque) não é caso de tentar de novo
        toast((d.error || 'Erro ao salvar a venda.') + (repetivel && !d.offline ? ' Se tentar de novo, a venda não será duplicada.' : ''), 'err');
    }
}

/* ============ Sem zoom (o iOS ignora user-scalable=no, então bloqueia os gestos também) ============ */
['gesturestart', 'gesturechange', 'gestureend'].forEach(ev => document.addEventListener(ev, e => e.preventDefault()));

/* ============ PWA: service worker + instalar app ============ */
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/service-worker.js').catch(e => console.warn('Service worker não registrado:', e));
    });
}

(function () {
    const card = $('installCard'), btn = $('btnInstalar'), ios = $('installIos');
    const jaInstalado = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    const dispensado = () => { try { return localStorage.getItem('installDispensado') === '1'; } catch (e) { return false; } };
    if (jaInstalado || dispensado()) return;

    let promptInstalar = null;

    // Android / Chrome / Edge: o navegador avisa quando o app pode ser instalado
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        promptInstalar = e;
        btn.style.display = '';
        ios.style.display = 'none';
        card.classList.add('show');
    });

    btn.addEventListener('click', async () => {
        if (!promptInstalar) return;
        promptInstalar.prompt();
        await promptInstalar.userChoice.catch(() => {});
        promptInstalar = null;
        card.classList.remove('show');
    });

    window.addEventListener('appinstalled', () => { card.classList.remove('show'); toast('App instalado!', 'ok'); });

    $('installFechar').addEventListener('click', () => {
        card.classList.remove('show');
        try { localStorage.setItem('installDispensado', '1'); } catch (e) {}
    });

    // iPhone / iPad (Safari não dispara beforeinstallprompt): mostra a instrução manual
    const ehIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ehIos) {
        btn.style.display = 'none';
        ios.style.display = 'block';
        card.classList.add('show');
    }
})();

atualizarRotuloLocal();
ir('home');
if (!navigator.onLine) marcarOffline();
if (!meuLocal) abrirSeletorLocal(true, null);
