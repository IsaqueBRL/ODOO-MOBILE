# Deuris Candy 2 - Mobile

App web mobile (PWA) para estoque, vendas e transferências do Deuris Candy 2, integrado ao Odoo.

## Estrutura

- `index.html`: aplicação (interface e lógica).
- `api/odoo.js`: endpoint que faz a ponte com o Odoo.
- `manifest.json`: configuração de instalação do app (PWA).
- `service-worker.js`: guarda o "shell" do app para permitir a instalação e evitar tela branca sem internet.
- `icon-*.png`: ícones do app.

## Observação

Os dados (estoque, vendas, clientes) vêm sempre da API `/api/odoo` em tempo real, então o app precisa de internet para funcionar de verdade.
