# Legalização — Java do departamento

O programa é o mesmo do Fiscal (repositório `Blanco-Lisboa/Fisc`), aberto como departamento `legalizacao`.
Este repositório guarda o que é só do Legal.

## Onde fica cada coisa
- Banco: Supabase `ynqcmzukahkmqbvirlkb` (migrações registradas no próprio banco).
- Entrada: só quem está ligado ao setor Legalização da YOU Contabilidade na BL (`fiscal_acesso_bl`).
- Leitura da BL: edge `porta-legal` na BL, só leitura, chave no cofre do Legal (`porta_fiscal_chave`).
- Modo de trabalho: fila (`fiscal_config.modo_trabalho`), todos do departamento veem as conversas.
- Publicação: `ferramentas/app/publicar.ps1 -Departamento legalizacao` no repositório Fisc.
- Instalador: `ferramentas/app/gerar-instalador.ps1 -Departamento legalizacao` (gera `Legalizacao-Instalador.exe`).
- Tela: canal `estavel` da VPS (`app.it-ia.tec.br/estavel`, ramo `app-estavel` do Fisc).

## WhatsApp (WhatsGW) — pronto, falta só a virada
- Número: (11) 96567-0720, instância WhatsGW 130989 (`wa_numero` + `wa_gw_conexao`).
- Funções: `supabase/functions/wa-gw-receber` (recebe do WhatsGW) e `wa-gw-enviar` (envia).
- Antes da virada o envio responde "O WhatsApp da Legalização ainda não foi ligado ao sistema." e o recebimento recusa tudo (sem token).

### Passos da virada (só com o "pode" do William)
1. Guardar a chave do WhatsGW no cofre do banco do Legal com o nome `wa_gw_apikey`.
2. Rodar `select wa_gw_preparar_virada(<id do numero>)` como servidor: devolve o endereço do webhook.
3. No painel do WhatsGW, trocar o webhook da instância 130989 para esse endereço.
4. Marcar `wa_gw_conexao.virada_em = now()` e `wa_numero.conectado = true`.
5. Mandar uma mensagem de teste e conferir que chegou na Legalização.
