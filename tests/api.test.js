// Testa o endpoint inteiro (api/odoo.js) contra um Odoo SIMULADO: nenhuma chamada de rede de verdade.
import test from "node:test";
import assert from "node:assert/strict";

process.env.ODOO_URL = "http://odoo.test/jsonrpc";
process.env.ODOO_DB = "db";
process.env.ODOO_USER = "user";
process.env.ODOO_API_KEY = "key";

let versao = 0;
let calls = [];          // { service, method, model, odooMethod, args, kwargs }
let respostas = {};      // "modelo.metodo" -> função(args, kwargs) | valor
let authCalls = 0;
const realFetch = globalThis.fetch;

function instalarOdoo() {
    calls = []; respostas = {}; authCalls = 0;
    globalThis.fetch = async (_url, opts) => {
        const { params } = JSON.parse(opts.body);
        if (params.service === "common") {
            authCalls++;
            return { status: 200, json: async () => ({ result: 7 }) };
        }
        const [, , , model, odooMethod, args, kwargs] = params.args;
        calls.push({ model, odooMethod, args, kwargs: kwargs || {} });
        const h = respostas[model + "." + odooMethod];
        let result;
        if (typeof h === "function") {
            try { result = await h(args, kwargs || {}); }
            catch (e) { return { status: 200, json: async () => ({ error: e.rpc || { message: e.message, data: { message: e.message } } }) }; }
        } else if (h !== undefined) result = h;
        else result = odooMethod === "search_read" || odooMethod === "read" || odooMethod === "read_group" ? [] : true;
        return { status: 200, json: async () => ({ result }) };
    };
}
test.after(() => { globalThis.fetch = realFetch; });

async function chamar(body) {
    const mod = await import("../api/odoo.js?v=" + (++versao));    // módulo novo = cache e uid zerados
    let status = 200, json;
    const res = {
        setHeader() {}, end() {},
        status(s) { status = s; return this; },
        json(j) { json = j; return this; }
    };
    await mod.default({ method: "POST", body }, res);
    return { status, json };
}
const feitas = (model, m) => calls.filter(c => c.model === model && c.odooMethod === m);

