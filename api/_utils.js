// Funções puras (sem Odoo, sem rede) usadas por api/odoo.js.
// O nome começa com "_" para a Vercel não publicar este arquivo como endpoint.
// Ficam aqui para poderem ser testadas: `npm test`.

// Arredonda em centavos
export const r2 = n => Math.round(Number(n) * 100) / 100;

// 1234.5 -> "1234,50" (mensagens de erro para o usuário)
export const fmtBR = n => r2(n).toFixed(2).replace(".", ",");

// Dois valores em reais são "iguais" dentro de uma tolerância (padrão: 1 centavo)
export const mesmoValor = (a, b, tol = 0.01) => Math.abs(r2(a) - r2(b)) <= tol;

// Data de "hoje" (AAAA-MM-DD) num fuso fixo em horas (Manaus = -4)
export const hojeNoFuso = (offsetHoras, agoraMs = Date.now()) =>
    new Date(agoraMs + offsetHoras * 3600 * 1000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------
// Crédito do cliente
// ---------------------------------------------------------------------
// Decide como gastar `valor` de crédito numa fatura com saldo `residualFatura`.
// `creditos`: linhas de crédito em aberto, mais antigas primeiro, com amount_residual NEGATIVO (como no Odoo).
// Cada passo diz quanto usar de cada linha e se é "inteiro" (conciliação normal do Odoo, que usa
// o menor entre a linha e o saldo da fatura) ou parcial (só uma parte do crédito).
export function planejarCredito(creditos, residualFatura, valor) {
    let faltaUsar = r2(valor);
    let saldoFat = r2(residualFatura);
    let aplicado = 0;
    const passos = [];
    for (const cl of (creditos || [])) {
        if (faltaUsar <= 0.004 || saldoFat <= 0.004) break;
        const credLinha = r2(-Number(cl.amount_residual));
        const natural = r2(Math.min(credLinha, saldoFat));
        const a = r2(Math.min(faltaUsar, natural));
        if (a <= 0.004) continue;
        passos.push({ lineId: cl.id, valor: a, inteiro: Math.abs(a - natural) < 0.005 });
        aplicado = r2(aplicado + a);
        faltaUsar = r2(faltaUsar - a);
        saldoFat = r2(saldoFat - a);
    }
    return { passos, aplicado, faltaUsar, saldoFat };
}

// ---------------------------------------------------------------------
// Status de pagamento de uma venda
// ---------------------------------------------------------------------
// `faturas`: [{ state, payment_state }]. Faturas canceladas (ex.: refeitas ao editar a venda) não contam.
export function resumoPagamento(faturas) {
    const invs = (faturas || []).filter(i => i && i.state !== "cancel");
    if (invs.length === 0) return "nao_faturado";
    const quitada = i => i.payment_state === "paid" || i.payment_state === "in_payment";
    if (invs.every(quitada)) return "pago";
    if (invs.some(i => quitada(i) || i.payment_state === "partial")) return "parcial";
    return "nao_pago";
}

// Filtros "Pago" e "Confirmadas (não pagas)" montados direto no domínio do pedido (Odoo 17+, operador "any"),
// para o Odoo filtrar numa consulta só, em vez de o servidor ler as faturas página por página.
const FAT_ATIVA = ["state", "!=", "cancel"];
const FAT_NAO_QUITADA = ["payment_state", "not in", ["paid", "in_payment"]];
export function dominioPagamento(tipo) {
    if (tipo === "paid") {
        // tem fatura ativa e nenhuma delas está sem quitar
        return [["invoice_ids", "any", [FAT_ATIVA]], ["invoice_ids", "not any", [FAT_ATIVA, FAT_NAO_QUITADA]]];
    }
    if (tipo === "sale") {
        // o contrário de "pago": sem fatura ativa, ou com alguma fatura sem quitar
        return ["|", ["invoice_ids", "not any", [FAT_ATIVA]], ["invoice_ids", "any", [FAT_ATIVA, FAT_NAO_QUITADA]]];
    }
    return [];
}

// ---------------------------------------------------------------------
// Estoque
// ---------------------------------------------------------------------
// `necessario`: { idProduto: quantidade }, `saldo`: { idProduto: quantidade disponível }.
// Devolve os produtos em que o pedido passa do que há em estoque.
export function faltaDeEstoque(necessario, saldo) {
    const falta = [];
    for (const [pid, qtd] of Object.entries(necessario || {})) {
        const disponivel = Number((saldo || {})[pid]) || 0;
        if (Number(qtd) > disponivel + 1e-9) falta.push({ product_id: Number(pid), pedido: Number(qtd), disponivel });
    }
    return falta;
}
