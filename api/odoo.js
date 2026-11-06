import { r2, fmtBR, mesmoValor, planejarCredito, resumoPagamento, dominioPagamento, faltaDeEstoque } from "./_utils.js";

// =====================================================================
// CONEXÃO COM O ODOO (nível de módulo: sobrevive entre requisições "quentes")
// =====================================================================
// As credenciais vêm SOMENTE das variáveis de ambiente da Vercel (ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY).
// Nunca escreva usuário, senha ou chave de API neste arquivo.
const ODOO_URL = process.env.ODOO_URL;
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USER = process.env.ODOO_USER;
const ODOO_API_KEY = process.env.ODOO_API_KEY;

let cachedUid = null;
let uidPromise = null;
let forcedAccountIdCache = null;

// Métodos que só leem dados: podem ser repetidos sem risco quando a conexão com o Odoo falha por um instante
const READ_METHODS = new Set(["search_read", "read", "search_count", "fields_get", "read_group", "name_search", "search"]);

// 1 tentativa para escritas (nunca repete: evita lançar duas vezes); 3 para leituras, com tempo limite
async function rpc(service, method, args, idempotent = false) {
    const tentativas = idempotent ? 3 : 1;
    let ultimo;
    for (let t = 0; t < tentativas; t++) {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), idempotent ? 20000 : 45000);
        try {
            const r = await fetch(ODOO_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() }),
                signal: ctl.signal
            });
            if (idempotent && (r.status >= 500 || r.status === 429) && t < tentativas - 1) {
                ultimo = new Error("Odoo respondeu " + r.status);
                await new Promise(ok => setTimeout(ok, 300 * (t + 1)));
                continue;
            }
            return await r.json();
        } catch (e) {
            ultimo = e.name === "AbortError" ? new Error("O Odoo demorou demais para responder.") : e;
            if (t < tentativas - 1) await new Promise(ok => setTimeout(ok, 300 * (t + 1)));
        } finally { clearTimeout(to); }
    }
    throw ultimo || new Error("Falha ao conectar com o Odoo.");
}

// Autentica UMA vez e reaproveita o uid (antes eram 2 chamadas ao Odoo a cada clique).
// `forcar`: descarta o uid guardado e autentica de novo (usado quando o Odoo diz "acesso negado").
function getUid(forcar = false) {
    if (forcar) cachedUid = null;
    if (cachedUid) return Promise.resolve(cachedUid);
    if (!uidPromise) {
        uidPromise = rpc("common", "authenticate", [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}], true)
            .then(d => { if (d.result) cachedUid = d.result; return d.result; })
            .finally(() => { uidPromise = null; });
    }
    return uidPromise;
}

// Tempo máximo de uma ação (a Vercel corta em 60 s): passado disso, as etapas finais são adiadas com aviso
const PRAZO_MS = 52000;

const ACESSO_NEGADO = /access ?denied|acesso negado/i;

const execute = async (model, method, args, kwargs = {}, jaReautenticou = false) => {
    const uid = await getUid();
    if (!uid) throw new Error("Falha na autenticação com o Odoo.");
    const d = await rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs], READ_METHODS.has(method));
    if (d.error) {
        const errData = d.error.data || {};
        // Nunca devolve o "debug" (traceback com caminhos internos do servidor); só a mensagem legível
        if (errData.debug) console.error(`Odoo ${model}.${method}:`, errData.debug);
        const msg = errData.message || d.error.message || `Erro desconhecido do Odoo ao chamar ${model}.${method}`;
        // "Acesso negado" acontece antes de qualquer coisa ser executada: o uid guardado pode ter ficado inválido
        // (chave de API trocada ou renovada). Autentica de novo e repete UMA vez, em vez de falhar até a instância reiniciar.
        if (!jaReautenticou && (ACESSO_NEGADO.test(String(errData.name || "")) || ACESSO_NEGADO.test(String(msg)))) {
            await getUid(true);
            return execute(model, method, args, kwargs, true);
        }
        throw new Error(msg);
    }
    return d.result;
};

// Cache em memória para listas que quase não mudam (condições de pagamento, armazéns, locais, produtos...)
const _cache = new Map();
function cached(key, ttlMs, fn) {
    const hit = _cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.p;
    const p = fn().catch(err => { _cache.delete(key); throw err; });
    _cache.set(key, { p, exp: Date.now() + ttlMs });
    return p;
}
// Tela de Produtos: tipo "Mercadorias" (consu) + caixa "Vendas" marcada
const PRODUCT_BASE_DOMAIN = [["type", "=", "consu"], ["sale_ok", "=", true]];
// Data de "hoje" (AAAA-MM-DD) no fuso da loja, usada quando o app não manda a data. Padrão: Manaus (-4).
const TZ_OFFSET_HORAS = Number.isFinite(Number(process.env.TZ_OFFSET_HORAS)) && process.env.TZ_OFFSET_HORAS !== undefined && process.env.TZ_OFFSET_HORAS !== ""
    ? Number(process.env.TZ_OFFSET_HORAS) : -4;
const hojeLocal = () => new Date(Date.now() + TZ_OFFSET_HORAS * 3600 * 1000).toISOString().slice(0, 10);
const TTL_LONG = 10 * 60 * 1000;
const lookups = {
    warehouses: () => cached("warehouses", TTL_LONG, () => execute("stock.warehouse", "search_read", [[]], { fields: ["id", "name", "code", "lot_stock_id", "view_location_id"] })),
    internalPickingTypes: () => cached("picking_types_internal", TTL_LONG, () => execute("stock.picking.type", "search_read", [[["code", "=", "internal"]]], { fields: ["id", "name", "default_location_src_id", "default_location_dest_id"] }))
};

// Saldo físico por produto num local (e sublocais internos). O Odoo soma no servidor (read_group),
// em vez de trazer até 10 mil linhas de estoque; se o read_group falhar, usa a leitura direta.
async function saldoPorProduto(locId, produtoIds = null) {
    const dom = [["location_id", "child_of", Number(locId)], ["location_id.usage", "=", "internal"], ["quantity", ">", 0]];
    if (produtoIds && produtoIds.length) dom.push(["product_id", "in", produtoIds.map(Number)]);
    const mapa = {};
    try {
        const grupos = await execute("stock.quant", "read_group", [dom], { fields: ["quantity:sum"], groupby: ["product_id"], lazy: false });
        if (!Array.isArray(grupos)) throw new Error("read_group sem resultado");
        grupos.forEach(g => {
            if (Array.isArray(g.product_id)) mapa[g.product_id[0]] = Number(g.quantity) || 0;
        });
        return mapa;
    } catch (e) {
        const quants = await execute("stock.quant", "search_read", [dom], { fields: ["product_id", "quantity"] });
        (quants || []).forEach(q => {
            if (!Array.isArray(q.product_id)) return;
            mapa[q.product_id[0]] = (mapa[q.product_id[0]] || 0) + q.quantity;
        });
        return mapa;
    }
}

// Remove de um objeto os campos que não existem naquele modelo do Odoo (evita "Invalid field ..." entre versões)
async function onlyExistingFields(model, vals) {
    try {
        const defs = await cached("fields_" + model, TTL_LONG, () => execute(model, "fields_get", [], { attributes: ["type"] }));
        const out = {};
        for (const k of Object.keys(vals)) {
            if (vals[k] === undefined) continue;
            if (defs && defs[k]) out[k] = vals[k];
            else console.warn("Campo ignorado (não existe em " + model + "):", k);
        }
        return out;
    } catch (e) {
        return vals;
    }
}

// ---------------------------------------------------------------------
// Bloqueio do pedido / da entrega e sincronia da entrega com o pedido (edição de vendas lançadas)
// ---------------------------------------------------------------------

// Bloqueia/desbloqueia as entregas CONCLUÍDAS de um pedido (botões "Trancar"/"Desbloquear" da entrega)
async function definirBloqueioEntregas(orderId, bloquear) {
    const entregas = await execute("stock.picking", "search_read", [[
        ["sale_id", "=", Number(orderId)], ["state", "=", "done"], ["picking_type_code", "=", "outgoing"]
    ]], { fields: ["id", "is_locked"] });
    for (const e of (entregas || [])) {
        if (!!e.is_locked === !!bloquear) continue;
        try {
            await execute("stock.picking", "write", [[e.id], { is_locked: !!bloquear }]);
        } catch (err) {
            await execute("stock.picking", "action_toggle_is_locked", [[e.id]]);
        }
    }
}

// Trava/destrava o PEDIDO DE VENDA (botões "Travar"/"Destravar" do Odoo)
async function definirBloqueioPedido(orderId, bloquear) {
    const oid = Number(orderId);
    let st;
    let usaCampo = true;
    try {
        st = await execute("sale.order", "read", [[oid]], { fields: ["state", "locked"] });   // uma só leitura
    } catch (e) {
        usaCampo = false;               // Odoo mais antigo: pedido travado = estado "done"
        st = await execute("sale.order", "read", [[oid]], { fields: ["state"] });
    }
    if (!st || !st[0] || ["cancel", "draft", "sent"].includes(st[0].state)) return;
    const atual = usaCampo ? !!st[0].locked : st[0].state === "done";
    if (atual === !!bloquear) return;

    if (usaCampo) {
        try {
            await execute("sale.order", "write", [[oid], { locked: !!bloquear }]);
        } catch (e) {
            await execute("sale.order", bloquear ? "action_lock" : "action_unlock", [[oid]]);
        }
    } else {
        await execute("sale.order", bloquear ? "action_done" : "action_unlock", [[oid]]);
    }
}

// Regra: pedido e entrega travados só quando todas as faturas (não canceladas) estão pagas
async function sincronizarBloqueioDoPedido(orderId) {
    const oid = Number(orderId);
    const ped = await execute("sale.order", "read", [[oid]], { fields: ["invoice_ids", "state"] });
    if (!ped || !ped[0] || ped[0].state === "cancel") return;
    const ids = ped[0].invoice_ids || [];
    const faturas = ids.length > 0
        ? await execute("account.move", "search_read", [[["id", "in", ids], ["state", "!=", "cancel"]]], { fields: ["id", "payment_state"] })
        : [];
    const pago = (faturas || []).length > 0 && faturas.every(f => f.payment_state === "paid" || f.payment_state === "in_payment");
    // entrega e pedido são registros diferentes: travam ao mesmo tempo (uma espera a menos)
    await Promise.all([definirBloqueioEntregas(oid, pago), definirBloqueioPedido(oid, pago)]);
}

// Valida um picking e responde às janelas de confirmação do Odoo (ex.: criar pendência).
// Devolve { ok, name }: ok só é true se a entrega realmente ficou "concluída" (antes o resultado nem era conferido).
async function validarPickingComAssistentes(pickingId, ctxExtra = {}) {
    const base = Object.assign({ skip_sms: true }, ctxExtra);
    const vr = await execute("stock.picking", "button_validate", [[Number(pickingId)]], { context: base });
    if (vr && typeof vr === "object" && vr.res_model) {
        const wctx = Object.assign({}, vr.context || {}, base);
        const wid = await execute(vr.res_model, "create", [{}], { context: wctx });
        const metodo = vr.res_model === "stock.backorder.confirmation" ? "process_cancel_backorder" : "process";
        await execute(vr.res_model, metodo, [[wid]], { context: wctx });
    }
    const p = await execute("stock.picking", "read", [[Number(pickingId)]], { fields: ["state", "name"] });
    return { ok: !!(p && p[0] && p[0].state === "done"), name: (p && p[0] && p[0].name) || ("#" + pickingId) };
}

// Deixa a quantidade "feita" igual à pedida em cada movimento. Com estoque disponível o Odoo já reserva tudo ao
// confirmar, então só escreve nos movimentos que realmente diferem (antes: uma leitura + uma escrita POR ITEM).
async function completarQuantidades(pickingIds) {
    if (!pickingIds || pickingIds.length === 0) return;
    const dom = [["picking_id", "in", pickingIds], ["state", "!=", "cancel"]];
    let moves;
    try {
        moves = await execute("stock.move", "search_read", [dom], { fields: ["id", "product_uom_qty", "quantity"] });
    } catch (e) {
        // Odoo antigo, sem o campo "quantity" no movimento: escreve em todos
        moves = await execute("stock.move", "search_read", [dom], { fields: ["id", "product_uom_qty"] });
    }
    for (const mv of (moves || [])) {
        const dem = Number(mv.product_uom_qty);
        if (mv.quantity !== undefined && Math.abs(Number(mv.quantity) - dem) < 1e-9) continue;
        try {
            await execute("stock.move", "write", [[mv.id], { quantity: dem }]);
        } catch (e2) {
            await execute("stock.move", "write", [[mv.id], { quantity_done: dem }]).catch(() => {});
        }
    }
}