test("ping responde sem falar com o Odoo", async () => {
    instalarOdoo();
    const r = await chamar({ action: "ping" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    assert.equal(calls.length, 0);
});

test("ação desconhecida ou ausente vira erro 400 (não cai mais na lista de produtos)", async () => {
    instalarOdoo();
    assert.equal((await chamar({ action: "delete_payment", payment_id: 1 })).status, 400);
    assert.equal((await chamar({ action: "update_product", product_id: 1 })).status, 400);
    assert.equal((await chamar({})).status, 400);
    assert.equal(calls.length, 0);
});

test("get_stock soma por produto no Odoo (sem teto de 300 linhas)", async () => {
    instalarOdoo();
    respostas["stock.quant.read_group"] = () => [
        { product_id: [1, "BALA"], quantity: 120 },
        { product_id: [2, "PIRULITO"], quantity: 1 }
    ];
    const r = await chamar({ action: "get_stock", location_id: 5 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.result, [{ product_id: [1, "BALA"], quantity: 120 }, { product_id: [2, "PIRULITO"], quantity: 1 }]);
    assert.equal(feitas("stock.quant", "search_read").length, 0);
});

test("get_stock: se o read_group falhar, a leitura de reserva não tem limite", async () => {
    instalarOdoo();
    respostas["stock.quant.read_group"] = () => { throw new Error("sem read_group"); };
    respostas["stock.quant.search_read"] = [{ id: 1, product_id: [1, "BALA"], quantity: 5 }];
    const r = await chamar({ action: "get_stock", location_id: 5 });
    assert.equal(r.json.result.length, 1);
    assert.equal(feitas("stock.quant", "search_read")[0].kwargs.limit, undefined);
});

test("get_sales com filtro Pago filtra no Odoo e lê os pedidos UMA vez", async () => {
    instalarOdoo();
    respostas["sale.order.search_read"] = [{ id: 1, name: "S1", invoice_ids: [10], state: "sale", amount_total: 5, date_order: "2026-11-03 10:00:00" }];
    respostas["account.move.search_read"] = [{ id: 10, state: "posted", payment_state: "paid" }];
    const r = await chamar({ action: "get_sales", order_status: "paid", limit: 50 });
    assert.equal(r.status, 200);
    assert.equal(feitas("sale.order", "search_read").length, 1);
    assert.equal(r.json.result[0].payment_summary, "pago");
    const dominio = JSON.stringify(feitas("sale.order", "search_read")[0].args[0]);
    assert.ok(dominio.includes('"any"') && dominio.includes('"not any"'));
});

test("get_sales: Odoo sem suporte ao filtro por fatura cai no método antigo", async () => {
    instalarOdoo();
    let primeira = true;
    respostas["sale.order.search_read"] = (args) => {
        if (JSON.stringify(args[0]).includes('"any"')) throw new Error("operador any inválido");
        return primeira ? (primeira = false, [{ id: 1, name: "S1", invoice_ids: [10], state: "sale", amount_total: 5, date_order: "2026-11-03 10:00:00" }]) : [];
    };
    respostas["account.move.search_read"] = [{ id: 10, state: "posted", payment_state: "paid" }];
    const r = await chamar({ action: "get_sales", order_status: "paid", limit: 50 });
    assert.equal(r.status, 200);
    assert.equal(r.json.result.length, 1);
});

test("register_payments: saldo mudou (envio repetido) => 409 e nenhum pagamento novo", async () => {
    instalarOdoo();
    respostas["account.move.read"] = [{ id: 10, name: "INV/1", state: "posted", amount_residual: 0, partner_id: [3, "ANA"], commercial_partner_id: [3, "ANA"] }];
    const r = await chamar({ action: "register_payments", order_id: 10, expected_residual: 100, payments: [{ journal_id: 1, amount: 100 }] });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /saldo da fatura mudou/i);
    assert.equal(feitas("account.payment.register", "create").length, 0);
});

test("register_payments: saldo igual ao da tela registra o pagamento", async () => {
    instalarOdoo();
    respostas["account.move.read"] = [{ id: 10, name: "INV/1", state: "posted", amount_residual: 100, partner_id: [3, "ANA"], commercial_partner_id: [3, "ANA"] }];
    respostas["account.payment.register.create"] = 55;
    const r = await chamar({ action: "register_payments", order_id: 10, expected_residual: 100, payments: [{ journal_id: 1, amount: 100 }] });
    assert.equal(r.status, 200);
    assert.equal(feitas("account.payment.register", "action_create_payments").length, 1);
});

test("apply_customer_credit: saldo mudou => 409 e nenhuma conciliação", async () => {
    instalarOdoo();
    respostas["account.move.read"] = [{ id: 10, name: "INV/1", state: "posted", amount_residual: 40, partner_id: [3, "ANA"], commercial_partner_id: [3, "ANA"] }];
    const r = await chamar({ action: "apply_customer_credit", invoice_id: 10, amount: 20, expected_residual: 100 });
    assert.equal(r.status, 409);
    assert.equal(feitas("account.move.line", "reconcile").length + feitas("account.partial.reconcile", "create").length, 0);
});

test("crédito parcial: se o saldo da fatura não bater depois, a conciliação é desfeita", async () => {
    instalarOdoo();
    let leituras = 0;
    respostas["account.move.read"] = () => {
        leituras++;
        // 1ª leitura (cliente da fatura): saldo 100; 2ª (antes da parcial): 100; 3ª (depois): continua 100 => não aplicou
        return [{ id: 10, name: "INV/1", state: "posted", amount_residual: 100, partner_id: [3, "ANA"], commercial_partner_id: [3, "ANA"] }];
    };
    respostas["account.move.line.search_read"] = (args) => {
        const dom = JSON.stringify(args[0]);
        if (dom.includes("amount_residual\",\"<\"")) return [{ id: 900, amount_residual: -50, date: "2026-01-01" }];   // crédito
        return [{ id: 800, amount_residual: 100 }];                                                                     // linha da fatura
    };
    respostas["account.partial.reconcile.create"] = 77;
    const r = await chamar({ action: "apply_customer_credit", invoice_id: 10, amount: 20, expected_residual: 100 });
    assert.equal(r.status, 500);
    assert.match(r.json.error, /desfeito/);
    assert.equal(feitas("account.partial.reconcile", "unlink").length, 1);
});

test("change_sale_status: venda com pagamento não muda de status", async () => {
    instalarOdoo();
    respostas["sale.order.read"] = [{ id: 1, state: "sale", invoice_ids: [10] }];
    respostas["account.move.search_read"] = [{ id: 10, name: "INV/1" }];
    const r = await chamar({ action: "change_sale_status", order_id: 1, status: "cancel" });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /pagamento/i);
    assert.equal(feitas("sale.order", "action_cancel").length, 0);
    assert.equal(feitas("sale.order", "action_draft").length, 0);
});

test("change_sale_status: orçamento -> cancelada e cancelada -> orçamento (sem pagamento)", async () => {
    instalarOdoo();
    respostas["sale.order.read"] = [{ id: 1, state: "draft", invoice_ids: [] }];
    assert.equal((await chamar({ action: "change_sale_status", order_id: 1, status: "cancel" })).status, 200);
    assert.equal(feitas("sale.order", "action_cancel").length, 1);

    instalarOdoo();
    respostas["sale.order.read"] = [{ id: 1, state: "cancel", invoice_ids: [] }];
    assert.equal((await chamar({ action: "change_sale_status", order_id: 1, status: "draft" })).status, 200);
    assert.equal(feitas("sale.order", "action_draft").length, 1);
});

test("delete_sale_order só exclui orçamento", async () => {
    instalarOdoo();
    respostas["sale.order.read"] = [{ id: 1, state: "sale" }];
    assert.equal((await chamar({ action: "delete_sale_order", order_id: 1 })).status, 400);
    assert.equal(feitas("sale.order", "unlink").length, 0);

    instalarOdoo();
    respostas["sale.order.read"] = [{ id: 1, state: "draft" }];
    assert.equal((await chamar({ action: "delete_sale_order", order_id: 1 })).status, 200);
    assert.equal(feitas("sale.order", "unlink").length, 1);
});

test("save_sale_order: venda acima do estoque é barrada antes de criar qualquer coisa", async () => {
    instalarOdoo();
    respostas["stock.warehouse.search_read"] = [{ id: 1, name: "LOJA", lot_stock_id: [20, "LOJA/Estoque"], view_location_id: [19, "LOJA"] }];
    respostas["stock.quant.read_group"] = [{ product_id: [5, "BALA"], quantity: 2 }];
    respostas["product.product.read"] = [{ id: 5, display_name: "BALA" }];
    const r = await chamar({ action: "save_sale_order", partner_id: 3, warehouse_id: 1, confirm: true, lines: [{ product_id: 5, qty: 3, price: 1 }], client_key: "abcdefgh-1234" });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Estoque insuficiente/);
    assert.equal(feitas("sale.order", "create").length, 0);
});

