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

## WhatsApp (WhatsGW) — pronto; apontamento junto com o Tauri depende só da chave
- Número: (11) 96567-0720, instância WhatsGW 130989 (`wa_numero` + `wa_gw_conexao`).
- Endereço do WhatsGW: `http://app.whatsgw.com.br/api`. Do servidor do Supabase o HTTPS do WhatsGW é recusado ("connection reset"); só HTTP responde (o Tauri também usa HTTP).
- Funções:
  - `wa-gw-receber`: recebe do WhatsGW e repassa o mesmo corpo, sem mudar nada, para o webhook antigo (Tauri) quando o repasse está ligado. Entende direção pelo `message_state`/`message_direction`, reação (`context_type=1`), resposta (`context_type=2`), apagada/editada pelo contato, arquivo `file`, contato, localização, chamada, `phonestate`, `account_health`, `groups`, mídia que chega como link, e guarda o corpo pequeno para reprocessar quando chegar o próximo aviso.
  - `wa-gw-enviar`: envia com `check_status=1`, `message_custom_id` = id da tela, áudio de voz como `ptt` (OGG/Opus), prévia de link, motivo da recusa em `result_message`; fila por conversa (`na_fila`) liberada pelo banco quando a anterior chega ao servidor do WhatsApp.
  - `wa-gw-acao`: apagar (`DeleteMessage`, só até 2 dias), editar (`Send`+`edit.key.id`), reagir e tirar reação (formulário com `react.key.id`).
  - `wa-gw-apontar`: só o banco chama (chave interna `wa_gw_admin_chave`). `ler` guarda o webhook atual no cofre; `apontar` testa o repasse para o Tauri antes de trocar e volta sozinho se o WhatsGW não gravar; `voltar` devolve o webhook antigo.
  - `wa-transcrever`: áudio recebido vira texto pelo conversor da VPS.
- Banco: `wa_gw_receber`, `wa_gw_status` (acha por `message_custom_id`, `message_id` ou `waid`; status adiantado espera em `wa_gw_status_espera`), `wa_gw_mudanca`, `wa_gw_telefone`, `wa_gw_saude`, `wa_gw_alerta` (só gestor lê), `wa_gw_fila_*`, `wa_gw_repasse_*`, `wa_gw_webhook_antigo*`.

### Para ligar (só com o William)
1. Guardar a chave do WhatsGW no cofre do banco do Legal com o nome `wa_gw_apikey` (painel do Supabase → Vault).
2. Rodar como servidor: `select net.http_post(url := 'https://ynqcmzukahkmqbvirlkb.supabase.co/functions/v1/wa-gw-apontar', body := jsonb_build_object('acao','ler','numero_id','a52ed8bc-a49c-4c2d-b3d5-36028c460652'), headers := jsonb_build_object('Content-Type','application/json','x-chave',(select decrypted_secret from vault.decrypted_secrets where name='wa_gw_admin_chave')));` e ler a resposta em `net._http_response` (mostra só o domínio do webhook, nunca o token).
3. Com o "pode": a mesma chamada com `'acao','apontar'`. Ela guarda o webhook do Tauri, liga o repasse, testa o repasse com um evento inofensivo e só então troca o webhook no WhatsGW.
4. Para voltar: `'acao','voltar'`.

### Para ligar a transcrição (segredos, só com o William)
1. Criar no cofre do banco do Legal o segredo `wa_transcrever_chave` (valor novo, aleatório).
2. A chave do conversor é lida do cofre pela função `wa_conversor_chave` (ver commit 09b3cb1).