// Mantém UMA ÚNICA entrega por pedido, sempre igual às linhas do pedido (produto e quantidade)
async function sincronizarEntregaComPedido(orderId) {
    const oid = Number(orderId);
    const avisos = [];

    // 1) cancela entregas extras pendentes (o Odoo cria uma a cada aumento/produto novo)
    const pendentes = await execute("stock.picking", "search_read", [[
        ["sale_id", "=", oid], ["picking_type_code", "=", "outgoing"], ["state", "not in", ["done", "cancel"]]
    ]], { fields: ["id", "name"] });
    for (const p of (pendentes || [])) {
        try {
            await execute("stock.picking", "action_cancel", [[p.id]]);
        } catch (e) {
            avisos.push("Não foi possível cancelar a entrega extra " + p.name + ": " + e.message);
        }
    }

    // 2) entrega principal (a concluída mais antiga)
    const feitas = await execute("stock.picking", "search_read", [[
        ["sale_id", "=", oid], ["picking_type_code", "=", "outgoing"], ["state", "=", "done"]
    ]], { fields: ["id", "name", "location_id", "location_dest_id", "picking_type_id"], order: "id asc" }).catch(() => []);
    if (!feitas || feitas.length === 0) {
        avisos.push("A venda não tem entrega concluída para ajustar. Confira a entrega no Odoo.");
        return avisos;
    }
    const principal = feitas[0];
    if (feitas.length > 1) avisos.push("Esta venda tem mais de uma entrega concluída; só a " + principal.name + " foi ajustada.");
    try { await definirBloqueioEntregas(oid, false); } catch (e) { /* segue mesmo assim */ }

    const linhas = await execute("sale.order.line", "search_read", [[["order_id", "=", oid], ["display_type", "=", false]]], { fields: ["id", "product_id", "product_uom_qty"] });
    const movimentos = await execute("stock.move", "search_read", [[["picking_id", "=", principal.id], ["state", "!=", "cancel"]]], { fields: ["id", "product_id", "product_uom_qty", "quantity", "state", "sale_line_id"] });

    const idsLinhas = (linhas || []).map(l => l.id);
    const novas = [];

    for (const l of (linhas || [])) {
        const qtd = Number(l.product_uom_qty);
        const mv = (movimentos || []).find(m => Array.isArray(m.sale_line_id) && m.sale_line_id[0] === l.id);
        const nomeProd = Array.isArray(l.product_id) ? l.product_id[1] : "";
        if (!mv) { novas.push(l); continue; }
        if (Number(mv.product_uom_qty) === qtd && Number(mv.quantity) === qtd) continue;
        try {
            try {
                await execute("stock.move", "write", [[mv.id], { product_uom_qty: qtd, quantity: qtd }]);
            } catch (e1) {
                await execute("stock.move", "write", [[mv.id], { product_uom_qty: qtd }]);
                await execute("stock.move", "write", [[mv.id], { quantity: qtd }]);
            }
        } catch (e) {
            avisos.push("Não foi possível ajustar a quantidade de " + nomeProd + " na entrega: " + e.message);
        }
    }

    // produtos que saíram do pedido: retira da entrega (ou zera, se o Odoo não deixar excluir)
    const orfaos = (movimentos || []).filter(m => !(Array.isArray(m.sale_line_id) && idsLinhas.includes(m.sale_line_id[0])));
    for (const m of orfaos) {
        const nome = Array.isArray(m.product_id) ? m.product_id[1] : "";
        try {
            await execute("stock.move", "unlink", [[m.id]]);
        } catch (e1) {
            try {
                await execute("stock.move", "write", [[m.id], { product_uom_qty: 0, quantity: 0 }]);
            } catch (e2) {
                avisos.push("Não foi possível retirar " + nome + " da entrega: " + e2.message);
            }
        }
    }

    // produtos novos no pedido: entram na MESMA entrega
    if (novas.length > 0) {
        try {
            const locOrigem = Array.isArray(principal.location_id) ? principal.location_id[0] : principal.location_id;
            const locDestino = Array.isArray(principal.location_dest_id) ? principal.location_dest_id[0] : principal.location_dest_id;
            const tipoId = Array.isArray(principal.picking_type_id) ? principal.picking_type_id[0] : principal.picking_type_id;
            const novosIds = [];
            for (const l of novas) {
                const prodId = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
                const prod = await execute("product.product", "read", [[prodId]], { fields: ["uom_id", "display_name"] });
                const uom = prod && prod[0] && Array.isArray(prod[0].uom_id) ? prod[0].uom_id[0] : null;
                const vals = await onlyExistingFields("stock.move", {
                    picking_id: principal.id,
                    product_id: prodId,
                    product_uom_qty: Number(l.product_uom_qty),
                    product_uom: uom,
                    uom_id: uom,
                    name: prod && prod[0] ? prod[0].display_name : "",
                    location_id: locOrigem,
                    location_dest_id: locDestino,
                    picking_type_id: tipoId,
                    sale_line_id: l.id
                });
                novosIds.push(await execute("stock.move", "create", [vals]));
            }
            await execute("stock.picking", "action_confirm", [[principal.id]]);
            await execute("stock.picking", "action_assign", [[principal.id]]).catch(() => {});
            for (const mid of novosIds) {
                const dem = await execute("stock.move", "read", [[mid]], { fields: ["product_uom_qty"] });
                const q = dem && dem[0] ? dem[0].product_uom_qty : 0;
                try {
                    await execute("stock.move", "write", [[mid], { quantity: q }]);
                } catch (e2) {
                    await execute("stock.move", "write", [[mid], { quantity_done: q }]).catch(() => {});
                }
            }
            if (!(await validarPickingComAssistentes(principal.id)).ok) avisos.push("A entrega foi atualizada, mas não ficou concluída. Finalize-a no Odoo para o estoque ficar certo.");
        } catch (e) {
            avisos.push("Não foi possível incluir os produtos novos na entrega: " + e.message);
        }
    }

    // a validação pode ter trancado a entrega de novo
    try { await definirBloqueioEntregas(oid, false); } catch (e) { /* ok */ }
    return avisos;
}