test("save_sale_order: rascunho NÃO confere estoque", async () => {
    instalarOdoo();
    respostas["sale.order.create"] = 99;
    const r = await chamar({ action: "save_sale_order", partner_id: 3, warehouse_id: 1, confirm: false, lines: [{ product_id: 5, qty: 300, price: 1 }], client_key: "abcdefgh-1234" });
    assert.equal(r.status, 200);
    assert.equal(r.json.id, 99);
    assert.equal(feitas("stock.quant", "read_group").length, 0);
});

test("save_sale_order: reenvio de venda já confirmada conclui entrega e fatura sem duplicar", async () => {
    instalarOdoo();
    respostas["sale.order.search_read"] = [{ id: 50, state: "sale" }];                    // achada pela chave
    respostas["stock.picking.search_read"] = [{ id: 8 }];                                 // entrega pendente
    respostas["stock.move.search_read"] = [{ id: 1, product_uom_qty: 2, quantity: 2 }];
    respostas["stock.picking.button_validate"] = true;
    respostas["stock.picking.read"] = [{ state: "done", name: "WH/OUT/1" }];
    respostas["sale.order.read"] = [{ invoice_ids: [] }];
    let criada = 0;
    respostas["sale.advance.payment.inv.create"] = () => { criada++; return 3; };
    respostas["sale.order.read"] = () => criada ? [{ invoice_ids: [31] }] : [{ invoice_ids: [] }];
    const r = await chamar({ action: "save_sale_order", partner_id: 3, warehouse_id: 1, confirm: true, lines: [{ product_id: 5, qty: 2, price: 1 }], client_key: "abcdefgh-1234" });
    assert.equal(r.status, 200);
    assert.equal(r.json.repeated, true);
    assert.equal(feitas("sale.order", "create").length, 0);
    assert.equal(feitas("sale.order", "action_confirm").length, 0);          // já estava confirmado
    assert.equal(feitas("stock.picking", "button_validate").length, 1);      // mas a entrega foi concluída
    assert.equal(feitas("sale.advance.payment.inv", "create_invoices").length, 1);   // e a fatura gerada
});

