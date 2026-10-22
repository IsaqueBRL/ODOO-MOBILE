# Deuris Candy 2 - Mobile

App web mobile (PWA) para estoque, vendas e transferências do Deuris Candy 2, integrado ao Odoo.

## Estrutura

- `index.html`: aplicação (interface e lógica).
- `api/odoo.js`: endpoint que faz a ponte com o Odoo.
- `manifest.json`: configuração de instalação do app (PWA).
- `service-worker.js`: guarda o "shell" do app para permitir a instalação e evitar tela branca sem internet.
- `vercel.json`: tempo máximo da API (60 s) e cabeçalhos de cache/segurança.
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

## Desempenho

Cada ação do app faz várias chamadas seguidas ao Odoo, então a distância entre o servidor da Vercel e o Odoo pesa bastante.
Se o seu Odoo estiver no Brasil, vale fixar a região da API em São Paulo, adicionando ao `vercel.json`:

```json
"regions": ["gru1"]
```

## Pendências conhecidas

- **Autenticação da API:** `/api/odoo` ainda não exige login. Quem souber o endereço consegue chamar as ações com a chave do Odoo. Foi adiado de propósito; é o próximo passo recomendado (PIN/login com token assinado, lista de ações permitidas e CORS restrito ao próprio domínio).
- **Ações sem uso no app:** a API tem várias ações herdadas do painel desktop (excluir pagamento, excluir venda, transferência entre contas etc.) que o app mobile não usa. Devem ser removidas ou bloqueadas junto com a autenticação.
- **Odoo 19+:** o endpoint `/jsonrpc` pode ser descontinuado nas próximas versões do Odoo. Confira a documentação oficial antes de atualizar o Odoo.

## Observação

Os dados (estoque, vendas, clientes) vêm sempre da API `/api/odoo` em tempo real, então o app precisa de internet para funcionar de verdade.
Os dados de apoio (lista de locais e de contas de pagamento) ficam guardados no aparelho só para abrir mais rápido e são atualizados em segundo plano.
