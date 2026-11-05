# Deuris Candy 2 - Mobile

App web mobile (PWA) para estoque, vendas e transferências do Deuris Candy 2, integrado ao Odoo.

## Estrutura

- `index.html`: estrutura das telas.
- `style.css`: visual do app.
- `app.js`: lógica do app (telas, vendas, pagamentos, estoque, transferências).
- `api/odoo.js`: endpoint que faz a ponte com o Odoo (só as ações que o app usa).
- `api/_utils.js`: funções de cálculo usadas pela API (crédito, status de pagamento, falta de estoque). O `_` no nome impede a Vercel de publicá-lo como endpoint.
- `tests/`: testes automáticos (`npm test`). A API é testada contra um Odoo simulado, sem rede.
- `manifest.json`: configuração de instalação do app (PWA).
- `service-worker.js`: guarda o "shell" do app (HTML, CSS, JS, ícones) para permitir a instalação e evitar tela branca sem internet.
- `vercel.json`: tempo máximo da API (60 s) e cabeçalhos de cache/segurança (CSP, HSTS etc.).
- `icon-*.png`: ícones do app.

## Variáveis de ambiente (Vercel > Settings > Environment Variables)

| Nome | Obrigatória | Para que serve |
| --- | --- | --- |
| `ODOO_URL` | sim | Endereço JSON-RPC do Odoo. O código faz POST direto nesse endereço (normalmente termina em `/jsonrpc`). |
| `ODOO_DB` | sim | Nome do banco de dados do Odoo. |
| `ODOO_USER` | sim | Usuário (login) usado pela API. |
| `ODOO_API_KEY` | sim | Chave de API desse usuário. |
| `ODOO_FORCED_ACCOUNT_CODE` | não | Código da conta contábil aplicada às linhas das faturas. Padrão: `3.01.01.01.01.04`. |
| `TZ_OFFSET_HORAS` | não | Fuso em horas, usado só quando o app não envia a data do dia. Padrão: `-4` (Manaus). |

Nunca coloque usuário, senha ou chave de API dentro do código.

## Como o app se comporta

- **Sem internet:** o app é bloqueado por uma tela de aviso e libera sozinho quando a conexão volta. Nada é enviado enquanto estiver sem conexão.
- **Venda não duplica:** cada venda nova leva uma chave única. Se a internet cair no meio e o envio for repetido, o servidor reaproveita a mesma venda e conclui o que faltou (entrega e fatura).
- **Pagamento não duplica:** o app envia o saldo que a fatura tinha na tela; se o saldo no Odoo já for outro (pagamento já registrado), o servidor recusa (erro 409) e o app recarrega a venda.
- **Edição de venda lançada é retomável:** o Odoo não permite "tudo ou nada" entre várias chamadas. Se algo falhar no meio, tocar em "Salvar alterações" de novo conclui a entrega e a fatura que ficaram diferentes do pedido.
- **Estoque:** não é possível lançar nem aumentar uma venda acima do saldo do local (o app e o servidor conferem). Quantidade em estoque igual ou menor que 1 aparece em vermelho.
- **Status da venda:** Orçamento, Confirmada e Cancelada podem ser trocados entre si, **somente se a venda não tiver nenhum pagamento** (nem parcial, nem crédito usado). Venda paga precisa ser revertida antes. Orçamentos podem ser abertos, editados, lançados, cancelados ou excluídos.
- **Crédito do cliente:** o uso parcial de crédito é conferido depois de gravado (saldo da fatura antes x depois); se não bater, a conciliação é desfeita.
- **Chave de API trocada:** se o Odoo responder "acesso negado", a API autentica de novo e repete a chamada uma vez, sem precisar reiniciar nada.

## Testes

```
npm test
```

## Desempenho

Cada ação do app faz várias chamadas seguidas ao Odoo, então a distância entre o servidor da Vercel e o Odoo pesa bastante.
Se o seu Odoo estiver no Brasil, vale fixar a região da API em São Paulo, adicionando ao `vercel.json`:

```json
"regions": ["gru1"]
```

## Pendências conhecidas

- **Autenticação da API:** `/api/odoo` não exige login (decisão consciente: operação pequena, só pessoas de confiança). Se a operação crescer, o próximo passo é PIN/login com token assinado, lista de ações permitidas por perfil e CORS restrito ao próprio domínio. As ações herdadas do painel desktop (excluir pagamento, transferência entre contas, editar produto etc.) já foram removidas.
- **Odoo 19+:** o endpoint `/jsonrpc` pode ser descontinuado nas próximas versões do Odoo. Confira a documentação oficial antes de atualizar o Odoo.
- **Filtros "Pago" e "Confirmadas":** usam um filtro direto por fatura no pedido (Odoo 17+). Em versão que não aceite, a API volta sozinha para o método antigo (mais lento).

## Observação

Os dados (estoque, vendas, clientes) vêm sempre da API `/api/odoo` em tempo real, então o app precisa de internet para funcionar de verdade.
Os dados de apoio (lista de locais e de contas de pagamento) ficam guardados no aparelho só para abrir mais rápido e são atualizados em segundo plano.