test("save_sale_order: entrega que não fica concluída gera aviso", async () => {
    instalarOdoo();
    respostas["sale.order.create"] = 60;
    respostas["stock.warehouse.search_read"] = [{ id: 1, name: "LOJA", lot_stock_id: [20, "x"], view_location_id: [19, "y"] }];
    respostas["stock.quant.read_group"] = [{ product_id: [5, "BALA"], quantity: 10 }];
    respostas["stock.picking.search_read"] = [{ id: 8 }];
    respostas["stock.picking.read"] = [{ state: "assigned", name: "WH/OUT/2" }];
    const r = await chamar({ action: "save_sale_order", partner_id: 3, warehouse_id: 1, confirm: true, lines: [{ product_id: 5, qty: 2, price: 1 }], client_key: "abcdefgh-9999" });
    assert.equal(r.status, 200);
    assert.ok(r.json.warnings.some(w => /não ficou concluída/.test(w)));
});

test("update_sale_lines: nada novo na tela mas a entrega difere => conclui o que ficou pela metade", async () => {
    instalarOdoo();
    respostas["sale.order.read"] = [{ id: 1, state: "sale", invoice_ids: [], validity_date: false, warehouse_id: [1, "LOJA"] }];
    respostas["sale.order.line.search_read"] = [{ id: 11, product_uom_qty: 3, discount: 0, qty_delivered: 2, qty_invoiced: 3, product_id: [5, "BALA"] }];
    const r = await chamar({ action: "update_sale_lines", order_id: 1, invoice_date: "2026-11-03", lines: [{ id: 11, product_id: 5, qty: 3, price: 1, discount: 0 }], removed_line_ids: [] });
    assert.equal(r.status, 200);
    assert.equal(feitas("sale.order", "write").filter(c => c.args[1] && c.args[1].order_line).length, 0);   // não regravou o pedido
    assert.ok(feitas("stock.picking", "search_read").length > 0);                                           // mas foi ajustar a entrega
});

