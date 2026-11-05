import test from "node:test";
import assert from "node:assert/strict";
import { r2, fmtBR, mesmoValor, hojeNoFuso, planejarCredito, resumoPagamento, dominioPagamento, faltaDeEstoque } from "../api/_utils.js";

test("r2 arredonda em centavos e fmtBR formata em português", () => {
    assert.equal(r2(1.005 + 0.0001), 1.01);
    assert.equal(r2("10.499"), 10.5);
    assert.equal(fmtBR(1234.5), "1234,50");
});

test("mesmoValor tolera 1 centavo", () => {
    assert.ok(mesmoValor(100, 100.004));
    assert.ok(!mesmoValor(100, 99));
});

test("hojeNoFuso usa o fuso fixo (Manaus -4)", () => {
    const t = Date.UTC(2026, 10, 4, 2, 30);          // 04/11 02:30 UTC = 03/11 22:30 em Manaus
    assert.equal(hojeNoFuso(-4, t), "2026-11-03");
});

test("planejarCredito: usa a linha inteira quando o valor cobre o menor entre crédito e saldo", () => {
    const p = planejarCredito([{ id: 1, amount_residual: -30 }], 100, 30);
    assert.deepEqual(p.passos, [{ lineId: 1, valor: 30, inteiro: true }]);
    assert.equal(p.faltaUsar, 0);
    assert.equal(p.saldoFat, 70);
});

test("planejarCredito: valor menor que o crédito vira conciliação parcial", () => {
    const p = planejarCredito([{ id: 1, amount_residual: -50 }], 100, 20);
    assert.deepEqual(p.passos, [{ lineId: 1, valor: 20, inteiro: false }]);
    assert.equal(p.saldoFat, 80);
});

test("planejarCredito: usa várias linhas, mais antigas primeiro, e para quando quita", () => {
    const p = planejarCredito([{ id: 1, amount_residual: -40 }, { id: 2, amount_residual: -40 }, { id: 3, amount_residual: -40 }], 70, 70);
    assert.deepEqual(p.passos.map(x => [x.lineId, x.valor, x.inteiro]), [[1, 40, true], [2, 30, true]]);
    assert.equal(p.saldoFat, 0);
    assert.equal(p.faltaUsar, 0);
});

test("planejarCredito: sem crédito suficiente sobra 'faltaUsar'", () => {
    const p = planejarCredito([{ id: 1, amount_residual: -10 }], 100, 30);
    assert.equal(p.aplicado, 10);
    assert.equal(p.faltaUsar, 20);
});

test("resumoPagamento ignora faturas canceladas", () => {
    assert.equal(resumoPagamento([]), "nao_faturado");
    assert.equal(resumoPagamento([{ state: "cancel", payment_state: "not_paid" }]), "nao_faturado");
    assert.equal(resumoPagamento([{ state: "posted", payment_state: "paid" }, { state: "cancel", payment_state: "not_paid" }]), "pago");
    assert.equal(resumoPagamento([{ state: "posted", payment_state: "in_payment" }]), "pago");
    assert.equal(resumoPagamento([{ state: "posted", payment_state: "partial" }]), "parcial");
    assert.equal(resumoPagamento([{ state: "draft", payment_state: "not_paid" }]), "nao_pago");
    assert.equal(resumoPagamento([{ state: "posted", payment_state: "paid" }, { state: "posted", payment_state: "not_paid" }]), "parcial");
});

test("dominioPagamento: 'paid' são 2 termos e 'sale' é um OR de 3 elementos", () => {
    const pago = dominioPagamento("paid");
    assert.equal(pago.length, 2);
    assert.equal(pago[0][1], "any");
    assert.equal(pago[1][1], "not any");
    const naoPago = dominioPagamento("sale");
    assert.equal(naoPago.length, 3);
    assert.equal(naoPago[0], "|");
    assert.deepEqual(dominioPagamento("outro"), []);
});

test("faltaDeEstoque acusa só o que passa do saldo", () => {
    const f = faltaDeEstoque({ 1: 5, 2: 3, 3: 1 }, { 1: 5, 2: 2 });
    assert.deepEqual(f, [{ product_id: 2, pedido: 3, disponivel: 2 }, { product_id: 3, pedido: 1, disponivel: 0 }]);
    assert.deepEqual(faltaDeEstoque({ 1: 1 }, { 1: 1 }), []);
});