// O Odoo não deixa reduzir/excluir uma linha abaixo do que já foi entregue.
// Por isso a entrega (desbloqueada) é reduzida ANTES de alterar o pedido.
async function reduzirEntregaAntesDoPedido(orderId, reducoes, remocoes) {
    const avisos = [];
    const linhasIds = [...reducoes.map(r => r.lineId), ...remocoes];
    if (linhasIds.length === 0) return avisos;

    // movimentos já concluídos dessas linhas, nas entregas do pedido (mais novos primeiro)
    const moves = await execute("stock.move", "search_read", [[
        ["sale_line_id", "in", linhasIds], ["state", "=", "done"], ["picking_id.picking_type_code", "=", "outgoing"]
    ]], { fields: ["id", "sale_line_id", "quantity", "product_id"], order: "id desc" });
    const porLinha = {};
    (moves || []).forEach(m => {
        if (!Array.isArray(m.sale_line_id)) return;
        (porLinha[m.sale_line_id[0]] = porLinha[m.sale_line_id[0]] || []).push(m);
    });

    const escrever = async (mv, q) => {
        try {
            await execute("stock.move", "write", [[mv.id], { product_uom_qty: q, quantity: q }]);
        } catch (e1) {
            await execute("stock.move", "write", [[mv.id], { product_uom_qty: q }]);
            await execute("stock.move", "write", [[mv.id], { quantity: q }]);
        }
    };

    // quantidade reduzida: tira da entrega o que passou do novo valor
    for (const r of reducoes) {
        const lista = porLinha[r.lineId] || [];
        const entregue = lista.reduce((t, m) => t + Number(m.quantity), 0);
        let excesso = entregue - Number(r.qty);
        for (const mv of lista) {
            if (excesso <= 0) break;
            const tira = Math.min(Number(mv.quantity), excesso);
            try {
                await escrever(mv, Number(mv.quantity) - tira);
                excesso -= tira;
            } catch (e) {
                avisos.push("Não foi possível reduzir a entrega de " + (Array.isArray(mv.product_id) ? mv.product_id[1] : "um produto") + ": " + e.message);
                break;
            }
        }
    }

    // produto excluído: retira da entrega (ou zera, se o Odoo não deixar excluir a linha)
    for (const lid of remocoes) {
        for (const mv of (porLinha[lid] || [])) {
            try {
                await execute("stock.move", "unlink", [[mv.id]]);
            } catch (e1) {
                try {
                    await escrever(mv, 0);
                } catch (e2) {
                    avisos.push("Não foi possível retirar " + (Array.isArray(mv.product_id) ? mv.product_id[1] : "um produto") + " da entrega: " + e2.message);
                }
            }
        }
    }
    return avisos;
}

        // Devolve ao estoque de origem os itens de todas as entregas JÁ CONCLUÍDAS de um pedido
        // (mesmo processo manual do Odoo: entrega > "Devolução" > criar devolução > "Validar" o recebimento).
        // Só devolve o que ainda não foi devolvido, então chamar de novo não duplica a devolução.
        const devolverEntregasDoPedido = async (orderId) => {
            const oid = Number(orderId);
            const devolvidos = [];
            const avisos = [];

            const pickings = await execute("stock.picking", "search_read", [[
                ["sale_id", "=", oid], ["state", "=", "done"], ["picking_type_code", "=", "outgoing"]
            ]], { fields: ["id", "name", "location_id", "location_dest_id", "picking_type_id", "partner_id"] });

            for (const p of (pickings || [])) {
                try {
                    // 1) o que saiu nesta entrega
                    let moves;
                    try {
                        moves = await execute("stock.move", "search_read", [[["picking_id", "=", p.id], ["state", "=", "done"]]], { fields: ["id", "quantity"] });
                    } catch (e) {
                        moves = await execute("stock.move", "search_read", [[["picking_id", "=", p.id], ["state", "=", "done"]]], { fields: ["id", "quantity_done"] });
                        moves = moves.map(m => ({ id: m.id, quantity: m.quantity_done }));
                    }
                    const moveIds = (moves || []).map(m => m.id);
                    if (moveIds.length === 0) continue;

                    // 2) o que já foi devolvido antes (evita devolver duas vezes)
                    const jaDevolvidos = await execute("stock.move", "search_read", [[["origin_returned_move_id", "in", moveIds], ["state", "!=", "cancel"]]], {
                        fields: ["origin_returned_move_id", "product_uom_qty", "quantity", "state"]
                    }).catch(() => []);
                    const devolvidoPorMove = {};
                    (jaDevolvidos || []).forEach(r => {
                        const origem = Array.isArray(r.origin_returned_move_id) ? r.origin_returned_move_id[0] : r.origin_returned_move_id;
                        const qtd = r.state === "done" ? (r.quantity || 0) : (r.product_uom_qty || 0);
                        devolvidoPorMove[origem] = (devolvidoPorMove[origem] || 0) + qtd;
                    });

                    const restante = {};
                    let temAlgoParaDevolver = false;
                    moves.forEach(m => {
                        restante[m.id] = Math.max(0, (m.quantity || 0) - (devolvidoPorMove[m.id] || 0));
                        if (restante[m.id] > 0) temAlgoParaDevolver = true;
                    });
                    if (!temAlgoParaDevolver) continue;

                    // 3) cria o recebimento de devolução (o que o botão "Devolução" faz no Odoo).
                    // Nesta versão do Odoo o assistente "stock.return.picking" não existe mais:
                    // o botão cria direto um recebimento em rascunho, e é isso que fazemos aqui,
                    // já com a "Demanda" igual à quantidade que saiu no pedido.
                    const origemId = Array.isArray(p.location_id) ? p.location_id[0] : p.location_id;      // estoque de onde saiu
                    const clienteLocId = Array.isArray(p.location_dest_id) ? p.location_dest_id[0] : p.location_dest_id;
                    const tipoOrigemId = Array.isArray(p.picking_type_id) ? p.picking_type_id[0] : p.picking_type_id;

                    // tipo de operação de devolução ("Recebimentos") definido no tipo da entrega
                    let tipoDevolucaoId = null;
                    let armazemTipoId = null;
                    try {
                        const defsTipo = await onlyExistingFields("stock.picking.type", { return_picking_type_id: 1, warehouse_id: 1 });
                        const camposTipo = Object.keys(defsTipo);
                        if (camposTipo.length > 0) {
                            const tp = await execute("stock.picking.type", "read", [[tipoOrigemId]], { fields: camposTipo });
                            if (tp && tp[0] && Array.isArray(tp[0].return_picking_type_id)) tipoDevolucaoId = tp[0].return_picking_type_id[0];
                            if (tp && tp[0] && Array.isArray(tp[0].warehouse_id)) armazemTipoId = tp[0].warehouse_id[0];
                        }
                    } catch (e) { /* tenta o plano B abaixo */ }
                    if (!tipoDevolucaoId) {
                        // plano B: tipo "Recebimentos" do mesmo armazém da entrega
                        const dom = [["code", "=", "incoming"]];
                        if (armazemTipoId) dom.push(["warehouse_id", "=", armazemTipoId]);
                        const incoming = await execute("stock.picking.type", "search_read", [dom], { fields: ["id"], limit: 1 }).catch(() => []);
                        if (incoming && incoming[0]) tipoDevolucaoId = incoming[0].id;
                    }
                    if (!tipoDevolucaoId) throw new Error("não foi encontrado o tipo de operação de devolução (Recebimentos) deste local");

                    // linhas originais completas (para copiar produto e unidade de medida)
                    const movesCompletos = await execute("stock.move", "read", [moveIds]);
                    const moveCommands = [];
                    for (const mv of movesCompletos) {
                        const qtd = restante[mv.id] || 0;
                        if (qtd <= 0) continue;
                        const uom = Array.isArray(mv.product_uom) ? mv.product_uom[0] : (Array.isArray(mv.uom_id) ? mv.uom_id[0] : null);
                        const vals = await onlyExistingFields("stock.move", {
                            product_id: Array.isArray(mv.product_id) ? mv.product_id[0] : mv.product_id,
                            product_uom_qty: qtd,
                            product_uom: uom,
                            uom_id: uom,
                            location_id: clienteLocId,
                            location_dest_id: origemId,
                            origin_returned_move_id: mv.id,
                            picking_type_id: tipoDevolucaoId,
                            origin: "Devolução de " + p.name
                        });
                        moveCommands.push([0, 0, vals]);
                    }

                    const pickingVals = await onlyExistingFields("stock.picking", {
                        picking_type_id: tipoDevolucaoId,
                        partner_id: Array.isArray(p.partner_id) ? p.partner_id[0] : false,
                        origin: "Devolução de " + p.name,
                        location_id: clienteLocId,
                        location_dest_id: origemId,
                        return_id: p.id,
                        move_ids: moveCommands
                    });
                    const novoId = await execute("stock.picking", "create", [pickingVals]);
                    if (!novoId) throw new Error("o Odoo não criou o recebimento de devolução");

                    // 4) validar o recebimento (botão "Validar" do Odoo), com a quantidade devolvida
                    let info = await execute("stock.picking", "read", [[novoId]], { fields: ["name", "state"] });
                    if (info[0].state === "draft") {
                        await execute("stock.picking", "action_confirm", [[novoId]]);
                    }
                    const novosMoves = await execute("stock.move", "search_read", [[["picking_id", "=", novoId]]], { fields: ["id", "product_uom_qty"] });
                    for (const mv of (novosMoves || [])) {
                        try {
                            await execute("stock.move", "write", [[mv.id], { quantity: mv.product_uom_qty }]);
                        } catch (e2) {
                            await execute("stock.move", "write", [[mv.id], { quantity_done: mv.product_uom_qty }]).catch(() => {});
                        }
                    }

                    const vres = await validarPickingComAssistentes(novoId);
                    if (vres.ok) {
                        devolvidos.push(vres.name);
                    } else {
                        avisos.push("A devolução " + vres.name + " foi criada, mas não foi validada. Valide-a no Odoo para o item voltar ao estoque.");
                    }
                } catch (e) {
                    avisos.push("Não foi possível devolver ao estoque a entrega " + p.name + ": " + e.message + " Faça a devolução manualmente no Odoo.");
                }
            }
            return { devolvidos, avisos };
        };

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    let body;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    } catch (e) {
        return res.status(400).json({ error: "Requisição inválida (JSON malformado)." });
    }
    const action = body.action || "";

    // Teste de conexão do app (não fala com o Odoo): o app usa para saber se está mesmo sem internet
    if (action === "ping") return res.status(200).json({ ok: true });

    const missingEnv = ["ODOO_URL", "ODOO_DB", "ODOO_USER", "ODOO_API_KEY"].filter(k => !process.env[k]);
    if (missingEnv.length > 0) {
        return res.status(500).json({ error: "Variáveis de ambiente ausentes na Vercel: " + missingEnv.join(", ") });
    }
    if (!action) return res.status(400).json({ error: "Informe a ação." });

    try {
        const uid = await getUid();

        if (!uid) {
            return res.status(401).json({ error: "Falha na autenticação com o Odoo." });
        }

        // Encontra o tipo de operação de "Transferência Interna" correspondente ao local de origem
        // (mesma lógica que o próprio Odoo usa para preencher "Tipo de operação" automaticamente)
        const resolveInternalPickingType = async (locationId) => {
            const types = await lookups.internalPickingTypes();
            if (!types || types.length === 0) return null;
            if (locationId) {
                const match = types.find(t => Array.isArray(t.default_location_src_id) && t.default_location_src_id[0] === Number(locationId));
                if (match) return match;
            }
            return types[0];
        };

        // Força todas as linhas de produto de uma fatura a usarem sempre a mesma conta contábil,
        // sem que isso precise aparecer/ser escolhido na tela do nosso site
        const FORCED_INVOICE_ACCOUNT_CODE = process.env.ODOO_FORCED_ACCOUNT_CODE || "3.01.01.01.01.04";
        const resolveForcedAccountId = async () => {
            if (forcedAccountIdCache) return forcedAccountIdCache;
            const accs = await execute("account.account", "search_read", [[["code", "=", FORCED_INVOICE_ACCOUNT_CODE]]], { fields: ["id"] });
            if (accs && accs.length > 0) {
                forcedAccountIdCache = accs[0].id;
                return forcedAccountIdCache;
            }
            return null;
        };
        const applyForcedAccountToInvoice = async (invoiceId) => {
            const accountId = await resolveForcedAccountId();
            if (!accountId) return;
            const lines = await execute("account.move.line", "search_read", [[["move_id", "=", invoiceId], ["display_type", "=", "product"], ["account_id", "!=", accountId]]], { fields: ["id"] });
            const ids = (lines || []).map(l => l.id);
            if (ids.length > 0) {
                await execute("account.move.line", "write", [ids, { account_id: accountId }]);
            }
        };

        // Gera a fatura (rascunho) usando o assistente "Criar fatura" do Odoo.
        // Métodos privados (que começam com "_", como sale.order._create_invoices) são bloqueados
        // pelo Odoo via API externa; o assistente usa só métodos públicos e faz o mesmo trabalho.
        const criarFaturasDoPedido = async (orderId) => {
            const oid = Number(orderId);
            const ctx = { active_model: "sale.order", active_id: oid, active_ids: [oid] };

            const antes = await execute("sale.order", "read", [[oid]], { fields: ["invoice_ids"] });
            const idsAntes = (antes && antes[0] && antes[0].invoice_ids) || [];

            const wizardId = await execute("sale.advance.payment.inv", "create", [{ advance_payment_method: "delivered" }], { context: ctx });
            await execute("sale.advance.payment.inv", "create_invoices", [[wizardId]], { context: ctx });

            const depois = await execute("sale.order", "read", [[oid]], { fields: ["invoice_ids"] });
            const idsDepois = (depois && depois[0] && depois[0].invoice_ids) || [];
            return idsDepois.filter(id => !idsAntes.includes(id));
        };

        // Coloca a data de vencimento na "Data de vencimento" da fatura (a fatura não usa condição de pagamento)
        const aplicarVencimentoNaFatura = async (invoiceId, dueDate) => {
            if (!invoiceId || !dueDate) return;
            await execute("account.move", "write", [[Number(invoiceId)], { invoice_date_due: dueDate }]);
        };

        // Fatura paga => tranca pedido e entrega; fatura não paga => ficam destravados
        const sincronizarBloqueioPorFatura = async (invoiceId) => {
            const pedidos = await execute("sale.order", "search_read", [[["invoice_ids", "in", [Number(invoiceId)]]]], { fields: ["id"] });
            for (const ped of (pedidos || [])) await sincronizarBloqueioDoPedido(ped.id);
        };
        // Espelha a fatura do pedido com as linhas do pedido (produto, quantidade e preço):
        // a fatura provisória é refeita a partir do pedido. Fatura já paga não é mexida.
        const espelharFaturaComPedido = async (orderId, dueDate, hoje) => {
            const oid = Number(orderId);
            const avisos = [];
            const ped = await execute("sale.order", "read", [[oid]], { fields: ["invoice_ids"] });
            const ids = (ped && ped[0] && ped[0].invoice_ids) || [];
            if (ids.length === 0) return avisos;

            // Sem fatura ativa (a antiga foi desfeita numa tentativa anterior que parou no meio): segue e gera a nova
            const faturas = (await execute("account.move", "search_read", [[["id", "in", ids], ["state", "!=", "cancel"]]], { fields: ["id", "name", "state", "payment_state"] })) || [];

            const comPagamento = faturas.filter(f => f.payment_state && !["not_paid"].includes(f.payment_state));
            if (comPagamento.length > 0) {
                avisos.push("A fatura " + comPagamento.map(f => f.name).join(", ") + " já tem pagamento e não foi ajustada. Desfaça o pagamento para a fatura acompanhar a venda.");
                return avisos;
            }

            for (const f of faturas) {
                try {
                    if (f.state === "posted") await execute("account.move", "button_draft", [[f.id]]);
                    try {
                        await execute("account.move", "unlink", [[f.id]]);
                    } catch (e1) {
                        await execute("account.move", "button_cancel", [[f.id]]);
                    }
                } catch (e) {
                    avisos.push("Não foi possível refazer a fatura " + f.name + ": " + e.message);
                    return avisos;
                }
            }

            try {
                const novos = await criarFaturasDoPedido(oid);
                if (!novos || novos.length === 0) {
                    avisos.push("A fatura não foi refeita: o Odoo não gerou uma nova fatura para a venda.");
                    return avisos;
                }
                for (const nid of novos) {
                    await applyForcedAccountToInvoice(nid);
                    const dados = { invoice_date: hoje };
                    if (dueDate) dados.invoice_date_due = dueDate;
                    await execute("account.move", "write", [[nid], dados]);
                }
            } catch (e) {
                avisos.push("A fatura antiga foi desfeita, mas não foi possível gerar a nova: " + e.message + " Use \"Gerar Fatura\" no Odoo.");
            }
            return avisos;
        };

        // AÇÃO: BUSCAR DIÁRIOS / CONTAS DE PAGAMENTO (BANCO/CAIXA)
        if (action === "get_payment_journals") {
            // Só contas do tipo "Banco e caixa" (mesmo critério do Plano de contas do Odoo).
            // O pagamento é lançado pelo diário (id), mas a lista mostra o nome da conta financeira dele.
            const contasPgto = await cached("payment_accounts", TTL_LONG, async () => {
                const diarios = await execute("account.journal", "search_read", [[["type", "in", ["bank", "cash"]]]], {
                    fields: ["id", "name", "type", "default_account_id"]
                });
                const accIds = [...new Set((diarios || []).map(j => Array.isArray(j.default_account_id) ? j.default_account_id[0] : null).filter(Boolean))];
                const contas = accIds.length
                    ? await execute("account.account", "search_read", [[["id", "in", accIds], ["account_type", "in", ["asset_cash", "bank_and_cash"]]]], { fields: ["id", "name"] })
                    : [];
                const nomePorConta = {};
                (contas || []).forEach(c => { nomePorConta[c.id] = c.name; });
                return (diarios || [])
                    .filter(j => Array.isArray(j.default_account_id) && nomePorConta[j.default_account_id[0]])
                    .map(j => ({ id: j.id, name: nomePorConta[j.default_account_id[0]], journal_name: j.name, type: j.type }))
                    .sort((a, b) => String(a.name).localeCompare(String(b.name), "pt-BR"));
            });
            return res.status(200).json({ result: contasPgto || [] });
        }

        // ---- Crédito do cliente (pagamentos/notas de crédito em aberto, sem fatura ligada) ----
        const LINHA_RECEBER = ["account_id.account_type", "=", "asset_receivable"];

        // Cliente da fatura (cadastro comercial) para consultar o crédito
        const clienteDaFatura = async (invoiceId) => {
            const f = await execute("account.move", "read", [[Number(invoiceId)]], { fields: ["partner_id", "commercial_partner_id", "name", "state", "amount_residual"] });
            const inv = f && f[0];
            if (!inv) return null;
            const pid = Array.isArray(inv.commercial_partner_id) ? inv.commercial_partner_id[0]
                : (Array.isArray(inv.partner_id) ? inv.partner_id[0] : null);
            return { inv, partnerId: pid, payerId: Array.isArray(inv.partner_id) ? inv.partner_id[0] : pid };
        };

        // Linhas de crédito em aberto do cliente (mais antigas primeiro)
        const linhasDeCredito = async (partnerId, exceptMoveId) => {
            const dom = [["partner_id", "child_of", Number(partnerId)], LINHA_RECEBER, ["parent_state", "=", "posted"], ["amount_residual", "<", 0]];
            if (exceptMoveId) dom.push(["move_id", "!=", Number(exceptMoveId)]);
            return (await execute("account.move.line", "search_read", [dom], { fields: ["id", "amount_residual", "date"], order: "date asc, id asc" })) || [];
        };

        // Trava contra envio repetido: o app manda o saldo que a fatura tinha na tela. Se o saldo no Odoo já é outro,
        // o mais provável é que o envio anterior chegou (a conexão caiu antes da resposta) e o usuário tocou de novo.
        const saldoMudou = (residualAtual, esperado) =>
            esperado !== undefined && esperado !== null && esperado !== "" && Number.isFinite(Number(esperado)) && !mesmoValor(residualAtual, esperado);
        const erroSaldoMudou = (residualAtual, esperado) =>
            "O saldo da fatura mudou (agora " + fmtBR(residualAtual) + ", na tela era " + fmtBR(esperado) + "). " +
            "Provavelmente o pagamento já foi registrado: atualize a venda antes de tentar de novo.";

        // AÇÃO: CRÉDITO DISPONÍVEL DO CLIENTE (pela fatura)
        if (action === "get_customer_credit") {
            const { invoice_id } = body;
            if (!invoice_id) return res.status(400).json({ error: "ID da fatura é obrigatório." });
            const c = await clienteDaFatura(invoice_id);
            if (!c || !c.partnerId) return res.status(200).json({ credit: 0 });
            const linhas = await linhasDeCredito(c.partnerId, invoice_id);
            const total = r2(linhas.reduce((t, l) => t - Number(l.amount_residual), 0));
            return res.status(200).json({ credit: total > 0 ? total : 0, partner_id: c.partnerId });
        }

        // Conciliação PARCIAL (usa só uma parte do crédito, valor escolhido pelo usuário). O Odoo não tem método
        // público para um valor parcial qualquer, então a conciliação é criada e o resultado é CONFERIDO
        // (saldo da fatura antes x depois). Se não bater, ela é desfeita e nada fica pela metade.
        const conciliarParcial = async (faturaLinhaId, creditoLinhaId, valor, invoiceId) => {
            const antes = await execute("account.move", "read", [[invoiceId]], { fields: ["amount_residual"] });
            const resAntes = r2(antes && antes[0] ? antes[0].amount_residual : 0);
            let pid = await execute("account.partial.reconcile", "create", [{
                debit_move_id: faturaLinhaId, credit_move_id: creditoLinhaId,
                amount: valor, debit_amount_currency: valor, credit_amount_currency: valor
            }]);
            if (Array.isArray(pid)) pid = pid[0];
            const depois = await execute("account.move", "read", [[invoiceId]], { fields: ["amount_residual"] });
            const resDepois = r2(depois && depois[0] ? depois[0].amount_residual : NaN);
            if (!mesmoValor(resAntes - valor, resDepois, 0.005)) {
                if (pid) await execute("account.partial.reconcile", "unlink", [[pid]]).catch(() => {});
                throw new Error("o Odoo não aplicou o crédito como esperado (saldo da fatura " + fmtBR(resDepois) +
                    " em vez de " + fmtBR(resAntes - valor) + "). Esse uso foi desfeito.");
            }
        };

        // AÇÃO: USAR CRÉDITO DO CLIENTE NA FATURA (valor escolhido pelo usuário)
        if (action === "apply_customer_credit") {
            const { invoice_id, amount, expected_residual } = body;
            const X = r2(amount);
            if (!invoice_id || !(X > 0)) return res.status(400).json({ error: "Informe o valor do crédito a usar." });

            let c = await clienteDaFatura(invoice_id);
            if (!c) return res.status(404).json({ error: "Fatura não encontrada." });
            if (c.inv.state === "draft") {
                try { await execute("account.move", "action_post", [[Number(invoice_id)]]); }
                catch (e) { return res.status(400).json({ error: "Não foi possível lançar a fatura para usar o crédito: " + e.message }); }
                c = await clienteDaFatura(invoice_id);
            }
            if (c.inv.state !== "posted") return res.status(400).json({ error: "A fatura não está lançada." });

            const residual = r2(c.inv.amount_residual);
            if (saldoMudou(residual, expected_residual)) return res.status(409).json({ error: erroSaldoMudou(residual, expected_residual) });
            if (X > residual + 0.005) return res.status(400).json({ error: "O crédito informado é maior que o saldo da fatura (" + fmtBR(residual) + ")." });

            const creditos = await linhasDeCredito(c.partnerId, invoice_id);
            const disponivel = r2(creditos.reduce((t, l) => t - Number(l.amount_residual), 0));
            if (X > disponivel + 0.005) return res.status(400).json({ error: "O cliente só tem " + fmtBR(disponivel) + " de crédito." });

            const linhaFat = await execute("account.move.line", "search_read", [[["move_id", "=", Number(invoice_id)], LINHA_RECEBER, ["amount_residual", ">", 0]]], { fields: ["id", "amount_residual"], limit: 1 });
            if (!linhaFat || linhaFat.length === 0) return res.status(400).json({ error: "A fatura não tem saldo a receber." });
            const fatId = linhaFat[0].id;

            const plano = planejarCredito(creditos, residual, X);
            let aplicado = 0;
            try {
                for (const passo of plano.passos) {
                    if (passo.inteiro) {
                        // usa a linha inteira (ou até quitar a fatura): conciliação padrão do Odoo
                        await execute("account.move.line", "reconcile", [[fatId, passo.lineId]]);
                    } else {
                        await conciliarParcial(fatId, passo.lineId, passo.valor, Number(invoice_id));
                    }
                    aplicado = r2(aplicado + passo.valor);
                }
            } catch (e) {
                return res.status(500).json({ error: "Não foi possível usar o crédito: " + e.message, applied: aplicado });
            }
            if (plano.faltaUsar > 0.005) return res.status(500).json({ error: "Só foi possível usar " + fmtBR(aplicado) + " de crédito.", applied: aplicado });

            try { await sincronizarBloqueioPorFatura(Number(invoice_id)); } catch (e) { /* melhor esforço */ }
            return res.status(200).json({ success: true, applied: aplicado, residual: plano.saldoFat });
        }

        // Registra UM pagamento numa fatura (o que passar do saldo vira crédito do cliente).
        // Devolve { excess } se deu certo ou { status, error } se falhou. Não mexe no travamento do pedido.
        // `esperado`: saldo que a fatura tinha na tela (só no 1º pagamento do envio) — evita pagamento em duplicidade.
        const registrarUmPagamento = async (order_id, journal_id, amount, payment_date, esperado = null) => {
            if (!order_id || !journal_id || !(Number(amount) > 0)) {
                return { status: 400, error: "Campos obrigatórios não informados." };
            }

            // Uma leitura só traz estado, cliente e saldo. A fatura fica provisória até aqui: lança agora para poder pagar.
            let c = await clienteDaFatura(order_id);
            if (!c) return { status: 404, error: "Fatura não encontrada." };
            if (c.inv.state === "draft") {
                try {
                    await execute("account.move", "action_post", [[Number(order_id)]]);
                } catch (e) {
                    return { status: 400, error: "Não foi possível lançar a fatura para registrar o pagamento: " + e.message };
                }
                c = await clienteDaFatura(order_id);
            }
            if (c.inv.state !== "posted") return { status: 400, error: "A fatura não está lançada (ela pode ter sido cancelada). Atualize a venda." };

            const residual = Math.max(0, r2(c.inv.amount_residual));
            if (saldoMudou(residual, esperado)) return { status: 409, error: erroSaldoMudou(residual, esperado) };

            const valor = r2(amount);
            const paraFatura = Math.min(valor, residual);
            const excedente = r2(valor - paraFatura);

            if (paraFatura > 0.004) {
                const wizardId = await execute("account.payment.register", "create", [{
                    journal_id: Number(journal_id),
                    amount: paraFatura,
                    payment_date: payment_date || false
                }], {
                    context: { active_model: "account.move", active_ids: [Number(order_id)] }
                });
                if (!wizardId) return { status: 500, error: "Não foi possível gerar o pagamento no Odoo." };
                await execute("account.payment.register", "action_create_payments", [[wizardId]], {
                    context: { active_model: "account.move", active_ids: [Number(order_id)] }
                });
            }

            // Passou do saldo: o excedente entra como pagamento do cliente sem fatura (= crédito para compras futuras)
            if (excedente > 0.004) {
                if (!c.payerId) return { status: 400, error: "Não foi possível identificar o cliente para guardar o crédito." };
                try {
                    const dados = {
                        payment_type: "inbound", partner_type: "customer", partner_id: c.payerId,
                        amount: excedente, journal_id: Number(journal_id),
                        ref: "Crédito do cliente - " + (c.inv.name || "")
                    };
                    if (payment_date) dados.date = payment_date;
                    const pid = await execute("account.payment", "create", [dados]);
                    await execute("account.payment", "action_post", [[pid]]);
                } catch (e) {
                    return { status: 500, error: "A fatura foi paga, mas não foi possível guardar o crédito de " + fmtBR(excedente) + ": " + e.message };
                }
            }
            return { excess: excedente };
        };

        // AÇÃO: REGISTRAR VÁRIOS PAGAMENTOS DE UMA VEZ (pagamento dividido em formas diferentes).
        // Trava o pedido/entrega UMA vez no fim, em vez de uma vez por pagamento.
        if (action === "register_payments") {
            const { order_id, payments, payment_date, expected_residual } = body;
            if (!order_id || !Array.isArray(payments) || payments.length === 0) {
                return res.status(400).json({ error: "Informe ao menos um pagamento." });
            }
            let feitos = 0, excedente = 0, falha = null, statusFalha = 500;
            for (const p of payments) {
                const r = await registrarUmPagamento(order_id, p.journal_id, p.amount, p.payment_date || payment_date, feitos === 0 ? expected_residual : null);
                if (r.error) { falha = r.error; statusFalha = r.status || 500; break; }
                feitos++;
                excedente = r2(excedente + (r.excess || 0));
            }
            try { await sincronizarBloqueioPorFatura(Number(order_id)); } catch (e) { /* melhor esforço */ }
            if (falha) {
                return res.status(statusFalha).json({
                    error: (feitos > 0 ? feitos + " de " + payments.length + " pagamento(s) foram registrados. " : "") + falha,
                    registered: feitos
                });
            }
            return res.status(200).json({ success: true, registered: feitos, excess: excedente });
        }

        // AÇÃO: BUSCAR ARMAZÉNS (LOCAIS DE ESTOQUE PARA VENDA)
        if (action === "get_warehouses") {
            const warehouses = await lookups.warehouses();
            return res.status(200).json({ result: warehouses || [] });
        }

        // AÇÃO: PRODUTOS COM ESTOQUE EM UM ARMAZÉM (para as linhas do pedido de venda)
        if (action === "get_warehouse_products") {
            const whId = Number(body.warehouse_id) || 0;
            if (!whId) return res.status(400).json({ error: "Armazém é obrigatório." });

            // armazéns vêm da lista guardada em memória (10 min): uma chamada a menos ao Odoo a cada abertura da venda
            const whs = await lookups.warehouses();
            const wh = (whs || []).find(w => w.id === whId);
            if (!wh) return res.status(404).json({ error: "Armazém não encontrado." });
            // usa o local de estoque do armazém (ex.: "CASA/Stock") e sublocais, o mesmo que aparece em Relatórios > Detailed Stock
            const rootLoc = Array.isArray(wh.lot_stock_id) ? wh.lot_stock_id[0] : (Array.isArray(wh.view_location_id) ? wh.view_location_id[0] : null);
            if (!rootLoc) return res.status(404).json({ error: "Armazém sem local de estoque." });

            // estoque físico do armazém (locais internos dele e sublocais), somado por produto
            const qtyByProduct = await saldoPorProduto(rootLoc);
            const ids = Object.keys(qtyByProduct).map(Number);
            if (ids.length === 0) return res.status(200).json({ products: [] });

            // OBS: não usar order "display_name" aqui — é um campo calculado (não armazenado) e o Odoo rejeita a ordenação.
            // A ordem alfabética é feita aqui no servidor.
            const products = await execute("product.product", "search_read", [[["id", "in", ids], ["sale_ok", "=", true]]], {
                fields: ["id", "display_name", "list_price"]
            });
            const list = (products || [])
                .map(pr => ({ ...pr, stock_qty: qtyByProduct[pr.id] }))
                .sort((a, b) => (a.display_name || "").localeCompare(b.display_name || "", "pt-BR"));
            return res.status(200).json({ products: list });
        }

        // Cancela uma venda JÁ LANÇADA (ou qualquer pedido): destrava, cancela o pedido, devolve pagamentos/crédito
        // ao cliente e devolve ao estoque o que já tinha sido entregue. Usada por "Cancelar venda" e pela troca de status.
        const cancelarPedidoLancado = async (oid) => {
            const ctx = { disable_cancel_warning: true };

            // O Odoo não deixa cancelar pedido BLOQUEADO: é preciso destravar antes.
            let estavaBloqueado = false;
            try {
                const info = await execute("sale.order", "read", [[oid]], { fields: ["state", "locked"] });
                estavaBloqueado = !!(info && info[0] && info[0].locked);
            } catch (e) {
                // versões do Odoo sem o campo "locked": o bloqueio era o estado "done"
                const info = await execute("sale.order", "read", [[oid]], { fields: ["state"] });
                estavaBloqueado = !!(info && info[0] && info[0].state === "done");
            }

            // 1º cancela o PEDIDO. Se o Odoo recusar, nada mais foi mexido (faturas e pagamentos continuam como estavam).
            if (estavaBloqueado) {
                await execute("sale.order", "action_unlock", [[oid]]);
            }
            try {
                await execute("sale.order", "action_cancel", [[oid]], { context: ctx });
            } catch (e) {
                // se não deu para cancelar, devolve o pedido ao estado bloqueado em que estava
                if (estavaBloqueado) {
                    await execute("sale.order", "action_lock", [[oid]]).catch(() => {});
                }
                throw e;
            }

            // 2º pagamentos e crédito usados nas faturas da venda voltam para o cliente como crédito
            let creditoDevolvido = 0;
            const avisosCredito = [];
            try {
                const pedF = await execute("sale.order", "read", [[oid]], { fields: ["invoice_ids"] });
                const idsF = (pedF && pedF[0] && pedF[0].invoice_ids) || [];
                if (idsF.length > 0) {
                    const postadas = await execute("account.move", "search_read", [[["id", "in", idsF], ["state", "=", "posted"]]], { fields: ["id", "name", "amount_total", "amount_residual"] });
                    for (const f of (postadas || [])) {
                        const pago = r2(Number(f.amount_total) - Number(f.amount_residual));
                        try {
                            if (pago > 0.004) {
                                const linhas = await execute("account.move.line", "search_read", [[["move_id", "=", f.id], LINHA_RECEBER]], { fields: ["id"] });
                                await execute("account.move.line", "remove_move_reconcile", [(linhas || []).map(l => l.id)]);
                                creditoDevolvido = r2(creditoDevolvido + pago);
                            }
                            await execute("account.move", "button_draft", [[f.id]]);
                            await execute("account.move", "button_cancel", [[f.id]]);
                        } catch (e) {
                            avisosCredito.push("Não foi possível desfazer o pagamento da fatura " + f.name + ": " + e.message);
                        }
                    }
                }
            } catch (e) {
                avisosCredito.push("Não foi possível devolver o crédito ao cliente: " + e.message);
            }

            // Pedido cancelado: devolve ao estoque de origem o que já tinha sido entregue
            let devolvidos = [];
            let warnings = [];
            try {
                const r = await devolverEntregasDoPedido(oid);
                devolvidos = r.devolvidos;
                warnings = r.avisos;
            } catch (e) {
                warnings.push("Venda cancelada, mas não foi possível devolver o item ao estoque: " + e.message + " Faça a devolução manualmente no Odoo.");
            }
            warnings.push(...avisosCredito);
            return { devolvidos, warnings, creditoDevolvido };
        };

        // AÇÃO: CANCELAR PEDIDO DE VENDA
        if (action === "cancel_sale_order") {
            const { order_id } = body;
            if (!order_id) {
                return res.status(400).json({ error: "ID do pedido é obrigatório." });
            }
            const r = await cancelarPedidoLancado(Number(order_id));
            return res.status(200).json({ success: true, devolvidos: r.devolvidos, warnings: r.warnings, credito_devolvido: r.creditoDevolvido });
        }

        // AÇÃO: MUDAR O STATUS DE UMA VENDA entre Orçamento e Cancelada (e de Confirmada para qualquer um deles).
        // Só é permitido quando a venda NÃO tem pagamento nenhum (nem parcial, nem crédito usado).
        if (action === "change_sale_status") {
            const { order_id, status } = body;
            if (!order_id || !["draft", "cancel"].includes(status)) {
                return res.status(400).json({ error: "Informe a venda e o novo status (orçamento ou cancelada)." });
            }
            const oid = Number(order_id);
            const ped = await execute("sale.order", "read", [[oid]], { fields: ["state", "invoice_ids"] });
            if (!ped || !ped[0]) return res.status(404).json({ error: "Pedido de venda não encontrado." });
            const estado = ped[0].state;

            const idsFat = ped[0].invoice_ids || [];
            if (idsFat.length > 0) {
                const comPagamento = await execute("account.move", "search_read", [[
                    ["id", "in", idsFat], ["state", "!=", "cancel"], ["payment_state", "in", ["paid", "in_payment", "partial"]]
                ]], { fields: ["name"] });
                if (comPagamento && comPagamento.length > 0) {
                    return res.status(400).json({ error: "A fatura " + comPagamento.map(f => f.name).join(", ") + " já tem pagamento. Reverta a venda antes de mudar o status." });
                }
            }

            const rascunho = ["draft", "sent"].includes(estado);
            const avisos = [];
            if (status === "cancel") {
                if (estado === "cancel") return res.status(200).json({ success: true, warnings: [] });
                if (rascunho) {
                    await execute("sale.order", "action_cancel", [[oid]], { context: { disable_cancel_warning: true } });
                } else {
                    const r = await cancelarPedidoLancado(oid);
                    avisos.push(...r.warnings);
                }
            } else {
                if (rascunho) return res.status(200).json({ success: true, warnings: [] });
                if (estado !== "cancel") {
                    // venda lançada: cancela primeiro (devolve o estoque e desfaz a fatura) e depois reabre como orçamento
                    const r = await cancelarPedidoLancado(oid);
                    avisos.push(...r.warnings);
                }
                await execute("sale.order", "action_draft", [[oid]]);
            }
            return res.status(200).json({ success: true, warnings: avisos });
        }

        // AÇÃO: EXCLUIR PEDIDO DE VENDA (SOMENTE ORÇAMENTO/RASCUNHO)
        if (action === "delete_sale_order") {
            const { order_id } = body;
            if (!order_id) {
                return res.status(400).json({ error: "ID do pedido é obrigatório." });
            }
            const ped = await execute("sale.order", "read", [[Number(order_id)]], { fields: ["state"] });
            if (!ped || !ped[0]) return res.status(404).json({ error: "Pedido de venda não encontrado." });
            if (!["draft", "sent"].includes(ped[0].state)) {
                return res.status(400).json({ error: "Só orçamentos (rascunhos) podem ser excluídos. Cancele a venda ou volte-a para orçamento antes." });
            }
            await execute("sale.order", "unlink", [[Number(order_id)]]);
            return res.status(200).json({ success: true });
        }

        // ---- Reverter venda paga: analisa o que foi pago (pagamentos em contas x crédito do cliente) ----
        // Pagamento em conta = account.payment criado para ESTA fatura  -> será cancelado
        // Crédito do cliente = conciliação com um pagamento/nota que já existia -> só se desfaz a conciliação (o valor volta como crédito)
        const analisarPagamentosDaVenda = async (oid) => {
            const ped = await execute("sale.order", "read", [[oid]], { fields: ["invoice_ids", "state"] });
            if (!ped || !ped[0]) return null;
            const idsF = ped[0].invoice_ids || [];
            const faturas = idsF.length
                ? (await execute("account.move", "search_read", [[["id", "in", idsF], ["state", "=", "posted"]]], { fields: ["id", "name", "amount_total", "amount_residual"] })) || []
                : [];
            const resultado = [];
            for (const f of faturas) {
                const pago = r2(Number(f.amount_total) - Number(f.amount_residual));
                if (pago <= 0.004) continue;
                const linhasF = (await execute("account.move.line", "search_read", [[["move_id", "=", f.id], LINHA_RECEBER]], { fields: ["id"] })) || [];
                const idsL = linhasF.map(l => l.id);
                if (idsL.length === 0) continue;
                const parciais = (await execute("account.partial.reconcile", "search_read", [["|", ["debit_move_id", "in", idsL], ["credit_move_id", "in", idsL]]], {
                    fields: ["id", "debit_move_id", "credit_move_id", "amount", "create_date"]
                })) || [];
                const contraDe = pa => (idsL.includes(pa.debit_move_id[0]) ? pa.credit_move_id[0] : pa.debit_move_id[0]);
                const linhasContra = parciais.length
                    ? (await execute("account.move.line", "read", [parciais.map(contraDe)], { fields: ["id", "move_id"] })) || []
                    : [];
                const moveDaLinha = {};
                linhasContra.forEach(l => { moveDaLinha[l.id] = l.move_id[0]; });

                const porMove = {};
                parciais.forEach(pa => {
                    const mid = moveDaLinha[contraDe(pa)];
                    if (!mid) return;
                    (porMove[mid] = porMove[mid] || []).push(pa);
                });

                const grupos = [];
                for (const mid of Object.keys(porMove).map(Number)) {
                    const pas = porMove[mid];
                    const valor = r2(pas.reduce((t, pa) => t + Number(pa.amount), 0));
                    const pays = (await execute("account.payment", "search_read", [[["move_id", "=", mid]]], {
                        fields: ["id", "name", "amount", "state", "journal_id", "create_date", "reconciled_invoice_ids"]
                    }).catch(() => [])) || [];
                    let tipo = "credito", pay = null;
                    if (pays.length > 0) {
                        const p = pays[0];
                        const mv = (await execute("account.move", "read", [[mid]], { fields: ["ref"] }).catch(() => [])) || [];
                        const ref = String((mv[0] && mv[0].ref) || "");
                        const refBate = !!f.name && f.name !== "/" && ref.includes(f.name);
                        // pagamento registrado nesta fatura: conciliado no mesmo instante em que foi criado
                        const t0 = Date.parse(String(p.create_date).replace(" ", "T") + "Z");
                        const pertoNoTempo = pas.some(pa => Math.abs(Date.parse(String(pa.create_date).replace(" ", "T") + "Z") - t0) < 30000);
                        if (refBate || pertoNoTempo) { tipo = "pagamento"; pay = p; }
                    }
                    grupos.push({ moveId: mid, tipo, pay, parciais: pas, valor });
                }
                // pagamentos em conta primeiro, depois o crédito
                grupos.sort((a, b) => (a.tipo === "pagamento" ? 0 : 1) - (b.tipo === "pagamento" ? 0 : 1));
                resultado.push({ fatura: f, pago, grupos });
            }
            return resultado;
        };

        // AÇÃO: PRÉVIA DA REVERSÃO (só leitura): o que será cancelado e o que volta como crédito
        if (action === "preview_revert_sale") {
            const { order_id } = body;
            if (!order_id) return res.status(400).json({ error: "ID do pedido é obrigatório." });
            const analise = await analisarPagamentosDaVenda(Number(order_id));
            if (!analise) return res.status(404).json({ error: "Pedido de venda não encontrado." });
            const pagamentos = [];
            let credito = 0;
            analise.forEach(a => a.grupos.forEach(g => {
                if (g.tipo === "pagamento") pagamentos.push({ nome: g.pay.name, valor: g.valor, conta: Array.isArray(g.pay.journal_id) ? g.pay.journal_id[1] : "" });
                else credito = r2(credito + g.valor);
            }));
            return res.status(200).json({ pagamentos, credito });
        }

        // AÇÃO: REVERTER VENDA PAGA — cancela TODOS os pagamentos em conta e devolve ao cliente, como crédito, o que foi pago com crédito
        if (action === "revert_sale_payments") {
            const { order_id } = body;
            if (!order_id) return res.status(400).json({ error: "ID do pedido é obrigatório." });
            const oid = Number(order_id);
            const analise = await analisarPagamentosDaVenda(oid);
            if (!analise) return res.status(404).json({ error: "Pedido de venda não encontrado." });
            if (analise.length === 0) return res.status(200).json({ success: true, cancelados: [], credito_devolvido: 0, nada: true });

            const cancelados = [];
            let creditoDevolvido = 0;
            let falha = null;
            for (const a of analise) {
                const gruposPagamento = a.grupos.filter(g => g.tipo === "pagamento");
                const gruposCredito = a.grupos.filter(g => g.tipo !== "pagamento");

                // 1) pagamentos em conta: cancela cada um
                for (const g of gruposPagamento) {
                    try {
                        const outras = (g.pay.reconciled_invoice_ids || []).filter(id => id !== a.fatura.id);
                        if (outras.length > 0) throw new Error("ele também está ligado a outra fatura. Reverta pelo Odoo.");
                        if (g.pay.state !== "draft") await execute("account.payment", "action_draft", [[g.pay.id]]);
                        await execute("account.payment", "action_cancel", [[g.pay.id]]);
                        cancelados.push({ nome: g.pay.name, valor: g.valor, conta: Array.isArray(g.pay.journal_id) ? g.pay.journal_id[1] : "" });
                    } catch (e) {
                        falha = "Não foi possível cancelar o pagamento " + (g.pay.name || "") + ": " + e.message;
                        break;
                    }
                }
                if (falha) break;

                // 2) crédito do cliente: com os pagamentos em conta já cancelados, só restam as conciliações de crédito.
                // O método do próprio Odoo (remove_move_reconcile) as desfaz de uma vez e cuida das contas auxiliares,
                // e o valor volta a ser crédito do cliente.
                if (gruposCredito.length > 0) {
                    try {
                        const linhasF = (await execute("account.move.line", "search_read", [[["move_id", "=", a.fatura.id], LINHA_RECEBER]], { fields: ["id"] })) || [];
                        await execute("account.move.line", "remove_move_reconcile", [linhasF.map(l => l.id)]);
                        creditoDevolvido = r2(creditoDevolvido + gruposCredito.reduce((t, g) => t + g.valor, 0));
                    } catch (e) {
                        falha = "Não foi possível devolver o crédito ao cliente: " + e.message;
                        break;
                    }
                }

                // fatura sem nenhum pagamento volta a ser provisória (acompanha as edições da venda)
                try {
                    const fx = await execute("account.move", "read", [[a.fatura.id]], { fields: ["amount_total", "amount_residual", "state"] });
                    if (fx && fx[0] && fx[0].state === "posted" && r2(fx[0].amount_residual) >= r2(fx[0].amount_total) - 0.004) {
                        await execute("account.move", "button_draft", [[a.fatura.id]]);
                    }
                } catch (e) { /* melhor esforço: fica lançada e sem pagamento */ }
            }
            // destrava pedido e entrega (só ficam travados quando pagos)
            try { await sincronizarBloqueioDoPedido(oid); } catch (e) { /* melhor esforço */ }

            if (falha) {
                return res.status(500).json({ error: falha, cancelados, credito_devolvido: creditoDevolvido, parcial: cancelados.length > 0 || creditoDevolvido > 0 });
            }
            return res.status(200).json({ success: true, cancelados, credito_devolvido: creditoDevolvido });
        }

        // Confere o estoque do local ANTES de lançar: nada de vender mais do que existe.
        // `necessario`: { idProduto: quantidade que ainda vai sair do estoque }. Devolve os produtos que faltam (com nome).
        const conferirEstoque = async (warehouseId, necessario) => {
            const ids = Object.keys(necessario || {}).map(Number);
            if (ids.length === 0) return [];
            const whs = await lookups.warehouses();
            const wh = (whs || []).find(w => w.id === Number(warehouseId));
            const rootLoc = wh && Array.isArray(wh.lot_stock_id) ? wh.lot_stock_id[0] : null;
            if (!rootLoc) return [];       // sem local de estoque definido não há o que conferir
            const saldo = await saldoPorProduto(rootLoc, ids);
            const falta = faltaDeEstoque(necessario, saldo);
            if (falta.length === 0) return [];
            const prods = await execute("product.product", "read", [falta.map(f => f.product_id)], { fields: ["display_name"] }).catch(() => []);
            const nomes = {};
            (prods || []).forEach(p => { nomes[p.id] = p.display_name; });
            return falta.map(f => ({ ...f, nome: nomes[f.product_id] || ("Produto " + f.product_id) }));
        };
        const textoFaltaEstoque = falta =>
            "Estoque insuficiente: " + falta.map(f => f.nome + " (pedido " + f.pedido + ", disponível " + f.disponivel + ")").join("; ") + ".";

        // Compara pedido x entrega x fatura (usado para retomar uma edição que ficou pela metade)
        const divergencias = async (oid) => {
            const ls = await execute("sale.order.line", "search_read", [[["order_id", "=", oid], ["display_type", "=", false]]], {
                fields: ["product_uom_qty", "qty_delivered", "qty_invoiced"]
            });
            const difere = (a, b) => Math.abs(Number(a) - Number(b)) > 1e-6;
            return {
                entrega: (ls || []).some(l => difere(l.qty_delivered, l.product_uom_qty)),
                fatura: (ls || []).some(l => difere(l.qty_invoiced, l.product_uom_qty))
            };
        };

        // AÇÃO: CRIAR/ATUALIZAR ORÇAMENTO (E, OPCIONALMENTE, CONFIRMAR + BAIXAR ESTOQUE + FATURAR)
        // Pode ser repetida com segurança: se o envio anterior parou no meio (internet caiu, tempo esgotado),
        // o reenvio com a mesma chave NÃO duplica a venda e CONCLUI o que faltou (entrega e fatura).
        if (action === "save_sale_order") {
            const { order_id, partner_id, warehouse_id, lines, confirm, removed_line_ids, date_order, invoice_date, due_date, client_key } = body;
            // ISO (UTC) -> formato do Odoo "YYYY-MM-DD HH:MM:SS"
            let dateOrder = null;
            if (date_order) { const dt = new Date(date_order); if (!isNaN(dt)) dateOrder = dt.toISOString().slice(0, 19).replace("T", " "); }

            if (!partner_id) return res.status(400).json({ error: "Selecione um cliente para o pedido." });
            const validLines = (lines || []).filter(l => l.product_id);
            if (validLines.length === 0) return res.status(400).json({ error: "Adicione ao menos um produto ao pedido." });
            const linhaRuim = validLines.find(l => !(Number(l.qty) > 0) || !(Number(l.price) >= 0) || !Number.isFinite(Number(l.price)));
            if (linhaRuim) return res.status(400).json({ error: "Confira as linhas: a quantidade deve ser maior que zero e o preço não pode ser negativo." });
            validLines.forEach(l => { if (l.discount !== undefined) l.discount = Math.min(100, Math.max(0, Number(l.discount) || 0)); });

            let orderId = order_id ? Number(order_id) : null;
            let estadoAtual = null;

            // Chave de "lançamento único": se a internet cair e o app repetir o envio, o pedido NÃO é duplicado.
            const chave = (!orderId && typeof client_key === "string" && /^[\w-]{8,64}$/.test(client_key)) ? "app:" + client_key : null;
            let jaExistia = false;
            if (chave) {
                const ex = await execute("sale.order", "search_read", [[["origin", "=", chave]]], { fields: ["id", "state"], limit: 1 });
                if (ex && ex[0]) { orderId = ex[0].id; jaExistia = true; estadoAtual = ex[0].state; }
            } else if (orderId) {
                const st = await execute("sale.order", "read", [[orderId]], { fields: ["state"] });
                if (!st || !st[0]) return res.status(404).json({ error: "Pedido de venda não encontrado." });
                estadoAtual = st[0].state;
            }
            if (estadoAtual === "cancel") return res.status(400).json({ error: "Este pedido foi cancelado. Reabra-o como orçamento para alterar." });
            const jaConfirmado = ["sale", "done"].includes(estadoAtual);
            if (orderId && !jaExistia && !["draft", "sent"].includes(estadoAtual)) {
                return res.status(400).json({ error: "Só orçamentos podem ser alterados por aqui. Para uma venda lançada, use a edição da venda." });
            }

            // reenvio de uma venda que já está confirmada e não foi pedido para confirmar: nada a fazer
            if (jaConfirmado && !confirm) return res.status(200).json({ success: true, id: orderId, confirmed: true, warnings: [], repeated: true });

            // estoque: o que vai ser lançado precisa existir no local (rascunho pode, não baixa estoque)
            if (confirm && !jaConfirmado && warehouse_id) {
                const necessario = {};
                validLines.forEach(l => { necessario[Number(l.product_id)] = (necessario[Number(l.product_id)] || 0) + Number(l.qty); });
                const falta = await conferirEstoque(warehouse_id, necessario);
                if (falta.length > 0) return res.status(400).json({ error: textoFaltaEstoque(falta) });
            }

            const headerData = {
                partner_id: Number(partner_id),
                // "Condição de pagamento" fica sempre em branco; o que vale é o vencimento
                payment_term_id: false,
                // vencimento guardado em "Expiração" (validity_date) até virar a data de vencimento da fatura
                validity_date: due_date || false
            };
            if (warehouse_id) headerData.warehouse_id = Number(warehouse_id);
            if (dateOrder) headerData.date_order = dateOrder;

            const linhaOdoo = l => ({
                product_id: Number(l.product_id),
                product_uom_qty: Number(l.qty),
                price_unit: Number(l.price),
                discount: Number(l.discount) || 0
            });

            if (jaConfirmado) {
                // o envio anterior já confirmou o pedido: não mexe nas linhas, só conclui entrega e fatura abaixo
            } else if (jaExistia) {
                // rascunho criado por um envio anterior que não terminou: aplica de novo o que está na tela
                // (troca todas as linhas, para não duplicar nem manter itens antigos) e segue para a confirmação
                headerData.order_line = [[5, 0, 0], ...validLines.map(l => [0, 0, linhaOdoo(l)])];
                await execute("sale.order", "write", [[orderId], headerData]);
            } else if (!orderId) {
                headerData.order_line = validLines.map(l => [0, 0, linhaOdoo(l)]);
                if (chave) headerData.origin = chave;
                orderId = await execute("sale.order", "create", [headerData]);
            } else {
                // Uma única escrita no pedido (remove + atualiza + cria linhas), como o próprio Odoo faz
                const lineCommands = [];
                for (const rid of (removed_line_ids || [])) {
                    lineCommands.push([2, Number(rid), 0]);
                }
                for (const l of validLines) {
                    const lineVals = {
                        product_id: Number(l.product_id),
                        product_uom_qty: Number(l.qty),
                        price_unit: Number(l.price)
                    };
                    if (l.discount !== undefined) lineVals.discount = Number(l.discount) || 0;
                    lineCommands.push(l.id ? [1, Number(l.id), lineVals] : [0, 0, lineVals]);
                }
                if (lineCommands.length > 0) headerData.order_line = lineCommands;

                await execute("sale.order", "write", [[orderId], headerData]);
            }

            let warnings = [];
            let invoiceId = null;
            let invoicePosted = false;

            if (confirm) {
                if (!jaConfirmado) {
                    try {
                        await execute("sale.order", "action_confirm", [[orderId]]);
                    } catch (e) {
                        return res.status(200).json({ success: true, id: orderId, confirmed: false, warnings: ["Pedido salvo, mas não foi possível confirmá-lo: " + e.message] });
                    }

                    // O Odoo regrava a data do pedido com "agora" ao confirmar; restaura a data escolhida
                    if (dateOrder) {
                        try { await execute("sale.order", "write", [[orderId], { date_order: dateOrder }]); }
                        catch (e) { warnings.push("Não foi possível manter a data escolhida no pedido: " + e.message); }
                    }
                }

                // Conclui a(s) entrega(s) pendentes, com a quantidade feita = quantidade pedida, para baixar de fato o
                // estoque do local/armazém escolhido. Cada entrega só conta como pronta se o Odoo a deixar "concluída".
                try {
                    const pickings = await execute("stock.picking", "search_read", [[["sale_id", "=", orderId], ["state", "not in", ["done", "cancel"]]]], {
                        fields: ["id"]
                    });
                    const pickIds = (pickings || []).map(p => p.id);
                    if (pickIds.length > 0) {
                        try { await completarQuantidades(pickIds); } catch (e) { /* a validação abaixo acusa se faltar */ }
                        for (const pid of pickIds) {
                            try {
                                const v = await validarPickingComAssistentes(pid);
                                if (!v.ok) warnings.push("Pedido confirmado, mas a entrega " + v.name + " não ficou concluída. Finalize-a no Odoo para baixar o estoque.");
                            } catch (e) {
                                warnings.push("Pedido confirmado, mas a entrega #" + pid + " não pôde ser concluída automaticamente (" + e.message + "). Finalize-a no Odoo para baixar o estoque.");
                            }
                        }
                    }
                } catch (e) {
                    warnings.push("Não foi possível localizar a entrega gerada pelo pedido.");
                }

                // Pedido e entrega ficam DESTRAVADOS (só travam quando a fatura for paga)
                try {
                    await Promise.all([definirBloqueioEntregas(orderId, false), definirBloqueioPedido(orderId, false)]);
                } catch (e) {
                    warnings.push("Pedido confirmado, mas não foi possível deixá-lo destravado para edição: " + e.message);
                }

                // Gera a fatura em rascunho (equivalente a escolher "Fatura normal" e "Criar Rascunho" no Odoo).
                // A fatura NÃO é lançada automaticamente - isso é feito depois, na tela de revisão da fatura.
                try {
                    let faturaExistente = null;
                    if (jaConfirmado || jaExistia) {
                        // reenvio: se a fatura já foi gerada, reaproveita em vez de tentar gerar outra
                        const pf = await execute("sale.order", "read", [[orderId]], { fields: ["invoice_ids"] });
                        const idsF = (pf && pf[0] && pf[0].invoice_ids) || [];
                        if (idsF.length > 0) {
                            const ativas = await execute("account.move", "search_read", [[["id", "in", idsF], ["state", "!=", "cancel"]]], { fields: ["id"], limit: 1 });
                            if (ativas && ativas[0]) faturaExistente = ativas[0].id;
                        }
                    }
                    const invoiceIds = faturaExistente ? [faturaExistente] : await criarFaturasDoPedido(orderId);
                    if (invoiceIds && invoiceIds.length > 0) {
                        invoiceId = invoiceIds[0];
                        await applyForcedAccountToInvoice(invoiceId);

                        // A data da fatura é sempre o dia da operação (hoje), independente da data da venda
                        const hoje = /^\d{4}-\d{2}-\d{2}$/.test(String(invoice_date || "")) ? invoice_date : hojeLocal();
                        // A fatura fica PROVISÓRIA (editável) até o pagamento; ela é lançada na hora de pagar
                        try {
                            const dadosFatura = { invoice_date: hoje };
                            if (due_date) dadosFatura.invoice_date_due = due_date;
                            await execute("account.move", "write", [[invoiceId], dadosFatura]);
                        } catch (e) {
                            warnings.push("Fatura criada, mas não foi possível definir a data e o vencimento: " + e.message);
                        }
                    } else {
                        warnings.push("Pedido confirmado, mas ainda não havia nada a faturar. Verifique a entrega no Odoo e use \"Gerar Fatura\" no pedido.");
                    }
                } catch (e) {
                    warnings.push("Pedido confirmado, mas não foi possível gerar a fatura automaticamente: " + e.message);
                }
            }

            return res.status(200).json({ success: true, id: orderId, invoice_id: invoiceId, invoice_posted: invoicePosted, confirmed: !!confirm, warnings, repeated: jaExistia });
        }

        // AÇÃO: ALTERAR UMA VENDA JÁ LANÇADA (mudar quantidade, adicionar e excluir produtos)
        // Não existe "tudo ou nada" entre várias chamadas ao Odoo, então a ação foi feita para ser RETOMÁVEL:
        // as etapas de ajuste da entrega e da fatura sempre comparam com o pedido e corrigem o que difere. Se algo
        // falhar no meio (internet, tempo esgotado), basta tocar em "Salvar alterações" de novo: mesmo sem nada
        // novo na tela, o servidor percebe que entrega/fatura ainda não acompanham o pedido e conclui o serviço.
        if (action === "update_sale_lines") {
            const { order_id, lines, removed_line_ids, date_order, due_date, invoice_date } = body;
            if (!order_id) return res.status(400).json({ error: "ID da venda é obrigatório." });
            const oid = Number(order_id);
            const inicio = Date.now();
            const restante = () => PRAZO_MS - (Date.now() - inicio);

            // pedido e linhas numa rodada só
            const [pedidos, atuais] = await Promise.all([
                execute("sale.order", "read", [[oid]], { fields: ["state", "invoice_ids", "validity_date", "warehouse_id"] }),
                execute("sale.order.line", "search_read", [[["order_id", "=", oid], ["display_type", "=", false]]], { fields: ["id", "product_uom_qty", "discount"] })
            ]);
            const ped = pedidos && pedidos[0];
            if (!ped || !["sale", "done"].includes(ped.state)) {
                return res.status(400).json({ error: "Só é possível alterar vendas já lançadas." });
            }

            // Fatura paga = venda travada (só edita depois de desfazer o pagamento)
            const idsFat = ped.invoice_ids || [];
            if (idsFat.length > 0) {
                const pagas = await execute("account.move", "search_read", [[["id", "in", idsFat], ["state", "!=", "cancel"], ["payment_state", "in", ["paid", "in_payment", "partial"]]]], { fields: ["name"] });
                if (pagas && pagas.length > 0) {
                    return res.status(400).json({ error: "A fatura " + pagas.map(f => f.name).join(", ") + " já está paga: a venda está travada. Desfaça o pagamento para editar." });
                }
            }

            const validas = (lines || []).filter(l => l.product_id && Number(l.qty) > 0);
            if (validas.length === 0) {
                return res.status(400).json({ error: "A venda precisa ter ao menos um produto. Para desfazê-la, cancele a venda." });
            }

            // linhas atuais: só escreve quantidade nas linhas que realmente mudaram
            const qtdAtual = {};
            const descAtual = {};
            (atuais || []).forEach(l => { qtdAtual[l.id] = l.product_uom_qty; descAtual[l.id] = Number(l.discount) || 0; });

            const cmds = [];
            const reducoes = [];
            const necessario = {};      // quanto A MAIS precisa sair do estoque (aumentos e produtos novos)
            const somar = (pid, q) => { necessario[Number(pid)] = (necessario[Number(pid)] || 0) + q; };
            for (const rid of (removed_line_ids || [])) cmds.push([2, Number(rid), 0]);
            for (const l of validas) {
                if (l.id) {
                    const nova = Number(l.qty);
                    const novoDesc = Math.min(100, Math.max(0, Number(l.discount) || 0));
                    const vals = {};
                    if (qtdAtual[Number(l.id)] !== nova) {
                        vals.product_uom_qty = nova;
                        if (nova < qtdAtual[Number(l.id)]) reducoes.push({ lineId: Number(l.id), qty: nova });
                        else somar(l.product_id, nova - Number(qtdAtual[Number(l.id)] || 0));
                    }
                    // tolerância de 1 centésimo: evita "mudança" falsa por arredondamento (que refaria fatura e entrega à toa)
                    if (Math.abs((descAtual[Number(l.id)] || 0) - novoDesc) > 0.01) vals.discount = novoDesc;
                    if (Object.keys(vals).length > 0) cmds.push([1, Number(l.id), vals]);
                } else {
                    somar(l.product_id, Number(l.qty));
                    cmds.push([0, 0, {
                        product_id: Number(l.product_id),
                        product_uom_qty: Number(l.qty),
                        price_unit: Number(l.price),
                        discount: Number(l.discount) || 0
                    }]);
                }
            }

            // nada de aumentar a venda além do estoque do local
            if (Object.keys(necessario).length > 0 && Array.isArray(ped.warehouse_id)) {
                const falta = await conferirEstoque(ped.warehouse_id[0], necessario);
                if (falta.length > 0) return res.status(400).json({ error: textoFaltaEstoque(falta) });
            }

            // data da venda (só vem quando foi alterada) e vencimento
            let dateOrder = null;
            if (date_order) { const dt = new Date(date_order); if (!isNaN(dt)) dateOrder = dt.toISOString().slice(0, 19).replace("T", " "); }
            const venc = (typeof due_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(due_date)) ? due_date : null;
            const hoje = /^\d{4}-\d{2}-\d{2}$/.test(String(invoice_date || "")) ? invoice_date : hojeLocal();

            const vencMudou = (venc || false) !== (ped.validity_date || false);
            let reparo = false;
            if (cmds.length === 0 && !dateOrder && !vencMudou) {
                // Nada mudou na tela. Se uma tentativa anterior ficou pela metade (entrega/fatura diferentes do pedido), conclui agora.
                const dif = await divergencias(oid);
                if (!dif.entrega && !dif.fatura) return res.status(200).json({ success: true, warnings: [] });
                reparo = true;
            }

            // destrava o pedido e a entrega para poder editar
            try {
                await Promise.all([definirBloqueioPedido(oid, false), definirBloqueioEntregas(oid, false)]);
            } catch (e) { /* tenta editar mesmo assim */ }

            const warnings = [];
            const adiar = etapa => warnings.push("O tempo acabou antes de " + etapa + ". Toque em \"Salvar alterações\" de novo para concluir.");

            if (!reparo) {
                // reduz a entrega antes (o Odoo não deixa o pedido ficar abaixo do já entregue)
                try {
                    (await reduzirEntregaAntesDoPedido(oid, reducoes, (removed_line_ids || []).map(Number))).forEach(a => warnings.push(a));
                } catch (e) {
                    warnings.push("Não foi possível reduzir a entrega antes de alterar a venda: " + e.message);
                }

                try {
                    // "skip_procurement" pede ao Odoo para não criar entrega nova a cada ajuste
                    const vals = { validity_date: venc || false };
                    if (dateOrder) vals.date_order = dateOrder;
                    if (cmds.length > 0) vals.order_line = cmds;
                    await execute("sale.order", "write", [[oid], vals], { context: { skip_procurement: true } });
                } catch (e) {
                    try { await sincronizarBloqueioDoPedido(oid); } catch (e2) { /* ok */ }
                    return res.status(400).json({ error: "Não foi possível alterar a venda: " + e.message });
                }
            }

            if (cmds.length > 0 || reparo) {
                // Mantém uma única entrega, igual ao pedido (produto e quantidade)
                if (restante() < 15000) adiar("ajustar a entrega e a fatura");
                else {
                    try {
                        (await sincronizarEntregaComPedido(oid)).forEach(a => warnings.push(a));
                    } catch (e) {
                        warnings.push("Venda alterada, mas não foi possível ajustar a entrega: " + e.message);
                    }

                    // Espelha a fatura provisória com o pedido (produto, quantidade e preço)
                    if (restante() < 12000) adiar("ajustar a fatura");
                    else {
                        try {
                            (await espelharFaturaComPedido(oid, venc, hoje)).forEach(a => warnings.push(a));
                        } catch (e) {
                            warnings.push("Venda alterada, mas não foi possível ajustar a fatura: " + e.message);
                        }
                    }
                }
            }

            // O vencimento vai para a(s) fatura(s) do pedido que não estejam canceladas
            if (venc && restante() > 8000) {
                try {
                    const ped2 = await execute("sale.order", "read", [[oid]], { fields: ["invoice_ids"] });
                    const ids = (ped2 && ped2[0] && ped2[0].invoice_ids) || [];
                    if (ids.length > 0) {
                        const faturas = await execute("account.move", "search_read", [[["id", "in", ids], ["state", "!=", "cancel"]]], { fields: ["id", "name"] });
                        for (const f of (faturas || [])) {
                            try { await aplicarVencimentoNaFatura(f.id, venc); }
                            catch (e) { warnings.push("Não foi possível alterar o vencimento da fatura " + f.name + ": " + e.message); }
                        }
                    }
                } catch (e) {
                    warnings.push("Não foi possível atualizar o vencimento da fatura: " + e.message);
                }
            }

            // pedido e entrega voltam a travar só se a fatura já estiver paga
            if (restante() > 5000) {
                try { await sincronizarBloqueioDoPedido(oid); } catch (e) { /* ok */ }
            }

            // avisa o que ainda não acompanha o pedido
            if (restante() > 4000) {
                try {
                    const depois = await execute("sale.order.line", "search_read", [[["order_id", "=", oid], ["display_type", "=", false]]], { fields: ["product_id", "product_uom_qty", "qty_delivered", "qty_invoiced"] });
                    const nome = l => (Array.isArray(l.product_id) ? l.product_id[1] : "");
                    const difEntrega = (depois || []).filter(l => Number(l.qty_delivered) !== Number(l.product_uom_qty));
                    const difFatura = (depois || []).filter(l => Number(l.qty_invoiced) !== Number(l.product_uom_qty));
                    if (difEntrega.length > 0) warnings.push("A entrega ainda não acompanha: " + difEntrega.map(l => nome(l) + " (pedido " + l.product_uom_qty + ", entregue " + l.qty_delivered + ")").join("; ") + ". Toque em \"Salvar alterações\" de novo para tentar concluir.");
                    if (difFatura.length > 0) warnings.push("A fatura ainda não acompanha: " + difFatura.map(l => nome(l) + " (pedido " + l.product_uom_qty + ", faturado " + l.qty_invoiced + ")").join("; ") + ". Toque em \"Salvar alterações\" de novo para tentar concluir.");
                } catch (e) { /* aviso é só informativo */ }
            }

            return res.status(200).json({ success: true, warnings });
        }

        // AÇÃO: BUSCAR PARCEIROS
        if (action === "search_partners") {
            const query = body.query || "";
            // exact: nome idêntico (sem diferenciar maiúsculas/minúsculas) — usado para achar o cliente padrão "CLIENTE"
            const domain = query ? [["name", body.exact ? "=ilike" : "ilike", query]] : [];
            const result = await execute("res.partner", "search_read", [domain], {
                fields: ["id", "name", "email", "phone"],
                limit: body.exact ? 5 : 20
            });
            return res.status(200).json({ partners: result || [] });
        }

        // AÇÃO: CRIAR PARCEIRO
        if (action === "create_partner") {
            const { name, email, phone } = body;
            if (!name || !name.trim()) {
                return res.status(400).json({ error: "Nome do parceiro é obrigatório." });
            }

            // padrão do sistema: nome do cliente sempre em MAIÚSCULAS
            const nomeCliente = name.trim().toUpperCase();
            // evita cliente duplicado (duplo toque, internet lenta): se já existe um com o mesmo nome, reaproveita
            const jaTem = await execute("res.partner", "search_read", [[["name", "=ilike", nomeCliente]]], { fields: ["id", "name"], limit: 1 });
            if (jaTem && jaTem[0]) return res.status(200).json({ success: true, id: jaTem[0].id, name: jaTem[0].name, existing: true });
            const newPartnerId = await execute("res.partner", "create", [{
                name: nomeCliente,
                email: email ? email.trim() : false,
                phone: phone ? phone.trim() : false,
                customer_rank: 1
            }]);

            return res.status(200).json({ success: true, id: newPartnerId, name: nomeCliente });
        }

        // AÇÃO: BUSCAR ESTOQUE
        if (action === "get_stock") {
            const query = body.query || "";
            // Somente "Locais internos" (igual ao filtro do Odoo); local opcional (inclui sublocais)
            const locationId = Number(body.location_id) || 0;
            // somente produtos com "Vendas" marcado e tipo "Mercadorias"
            const domain = [["quantity", ">", 0], ["location_id.usage", "=", "internal"], ["product_id.sale_ok", "=", true], ["product_id.type", "=", "consu"]];
            if (locationId) domain.push(["location_id", "child_of", locationId]);
            if (query) domain.push(["product_id.name", "ilike", query]);

            // O Odoo soma o saldo por produto no servidor (sem teto de linhas). Antes lia no máximo 300 linhas de
            // estoque e um local grande aparecia com saldos incompletos, sem aviso.
            let result;
            try {
                const grupos = await execute("stock.quant", "read_group", [domain], { fields: ["quantity:sum"], groupby: ["product_id"], lazy: false });
                if (!Array.isArray(grupos)) throw new Error("read_group sem resultado");
                result = grupos
                    .filter(g => Array.isArray(g.product_id))
                    .map(g => ({ product_id: g.product_id, quantity: Number(g.quantity) || 0 }));
            } catch (e) {
                // reserva: lê as linhas de estoque (sem limite) e o app soma por produto
                result = await execute("stock.quant", "search_read", [domain], { fields: ["id", "location_id", "product_id", "quantity"] });
            }
            return res.status(200).json({ result: result || [] });
        }

        // AÇÃO: PRODUTOS QUE PODEM SER ADICIONADOS AO ESTOQUE
        // (mercadorias com "Vendas" marcado que ainda NÃO têm saldo no local; quem já tem saldo fica de fora para não duplicar)
        if (action === "get_addable_products") {
            const locationId = Number(body.location_id) || 0;
            if (!locationId) return res.status(400).json({ error: "Local é obrigatório." });
            const query = String(body.query || "").trim();

            const have = Object.keys(await saldoPorProduto(locationId)).map(Number);

            const domain = [...PRODUCT_BASE_DOMAIN];
            if (have.length) domain.push(["id", "not in", have]);
            if (query) domain.push(["name", "ilike", query]);
            const products = await execute("product.product", "search_read", [domain], { fields: ["id", "display_name"], limit: 300 });
            const list = (products || []).sort((a, b) => (a.display_name || "").localeCompare(b.display_name || "", "pt-BR"));
            return res.status(200).json({ products: list });
        }

        // AÇÃO: AJUSTAR A QUANTIDADE EM ESTOQUE DE UM PRODUTO NO LOCAL (inventário)
        if (action === "adjust_stock") {
            const productId = Number(body.product_id) || 0;
            const locationId = Number(body.location_id) || 0;
            const newQty = Number(body.quantity);
            if (!productId || !locationId) return res.status(400).json({ error: "Produto e local são obrigatórios." });
            if (!isFinite(newQty) || newQty < 0) return res.status(400).json({ error: "Informe uma quantidade válida (0 ou mais)." });

            // produto que não rastreia inventário não pode ter saldo no Odoo
            try {
                const p = await execute("product.product", "read", [[productId]], { fields: ["is_storable"] });
                if (p && p[0] && p[0].is_storable === false) {
                    return res.status(400).json({ error: "Este produto não rastreia inventário. No Odoo, ative \"Rastrear inventário\" nele e tente de novo." });
                }
            } catch (e) { /* versão do Odoo sem esse campo: segue */ }

            const ctx = { inventory_mode: true, inventory_name: "Ajuste pelo app mobile" };
            const somaAtual = async () => {
                const qs = await execute("stock.quant", "search_read", [[
                    ["product_id", "=", productId],
                    ["location_id", "child_of", locationId],
                    ["location_id.usage", "=", "internal"]
                ]], { fields: ["quantity"] });
                return (qs || []).reduce((s, q) => s + q.quantity, 0);
            };

            const atual = await somaAtual();
            const delta = newQty - atual;
            if (Math.abs(delta) < 1e-9) return res.status(200).json({ success: true, quantity: atual });

            // o ajuste é feito no próprio local; o saldo que está em sublocais é somado ao total mostrado na tela
            const exact = await execute("stock.quant", "search_read", [[
                ["product_id", "=", productId], ["location_id", "=", locationId]
            ]], { fields: ["id", "quantity"], limit: 1 });
            const base = exact && exact[0] ? exact[0].quantity : 0;
            const target = base + delta;
            if (target < -1e-9) {
                return res.status(400).json({ error: "Parte desse estoque está em sublocais e não dá para reduzir até essa quantidade por aqui. Ajuste direto no Odoo." });
            }

            let qid;
            if (exact && exact[0]) {
                qid = exact[0].id;
                await execute("stock.quant", "write", [[qid], { inventory_quantity: target }], { context: ctx });
            } else {
                qid = await execute("stock.quant", "create", [{ product_id: productId, location_id: locationId, inventory_quantity: target }], { context: ctx });
            }
            await execute("stock.quant", "action_apply_inventory", [[qid]], { context: ctx });

            const depois = await somaAtual();
            if (Math.abs(depois - newQty) > 1e-6) {
                return res.status(500).json({ error: "O Odoo não aplicou o ajuste (o produto pode usar lote/série). Confira no Odoo." });
            }
            return res.status(200).json({ success: true, quantity: depois });
        }

        // AÇÃO: BUSCAR PEDIDOS DE VENDAS
        if (action === "get_sales") {
            const query = body.query || "";
            const domain = [];
            if (query) {
                domain.push('|', ['name', 'ilike', query], ['partner_id.name', 'ilike', query]);
            }
            // Filtros: local/armazém e status (Orçamento = draft+sent, Confirmado = sale+done, Cancelado = cancel)
            if (body.warehouse_id) {
                domain.push(['warehouse_id', '=', parseInt(body.warehouse_id, 10)]);
            }
            // "sale" (Confirmadas = lançadas e NÃO pagas) e "paid" (Pago) partem das vendas lançadas e se separam
            // pelo status de pagamento das faturas
            const statusGroups = { draft: ['draft', 'sent'], sale: ['sale', 'done'], paid: ['sale', 'done'], cancel: ['cancel'] };
            const filtroPagamento = (body.order_status === 'sale' || body.order_status === 'paid') ? body.order_status : null;
            if (body.order_status && statusGroups[body.order_status]) {
                domain.push(['state', 'in', statusGroups[body.order_status]]);
            }
            // "Últimas": nunca mostra vendas canceladas (elas só aparecem no filtro próprio)
            if (body.exclude_cancel) {
                domain.push(['state', '!=', 'cancel']);
            }

            const limiteTela = Math.min(Math.max(parseInt(body.limit, 10) || 100, 1), 1000);
            const offsetTela = Math.max(parseInt(body.offset, 10) || 0, 0);
            const camposPedido = ["id", "name", "partner_id", "amount_total", "state", "invoice_status", "invoice_ids", "warehouse_id", "date_order"];

            // Traz os pedidos de uma "página" já com o resumo de pagamento das faturas (uma consulta em lote)
            const buscarPagina = async (dom, limite, offset) => {
                const orders = await execute("sale.order", "search_read", [dom], {
                    fields: camposPedido,
                    // mais recente primeiro (pela data da venda)
                    order: "date_order desc, id desc",
                    limit: limite,
                    offset
                });
                const allInvoiceIds = [];
                (orders || []).forEach(o => (o.invoice_ids || []).forEach(id => allInvoiceIds.push(id)));
                const invoiceMap = {};
                if (allInvoiceIds.length > 0) {
                    const invoices = await execute("account.move", "search_read", [[["id", "in", allInvoiceIds]]], {
                        fields: ["id", "payment_state", "state"]
                    }).catch(() => []);
                    (invoices || []).forEach(inv => { invoiceMap[inv.id] = inv; });
                }
                const lista = (orders || []).map(o => ({
                    ...o,
                    payment_summary: resumoPagamento((o.invoice_ids || []).map(id => invoiceMap[id]).filter(Boolean))
                }));
                return { lista, total: (orders || []).length };
            };

            let result;
            let temMais = false;
            // pede 1 a mais só para saber se existe uma próxima página
            const paginaSimples = async (dom) => {
                const p = await buscarPagina(dom, limiteTela + 1, offsetTela);
                return { temMais: p.lista.length > limiteTela, result: p.lista.slice(0, limiteTela) };
            };
            if (!filtroPagamento) {
                ({ temMais, result } = await paginaSimples(domain));
            } else {
                try {
                    // o próprio Odoo filtra Pago / Confirmadas pelo status das faturas: uma consulta, sem varrer páginas
                    ({ temMais, result } = await paginaSimples(domain.concat(dominioPagamento(filtroPagamento))));
                } catch (e) {
                    // Odoo sem suporte ao filtro por fatura no pedido: método antigo (mais lento), lendo em páginas de 100
                    const tamanho = 100;
                    const filtra = o => filtroPagamento === 'paid' ? o.payment_summary === 'pago' : o.payment_summary !== 'pago';
                    result = [];
                    let off = 0, pulados = 0, esgotou = false;
                    for (let i = 0; i < 12 && result.length <= limiteTela && !esgotou; i++) {
                        const p = await buscarPagina(domain, tamanho, off);
                        off += tamanho;
                        if (p.total < tamanho) esgotou = true;
                        for (const o of p.lista) {
                            if (!filtra(o)) continue;
                            if (pulados < offsetTela) { pulados++; continue; }
                            result.push(o);
                        }
                    }
                    temMais = result.length > limiteTela || !esgotou;
                    result = result.slice(0, limiteTela);
                }
            }

            return res.status(200).json({ result, has_more: temMais });
        }

        // AÇÃO: RESUMO DO DIA (valor vendido e quantidade de vendas confirmadas no intervalo, do local informado)
        if (action === "get_sales_summary") {
            const toOdoo = (iso) => {
                const d = new Date(iso);
                return isNaN(d) ? null : d.toISOString().replace("T", " ").slice(0, 19);
            };
            const de = toOdoo(body.date_from), ate = toOdoo(body.date_to);
            if (!de || !ate) return res.status(400).json({ error: "Período inválido." });
            const domain = [["state", "in", ["sale", "done"]], ["date_order", ">=", de], ["date_order", "<", ate]];
            if (body.warehouse_id) domain.push(["warehouse_id", "=", parseInt(body.warehouse_id, 10)]);
            // O próprio Odoo soma o valor (sem trazer os pedidos um a um); se o read_group falhar, soma aqui
            try {
                const [grupos, count] = await Promise.all([
                    execute("sale.order", "read_group", [domain], { fields: ["amount_total:sum"], groupby: [], lazy: false }),
                    execute("sale.order", "search_count", [domain])
                ]);
                const g = Array.isArray(grupos) ? grupos[0] : null;
                if (g && typeof g.amount_total === "number") {
                    return res.status(200).json({ total: Math.round(g.amount_total * 100) / 100, count });
                }
                if (count === 0) return res.status(200).json({ total: 0, count: 0 });
            } catch (e) { /* cai no cálculo manual abaixo */ }
            const pedidos = await execute("sale.order", "search_read", [domain], { fields: ["amount_total"] });
            const total = (pedidos || []).reduce((s, o) => s + (Number(o.amount_total) || 0), 0);
            return res.status(200).json({ total: Math.round(total * 100) / 100, count: (pedidos || []).length });
        }

        // AÇÃO: DETALHES DE UM PEDIDO DE VENDA
        if (action === "get_sale_detail") {
            const { order_id } = body;
            const oid = Number(order_id);
            if (!oid) return res.status(400).json({ error: "ID do pedido é obrigatório." });

            const camposPedido = ["id", "name", "partner_id", "payment_term_id", "order_line", "state", "amount_total", "warehouse_id", "invoice_ids", "invoice_status", "date_order", "validity_date"];
            const camposLinha = ["id", "product_id", "product_uom_qty", "price_unit", "price_subtotal", "discount"];
            const camposFatura = ["id", "name", "state", "payment_state", "amount_total", "amount_residual", "invoice_date_due"];
            const buscaPedido = () => execute("sale.order", "search_read", [[["id", "=", oid]]], { fields: camposPedido });
            const buscaLinhas = () => execute("sale.order.line", "search_read", [[["order_id", "=", oid], ["display_type", "=", false]]], { fields: camposLinha });
            const faturasPorIds = ids => ids.length > 0
                ? execute("account.move", "search_read", [[["id", "in", ids]]], { fields: camposFatura })
                : Promise.resolve([]);

            // Pedido, linhas e faturas numa rodada só (as faturas são achadas pelas linhas do pedido, sem esperar o pedido).
            // Erros NÃO são engolidos: antes, uma falha momentânea nas linhas virava "lista vazia" e a venda abria sem os itens.
            let orders, lines, invoices;
            try {
                [orders, lines, invoices] = await Promise.all([
                    buscaPedido(),
                    buscaLinhas(),
                    execute("account.move", "search_read", [[["line_ids.sale_line_ids.order_id", "=", oid], ["move_type", "in", ["out_invoice", "out_refund"]]]], { fields: camposFatura })
                ]);
                // confere com a lista de faturas do próprio pedido; se divergir, busca por ela
                const idsPedido = (orders && orders[0] && orders[0].invoice_ids) || [];
                const idsAchados = (invoices || []).map(i => i.id);
                const igual = idsPedido.length === idsAchados.length && idsPedido.every(id => idsAchados.includes(id));
                if (!igual) invoices = await faturasPorIds(idsPedido);
            } catch (e) {
                // Odoo que não aceita esse filtro de fatura: caminho antigo (pedido + linhas, depois as faturas)
                [orders, lines] = await Promise.all([buscaPedido(), buscaLinhas()]);
                invoices = await faturasPorIds((orders && orders[0] && orders[0].invoice_ids) || []);
            }
            if (!orders || orders.length === 0) return res.status(404).json({ error: "Pedido de venda não encontrado." });

            const order = orders[0];
            let linhas = lines || [];
            // confere com a contagem do próprio pedido; se vier incompleto, busca de novo uma vez
            if (linhas.length === 0 && Array.isArray(order.order_line) && order.order_line.length > 0) {
                linhas = (await buscaLinhas()) || [];
                if (linhas.length === 0) return res.status(502).json({ error: "Não consegui carregar os itens da venda. Tente abrir novamente." });
            }

            return res.status(200).json({ order, lines: linhas, invoices: invoices || [] });
        }

        // AÇÃO: PRODUTOS COM ESTOQUE EM UM LOCAL DE ORIGEM (para as linhas da transferência)
        if (action === "get_location_products") {
            const locId = Number(body.location_id) || 0;
            if (!locId) return res.status(400).json({ error: "Local de origem é obrigatório." });

            // estoque físico do local escolhido (e sublocais), somado por produto
            const qtyByProduct = await saldoPorProduto(locId);
            const ids = Object.keys(qtyByProduct).map(Number);
            if (ids.length === 0) return res.status(200).json({ products: [] });

            // só produtos "Mercadorias" com "Vendas" marcado (mesmo critério das telas de Estoque e Produtos)
            // sem ordenar por display_name aqui (campo calculado, o Odoo rejeita); a ordem é feita no servidor
            const products = await execute("product.product", "search_read", [[["id", "in", ids], ...PRODUCT_BASE_DOMAIN]], {
                fields: ["id", "display_name", "uom_id"]
            });
            const list = (products || [])
                .map(pr => ({ ...pr, stock_qty: qtyByProduct[pr.id] }))
                .sort((a, b) => (a.display_name || "").localeCompare(b.display_name || "", "pt-BR"));
            return res.status(200).json({ products: list });
        }

        // AÇÃO: HISTÓRICO DE TRANSFERÊNCIAS CONCLUÍDAS LIGADAS AO LOCAL DO USUÁRIO (origem OU destino dentro do armazém)
        if (action === "get_transfer_history") {
            const whId = parseInt(body.warehouse_id, 10);
            if (!whId) return res.status(400).json({ error: "Escolha o seu local." });
            const whs = await lookups.warehouses();
            const wh = (whs || []).find(w => w.id === whId);
            const raiz = wh ? ((Array.isArray(wh.view_location_id) && wh.view_location_id[0]) || (Array.isArray(wh.lot_stock_id) && wh.lot_stock_id[0])) : null;
            if (!raiz) return res.status(404).json({ error: "Local não encontrado." });

            const picks = await execute("stock.picking", "search_read", [[
                ["picking_type_id.code", "=", "internal"],
                ["state", "=", "done"],
                "|", ["location_id", "child_of", raiz], ["location_dest_id", "child_of", raiz]
            ]], { fields: ["id", "name", "date_done", "location_id", "location_dest_id"], order: "date_done desc, id desc", limit: Math.min(parseInt(body.limit, 10) || 30, 100) });

            let moves = [];
            if (picks && picks.length > 0) {
                moves = await execute("stock.move", "search_read", [[["picking_id", "in", picks.map(p => p.id)]]], {
                    fields: ["picking_id", "product_id", "product_uom_qty"], limit: 2000
                });
            }
            const result = (picks || []).map(p => ({
                id: p.id,
                name: p.name,
                date_done: p.date_done,
                origin: Array.isArray(p.location_id) ? p.location_id[1] : "",
                dest: Array.isArray(p.location_dest_id) ? p.location_dest_id[1] : "",
                lines: (moves || []).filter(m => Array.isArray(m.picking_id) && m.picking_id[0] === p.id)
                    .map(m => ({ name: Array.isArray(m.product_id) ? m.product_id[1] : "-", qty: m.product_uom_qty }))
            }));
            return res.status(200).json({ result });
        }

        // AÇÃO: TRANSFERÊNCIA RÁPIDA (app mobile): cria, confirma e valida a transferência interna de uma vez
        if (action === "quick_transfer") {
            const srcId = Number(body.location_id) || 0;
            const dstId = Number(body.location_dest_id) || 0;
            const items = (body.lines || []).map(l => ({ product_id: Number(l.product_id), qty: Number(l.qty) }));
            if (!srcId || !dstId) return res.status(400).json({ error: "Escolha o local de origem e o de destino." });
            if (srcId === dstId) return res.status(400).json({ error: "A origem e o destino devem ser diferentes." });
            if (items.length === 0) return res.status(400).json({ error: "Adicione ao menos um produto." });
            if (items.some(l => !l.product_id || !(l.qty > 0))) return res.status(400).json({ error: "A quantidade de cada produto deve ser maior que zero." });
            if (new Set(items.map(l => l.product_id)).size !== items.length) return res.status(400).json({ error: "Há produtos repetidos na transferência." });

            // confere o saldo de cada produto na origem
            const quants = await execute("stock.quant", "search_read", [[
                ["location_id", "child_of", srcId],
                ["location_id.usage", "=", "internal"],
                ["product_id", "in", items.map(l => l.product_id)]
            ]], { fields: ["product_id", "quantity"] });
            const saldo = {};
            (quants || []).forEach(q => { if (Array.isArray(q.product_id)) saldo[q.product_id[0]] = (saldo[q.product_id[0]] || 0) + q.quantity; });
            for (const l of items) {
                if ((saldo[l.product_id] || 0) + 1e-9 < l.qty) {
                    return res.status(400).json({ error: "Quantidade maior que o estoque disponível na origem (disponível: " + (saldo[l.product_id] || 0) + ")." });
                }
            }

            // só Mercadorias com "Vendas" marcado podem ser transferidas por aqui
            const validos = await execute("product.product", "search_read", [[["id", "in", items.map(l => l.product_id)], ...PRODUCT_BASE_DOMAIN]], { fields: ["id", "display_name"] });
            const idsValidos = new Set((validos || []).map(p => p.id));
            const invalidos = items.filter(l => !idsValidos.has(l.product_id));
            if (invalidos.length > 0) return res.status(400).json({ error: "Só produtos do tipo Mercadorias com \"Vendas\" marcado podem ser transferidos. Atualize a lista e tente de novo." });

            const type = await resolveInternalPickingType(srcId);
            if (!type) return res.status(400).json({ error: "Nenhum tipo de operação de Transferência Interna encontrado no Odoo." });

            const moveCmds = [];
            for (const l of items) {
                moveCmds.push([0, 0, await onlyExistingFields("stock.move", {
                    product_id: l.product_id,
                    product_uom_qty: l.qty,
                    location_id: srcId,
                    location_dest_id: dstId
                })]);
            }
            const pickingId = await execute("stock.picking", "create", [{
                picking_type_id: type.id,
                location_id: srcId,
                location_dest_id: dstId,
                move_ids: moveCmds
            }]);

            try {
                await execute("stock.picking", "action_confirm", [[pickingId]]);
                await execute("stock.picking", "action_assign", [[pickingId]]).catch(() => {});
                await completarQuantidades([pickingId]);
                const v = await validarPickingComAssistentes(pickingId, { skip_immediate: true, skip_backorder: true });
                if (!v.ok) return res.status(500).json({ error: "A transferência " + v.name + " foi criada, mas não foi concluída. Finalize-a no Odoo." });
                return res.status(200).json({ success: true, id: pickingId, name: v.name });
            } catch (e) {
                // não deixa transferência pela metade no Odoo: cancela o rascunho/pendente criado agora
                let limpou = false;
                try {
                    await execute("stock.picking", "action_cancel", [[pickingId]]);
                    limpou = true;
                } catch (e2) { /* se não deu para cancelar, avisa abaixo */ }
                return res.status(500).json({ error: limpou
                    ? "Não foi possível concluir a transferência: " + e.message + " Nada foi movido; pode tentar de novo."
                    : "A transferência #" + pickingId + " foi criada, mas não pôde ser concluída: " + e.message + " Confira ou cancele-a no Odoo." });
            }
        }

        // Qualquer outra ação não existe: nada de cair numa ação padrão por engano
        return res.status(400).json({ error: "Ação desconhecida: " + action });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