test("update_sale_lines: nada mudou e tudo acompanha => não faz nada", async () => {
    instalarOdoo();
    respostas["sale.order.read"] = [{ id: 1, state: "sale", invoice_ids: [], validity_date: false, warehouse_id: [1, "LOJA"] }];
    respostas["sale.order.line.search_read"] = [{ id: 11, product_uom_qty: 3, discount: 0, qty_delivered: 3, qty_invoiced: 3 }];
    const r = await chamar({ action: "update_sale_lines", order_id: 1, lines: [{ id: 11, product_id: 5, qty: 3, price: 1, discount: 0 }], removed_line_ids: [] });
    assert.deepEqual(r.json, { success: true, warnings: [] });
    assert.equal(feitas("stock.picking", "search_read").length, 0);
});

test("update_sale_lines: aumentar acima do estoque é barrado", async () => {
    instalarOdoo();
    respostas["sale.order.read"] = [{ id: 1, state: "sale", invoice_ids: [], validity_date: false, warehouse_id: [1, "LOJA"] }];
    respostas["sale.order.line.search_read"] = [{ id: 11, product_uom_qty: 3, discount: 0 }];
    respostas["stock.warehouse.search_read"] = [{ id: 1, name: "LOJA", lot_stock_id: [20, "x"], view_location_id: [19, "y"] }];
    respostas["stock.quant.read_group"] = [{ product_id: [5, "BALA"], quantity: 1 }];
    respostas["product.product.read"] = [{ id: 5, display_name: "BALA" }];
    const r = await chamar({ action: "update_sale_lines", order_id: 1, lines: [{ id: 11, product_id: 5, qty: 6, price: 1, discount: 0 }], removed_line_ids: [] });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Estoque insuficiente/);     // 3 a mais, só há 1
    assert.equal(feitas("sale.order", "write").length, 0);
});

test("uid inválido: 'acesso negado' reautentica uma vez e repete a chamada", async () => {
    instalarOdoo();
    let tentativa = 0;
    respostas["res.partner.search_read"] = () => {
        if (tentativa++ === 0) { const e = new Error("Access Denied"); e.rpc = { message: "Odoo Server Error", data: { name: "odoo.exceptions.AccessDenied", message: "Access Denied" } }; throw e; }
        return [{ id: 1, name: "ANA" }];
    };
    const r = await chamar({ action: "search_partners", query: "ana" });
    assert.equal(r.status, 200);
    assert.equal(r.json.partners.length, 1);
    assert.equal(authCalls, 2);          // autenticou no começo e de novo depois do acesso negado
});

test("quick_transfer: valida com o helper e responde com o nome da transferência", async () => {
    instalarOdoo();
    respostas["stock.quant.search_read"] = [{ product_id: [5, "BALA"], quantity: 10 }];
    respostas["stock.picking.type.search_read"] = [{ id: 2, name: "Interna", default_location_src_id: [20, "x"], default_location_dest_id: [21, "y"] }];
    respostas["product.product.search_read"] = [{ id: 5, display_name: "BALA" }];
    respostas["stock.picking.create"] = 70;
    respostas["stock.move.search_read"] = [{ id: 1, product_uom_qty: 2, quantity: 2 }];
    respostas["stock.picking.read"] = [{ state: "done", name: "WH/INT/7" }];
    const r = await chamar({ action: "quick_transfer", location_id: 20, location_dest_id: 21, lines: [{ product_id: 5, qty: 2 }] });
    assert.equal(r.status, 200);
    assert.equal(r.json.name, "WH/INT/7");
    assert.equal(feitas("stock.move", "write").length, 0);       // reservou tudo sozinho: sem escrita por item
});

test("quick_transfer: se não concluir, avisa e não diz que deu certo", async () => {
    instalarOdoo();
    respostas["stock.quant.search_read"] = [{ product_id: [5, "BALA"], quantity: 10 }];
    respostas["stock.picking.type.search_read"] = [{ id: 2, name: "Interna", default_location_src_id: [20, "x"], default_location_dest_id: [21, "y"] }];
    respostas["product.product.search_read"] = [{ id: 5, display_name: "BALA" }];
    respostas["stock.picking.create"] = 71;
    respostas["stock.picking.read"] = [{ state: "assigned", name: "WH/INT/8" }];
    const r = await chamar({ action: "quick_transfer", location_id: 20, location_dest_id: 21, lines: [{ product_id: 5, qty: 2 }] });
    assert.equal(r.status, 500);
    assert.match(r.json.error, /não foi concluída/);
});

