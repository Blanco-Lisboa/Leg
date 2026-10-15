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
- Funções: `supabase/functions/wa-gw-receber` (recebe do WhatsGW), `wa-gw-enviar` (envia; repassa a mensagem citada em `quoted.key.id` e marca `message_to_group` em grupo), `wa-gw-acao` (apagar com `DeleteMessage`, editar com `Send`+`edit.key.id`, reagir com `Send`+`react.key.id`, marcar como lida só no sistema) e `wa-transcrever` (áudio recebido vira texto pelo conversor da VPS).
- Banco: `wa_gw_acao_preparar` (usuário) e `wa_gw_acao_resultado` (servidor); apagar ou editar mensagem de outra pessoa exige a permissão `wa_mensagem_qualquer`.
- Fotos de perfil: ao chegar mensagem de contato sem foto, o recebimento pede `GetAllChats` (no máximo 1 vez a cada 30 minutos, só depois da virada); o WhatsGW devolve o evento `chats` no mesmo webhook e as fotos vão para `wa-midia/<conversa_id>/perfil.jpg` (`wa_contato.foto_url`).
- Transcrição: gatilho `trg_wa_midia_transcrever` chama `wa-transcrever` com a chave do cofre `wa_transcrever_chave`; a função usa a variável `CONVERSOR_BILLY_CHAVE` da Edge. Sem as duas, nada é chamado.
- Antes da virada o envio responde "O WhatsApp da Legalização ainda não foi ligado ao sistema." e o recebimento recusa tudo (sem token).

### Para ligar a transcrição (segredos, só com o William)
1. Criar no cofre do banco do Legal o segredo `wa_transcrever_chave` (valor novo, aleatório).
2. Criar na Edge do Legal a variável `CONVERSOR_BILLY_CHAVE` com o mesmo valor que já está na Edge do Fiscal e na VPS.

### Passos da virada (só com o "pode" do William)
1. Guardar a chave do WhatsGW no cofre do banco do Legal com o nome `wa_gw_apikey`.
2. Rodar `select wa_gw_preparar_virada(<id do numero>)` como servidor: devolve o endereço do webhook.
3. No painel do WhatsGW, trocar o webhook da instância 130989 para esse endereço.
4. Marcar `wa_gw_conexao.virada_em = now()` e `wa_numero.conectado = true`.
5. Mandar uma mensagem de teste e conferir que chegou na Legalização.