test("transferência: a lista de produtos do local traz só Mercadorias com Vendas marcado", async () => {
    instalarOdoo();
    respostas["stock.quant.read_group"] = [{ product_id: [5, "BALA"], quantity: 4 }];
    respostas["product.product.search_read"] = [{ id: 5, display_name: "BALA", uom_id: [1, "Un"] }];
    const r = await chamar({ action: "get_location_products", location_id: 20 });
    assert.equal(r.status, 200);
    const dominio = JSON.stringify(feitas("product.product", "search_read")[0].args[0]);
    assert.ok(dominio.includes('["type","=","consu"]'), dominio);
    assert.ok(dominio.includes('["sale_ok","=",true]'), dominio);
    assert.ok(!dominio.includes('"service"'), dominio);
});

test("quick_transfer: produto que não é Mercadorias/Vendas é recusado e nada é criado", async () => {
    instalarOdoo();
    respostas["stock.quant.search_read"] = [{ product_id: [9, "INSUMO"], quantity: 10 }];
    respostas["product.product.search_read"] = [];       // o Odoo não devolve: não passa no filtro
    const r = await chamar({ action: "quick_transfer", location_id: 20, location_dest_id: 21, lines: [{ product_id: 9, qty: 1 }] });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Mercadorias/);
    assert.equal(feitas("stock.picking", "create").length, 0);
});

test("histórico de transferências: pagina de 3 em 3 e avisa se há mais", async () => {
    instalarOdoo();
    respostas["stock.warehouse.search_read"] = [{ id: 1, name: "CASA", lot_stock_id: [20, "CASA/Estoque"], view_location_id: [19, "CASA"] }];
    const todas = [5, 4, 3, 2].map(n => ({ id: n, name: "CASA/INT/" + n, date_done: "2026-11-0" + n + " 10:00:00", location_id: [20, "CASA/Estoque"], location_dest_id: [30, "SHOP/Estoque"] }));
    respostas["stock.picking.search_read"] = (args, kw) => todas.slice(kw.offset || 0, (kw.offset || 0) + kw.limit);
    respostas["stock.move.search_read"] = (args) => args[0][0][2].map(id => ({ picking_id: [id, "x"], product_id: [1, "BALA"], product_uom_qty: 1 }));

    const p1 = await chamar({ action: "get_transfer_history", warehouse_id: 1, limit: 3 });
    assert.equal(p1.json.result.length, 3);
    assert.equal(p1.json.has_more, true);
    assert.equal(feitas("stock.picking", "search_read")[0].kwargs.limit, 4);      // pede 1 a mais
    assert.equal(feitas("stock.move", "search_read").length, 1);                  // linhas de uma vez só

    const p2 = await chamar({ action: "get_transfer_history", warehouse_id: 1, limit: 3, offset: 3 });
    assert.equal(p2.json.result.length, 1);
    assert.equal(p2.json.has_more, false);
    assert.deepEqual(p2.json.result.map(t => t.id), [2]);
});

test("histórico de transferências: sem 'limit' o padrão é 3", async () => {
    instalarOdoo();
    respostas["stock.warehouse.search_read"] = [{ id: 1, name: "CASA", lot_stock_id: [20, "x"], view_location_id: [19, "y"] }];
    respostas["stock.picking.search_read"] = [];
    const r = await chamar({ action: "get_transfer_history", warehouse_id: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.json.has_more, false);
    assert.equal(feitas("stock.picking", "search_read")[0].kwargs.limit, 4);
});
