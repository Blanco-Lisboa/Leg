import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

const ESTADOS_ENVIO = new Set(["delivered2server", "delivered2user", "read", "played", "notwa", "notsent"]);
const TIPOS: Record<string, string> = {
  text: "texto", chat: "texto", image: "imagem", document: "documento", file: "documento", video: "video", audio: "audio", ptt: "audio",
  sticker: "figurinha", vcard: "contato", contact: "contato", location: "local", call: "sistema",
};
const MIDIAS = new Set(["imagem", "documento", "video", "audio", "figurinha"]);
const CHAT_IGNORADO = new Set(["broadcast", "newsletter", "newslatter", "status"]);
const LIMITE = 60 * 1024 * 1024;
const GRANDE = 1_000_000;
const DIA2 = 172800000;

// corpo
function acharChave(b: Uint8Array, chave: string): [number, number] | null {
  const alvo = new TextEncoder().encode(chave + "=");
  for (let i = 0; i + alvo.length <= b.length; i++) {
    if (i > 0 && b[i - 1] !== 38) continue;
    let bate = true;
    for (let j = 0; j < alvo.length; j++) if (b[i + j] !== alvo[j]) { bate = false; break; }
    if (!bate) continue;
    let fim = i + alvo.length;
    while (fim < b.length && b[fim] !== 38) fim++;
    return [i, fim];
  }
  return null;
}
const MAPA = (() => {
  const m = new Int16Array(256).fill(-1);
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < a.length; i++) m[a.charCodeAt(i)] = i;
  m[45] = 62; m[95] = 63; m[32] = 62;
  return m;
})();
function hex(c: number) { return c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1; }
function decodar(b: Uint8Array, ini: number, fim: number): Uint8Array {
  const s = new Uint8Array(Math.floor(((fim - ini) * 3) / 4) + 4);
  let n = 0, acc = 0, bits = 0;
  for (let i = ini; i < fim; i++) {
    let c = b[i];
    if (c === 37 && i + 2 < fim) { const a = hex(b[i + 1]), d = hex(b[i + 2]); if (a >= 0 && d >= 0) { c = (a << 4) | d; i += 2; } }
    if (c === 61) break;
    const v = MAPA[c];
    if (v < 0) continue;
    acc = ((acc << 6) | v) & 0xffffff; bits += 6;
    if (bits >= 8) { bits -= 8; s[n++] = (acc >> bits) & 255; }
  }
  return s.subarray(0, n);
}
function textoDe(b: Uint8Array, ini: number, fim: number) {
  const cru = new TextDecoder().decode(b.subarray(ini, fim)).replace(/\+/g, " ");
  try { return decodeURIComponent(cru); } catch { return cru; }
}
function chaveDoForm(b: Uint8Array) {
  const a = acharChave(b, "apikey");
  return a ? textoDe(b, a[0] + 7, a[1]).trim() : "";
}
function chaveDoJson(b: Uint8Array) {
  const m = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 4096))).match(/"apikey"\s*:\s*"([^"]*)"/);
  return m ? m[1].trim() : "";
}
function instante(v: string | null) {
  const n = Number(String(v ?? "").trim());
  if (!isFinite(n) || n <= 0) return null;
  const ms = n < 1e11 ? n * 1000 : n;
  return ms < 946684800000 || ms > Date.now() + 86400000 ? null : new Date(ms).toISOString();
}
function quandoDe(c: URLSearchParams) {
  const r = instante(c.get("received_time")), e = instante(c.get("event_time"));
  if (r && e && Math.abs(Date.parse(r) - Date.parse(e)) > DIA2) return e;
  if (r && !e && Math.abs(Date.parse(r) - Date.now()) > DIA2) return null;
  return r ?? e;
}
async function sha256(b: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", b as unknown as BufferSource))).map((x) => x.toString(16).padStart(2, "0")).join("");
}
const limpar = (v: string) => v.replace(/[^A-Za-z0-9]/g, "").slice(0, 10) || "bin";
const semToken = (v: string) => v.replace(/token=[^&\s"')]+/gi, "token=***");

function contatoDe(corpo: string) {
  try {
    const o = JSON.parse(corpo);
    const vc = String(o?.vcard ?? o?.contacts?.[0]?.vcard ?? "");
    const nome = String(o?.displayName ?? (vc.match(/FN:([^\n\r]+)/i)?.[1] ?? "")).trim();
    const tel = vc.match(/waid=(\d+)/i)?.[1] ?? "";
    return [nome, tel].filter(Boolean).join(" ") || corpo.slice(0, 500);
  } catch {
    const nome = corpo.match(/FN:([^\n\r]+)/i)?.[1]?.trim() ?? "";
    const tel = corpo.match(/waid=(\d+)/i)?.[1] ?? "";
    return [nome, tel].filter(Boolean).join(" ") || corpo.slice(0, 500);
  }
}
function chamadaDe(c: URLSearchParams, saida: boolean) {
  const video = (c.get("call_type") ?? "").toLowerCase() === "video";
  const dur = Number(c.get("call_duration") ?? "0") || 0;
  return `Chamada de ${video ? "vídeo" : "voz"} ${saida ? "feita" : "recebida"}${dur > 0 ? ` (${dur}s)` : " (não atendida)"}`;
}

const GW_SO_HTTP = new Set(["app.whatsgw.com.br", "pooling.whatsgw.com.br"]);
async function buscarGw(url: string, init: RequestInit) {
  const seguro = url.replace(/^http:\/\//i, "https://");
  try {
    return await fetch(seguro, init);
  } catch (e) {
    const host = new URL(seguro).host.toLowerCase();
    if (!GW_SO_HTTP.has(host) || !/\(Connect\)/.test(String((e as Error)?.message ?? ""))) throw e;
    return await fetch(seguro.replace(/^https:/i, "http:"), init);
  }
}
const DOMINIOS_MIDIA = ["whatsapp.net", "whatsapp.com", "fbcdn.net", "whatsgw.com.br", "kndtec.com.br"];
function linkPermitido(v: string) {
  try {
    const u = new URL(v);
    const h = u.hostname.toLowerCase();
    return u.protocol === "https:" && DOMINIOS_MIDIA.some((d) => h === d || h.endsWith("." + d));
  } catch { return false; }
}

// repasse
type Repasse = { ok: boolean; http: number; ms: number; resposta: string };
async function repassar(numero: string, bruto: Uint8Array, ct: string): Promise<Repasse | null> {
  const alvo = await sb.rpc("wa_gw_repasse_alvo", { p_numero: numero });
  if (alvo.error || !alvo.data) return null;
  const t0 = Date.now();
  try {
    const r = await fetch(String(alvo.data), {
      method: "POST", headers: { "Content-Type": ct || "application/x-www-form-urlencoded" }, body: bruto as unknown as BodyInit, signal: AbortSignal.timeout(15000),
    });
    const t = await r.text();
    return { ok: r.ok, http: r.status, ms: Date.now() - t0, resposta: semToken(t.slice(0, 200)) };
  } catch (e) {
    return { ok: false, http: 0, ms: Date.now() - t0, resposta: semToken(String((e as Error)?.message ?? e).slice(0, 200)) };
  }
}

// processar
async function fecharEvento(eventoId: number | null, ok: boolean, erro: string | null) {
  if (eventoId !== null) await sb.from("wa_webhook_evento").update({ processado_ok: ok, processado_em: new Date().toISOString(), erro }).eq("id", eventoId);
}

async function processar(numero: string, eventoId: number | null, campos: URLSearchParams, bruto: Uint8Array, regiao: [number, number] | null) {
  const fechar = (ok: boolean, erro: string | null) => fecharEvento(eventoId, ok, erro);
  try {
    const evento = (campos.get("event") ?? "").trim().toLowerCase();
    const estado = (campos.get("message_state") ?? "").trim().toLowerCase();
    const idProvedor = (campos.get("message_id") ?? "").trim();
    const waid = (campos.get("waid") ?? "").trim();
    const idLocal = (campos.get("message_custom_id") ?? "").trim();
    const quando = quandoDe(campos);

    if (evento === "phonestate") {
      const r = await sb.rpc("wa_gw_telefone", { p_numero: numero, p_estado: campos.get("state") ?? "", p_quando: quando ?? new Date().toISOString() });
      await fechar(r.data === true, r.data === true ? null : `telefone: ${r.error?.message ?? "estado desconhecido"}`);
      if ((campos.get("state") ?? "").toLowerCase() === "connected") await buscarEventos(numero);
      return;
    }
    if (evento === "status" || ESTADOS_ENVIO.has(estado)) {
      const r = await sb.rpc("wa_gw_status", {
        p_numero: numero, p_id_provedor: idProvedor || null, p_waid: waid || null, p_id_local: idLocal || null, p_estado: estado, p_quando: quando ?? new Date().toISOString(),
      });
      if (r.error) { await fechar(false, r.error.message); return; }
      await fechar(true, r.data === true ? null : `estado ${estado} de mensagem que não é deste sistema`);
      return;
    }

    const chatTipo = (campos.get("chat_type") ?? "").trim().toLowerCase();
    if (CHAT_IGNORADO.has(chatTipo)) { await fechar(true, `chat ${chatTipo} ignorado`); return; }
    const grupoBruto = (campos.get("group_id") ?? "").replace(/\D/g, "");
    const grupo = chatTipo === "group" || (!chatTipo && !!grupoBruto) ? grupoBruto : "";
    const telContato = (campos.get("contact_phone_number") ?? "").replace(/\D/g, "");
    const saida = estado === "sent" || /^(sent|send|outgoing)$/.test((campos.get("message_direction") ?? "").trim().toLowerCase());
    const direcao = saida ? "saida" : "entrada";
    const ctxTipo = (campos.get("context_type") ?? "0").trim();
    const ctxWaid = (campos.get("context_waid") ?? "").trim();
    const tipoBruto = (campos.get("message_type") ?? "").trim().toLowerCase();
    const corpoTexto = regiao ? "" : (campos.get("message_body") ?? "");

    if (estado === "deleted" || estado === "revoked" || (campos.get("additional_infos") ?? "").includes("REVOKE")) {
      let alvo = ctxWaid;
      try { alvo = String(JSON.parse(campos.get("additional_infos") ?? "{}")?.protocolMessage?.key?.id ?? "") || ctxWaid; } catch { alvo = (campos.get("additional_infos") ?? "").match(/"id"\s*:\s*"([^"]+)"/)?.[1] ?? ctxWaid; }
      const r = await sb.rpc("wa_gw_mudanca", { p_numero: numero, p: { tipo: "apagada", waid, contexto_waid: alvo, direcao, quando } });
      await fechar(!r.error, r.error?.message ?? (r.data === true ? null : "apagada: mensagem não encontrada"));
      return;
    }
    if (estado === "edited") {
      const novo = corpoTexto || (campos.get("message_caption") ?? "");
      const r = await sb.rpc("wa_gw_mudanca", { p_numero: numero, p: { tipo: "editada", waid, contexto_waid: ctxWaid, direcao, quando, texto: novo } });
      await fechar(!r.error, r.error?.message ?? (r.data === true ? null : "editada: mensagem não encontrada"));
      return;
    }
    if (tipoBruto === "react" || tipoBruto === "reaction" || ctxTipo === "1") {
      const r = await sb.rpc("wa_gw_mudanca", { p_numero: numero, p: { tipo: "reacao", contexto_waid: ctxWaid, direcao, emoji: corpoTexto.trim() } });
      await fechar(!r.error, r.error?.message ?? (r.data === true ? null : "reação: mensagem não encontrada"));
      return;
    }
    if (estado && estado !== "received" && estado !== "sent") { await fechar(true, `estado ${estado.slice(0, 30)} sem uso`); return; }

    const telefone = grupo || telContato;
    if (!telefone) { await fechar(false, "evento sem telefone"); return; }
    const tipo = TIPOS[tipoBruto] ?? (tipoBruto ? "sistema" : "texto");
    const ehMidia = MIDIAS.has(tipo);
    let texto = ehMidia ? "" : corpoTexto;
    if (tipo === "contato") texto = contatoDe(corpoTexto);
    if (tipoBruto === "call") texto = chamadaDe(campos, saida);
    const nome = (campos.get("contact_name") ?? "").trim();
    const r = await sb.rpc("wa_gw_receber", {
      p_numero: numero,
      p: {
        telefone, grupo: !!grupo, nome, tipo, direcao, texto, legenda: campos.get("message_caption") ?? "",
        id_whatsapp: waid || null, id_provedor: idProvedor || null, id_local: idLocal || null, quando,
        responder_a: ctxTipo === "2" && ctxWaid ? ctxWaid : null,
        autor_grupo: grupo && !saida ? (nome || telContato || null) : null,
        autor_telefone: grupo && !saida ? (telContato || null) : null,
        mime: campos.get("message_body_mimetype") ?? "", arquivo_nome: campos.get("message_body_filename") ?? campos.get("message_filename") ?? "",
      },
    });
    if (r.error) { await fechar(false, r.error.message); return; }
    if (!grupo && !saida && !r.data?.repetida) await pedirFotos(numero);
    if (grupo && r.data?.nova_conversa) await pedirGrupo(numero, grupo);
    const midia = r.data?.midia_id as string | undefined;
    if (!ehMidia || !midia) { await fechar(true, null); return; }
    const falha = async (erro: string, nota: string) => {
      await sb.rpc("wa_gw_midia_resultado", { p_midia: midia, p_ok: false, p_caminho: null, p_tamanho: null, p_sha256: null, p_erro: erro });
      await fechar(false, nota);
    };
    if (!regiao || regiao[1] <= regiao[0]) { await falha("arquivo chegou vazio", "midia sem conteudo"); return; }
    const inicio = textoDe(bruto, regiao[0], Math.min(regiao[1], regiao[0] + 24)).trim();
    let dados: Uint8Array;
    if (/^https?:\/\//i.test(inicio)) {
      const link = textoDe(bruto, regiao[0], Math.min(regiao[1], regiao[0] + 8192)).trim();
      try {
        if (!linkPermitido(link)) { await falha("link de arquivo fora dos domínios do provedor", "midia por link recusada"); return; }
        const b = await fetch(link, { redirect: "manual", signal: AbortSignal.timeout(60000) });
        const tam = Number(b.headers.get("content-length") ?? "0");
        if (!b.ok || tam > LIMITE) { await falha(b.ok ? "arquivo acima do limite" : `link respondeu ${b.status}`, "midia por link falhou"); return; }
        dados = new Uint8Array(await b.arrayBuffer());
        if (dados.length > LIMITE) { await falha("arquivo acima do limite", "midia acima do limite"); return; }
      } catch (e) {
        await falha("não foi possível baixar o link do arquivo", String((e as Error)?.name ?? e).slice(0, 100)); return;
      }
    } else {
      if (((regiao[1] - regiao[0]) * 3) / 4 > LIMITE) { await falha("arquivo acima do limite", "midia acima do limite"); return; }
      dados = decodar(bruto, regiao[0], regiao[1]);
    }
    if (!dados.length) { await falha("arquivo ilegível", "midia ilegivel"); return; }
    const mime = (campos.get("message_body_mimetype") ?? "application/octet-stream").split(";")[0].trim() || "application/octet-stream";
    const nomeArq = campos.get("message_body_filename") ?? "";
    const ext = limpar((campos.get("message_body_extension") ?? "").replace(/^\./, "") || (nomeArq.includes(".") ? nomeArq.split(".").pop()! : "") || mime.split("/")[1] || "");
    const caminho = `${r.data.conversa_id}/${r.data.mensagem_id}/${midia}.${ext}`;
    const up = await sb.storage.from("wa-midia").upload(caminho, dados, { contentType: mime, upsert: true });
    if (up.error) { await falha(up.error.message, "falha ao guardar o arquivo"); return; }
    const g = await sb.rpc("wa_gw_midia_resultado", { p_midia: midia, p_ok: true, p_caminho: caminho, p_tamanho: dados.length, p_sha256: await sha256(dados), p_erro: null });
    await fechar(g.data === true, g.data === true ? null : "midia guardada sem registro");
  } catch (e) {
    await fechar(false, String(e).slice(0, 500));
  }
}

// fotos
const FOTO_MAX = 5 * 1024 * 1024;
async function chamarGw(numero: string, metodo: string, corpo: Record<string, unknown>, base?: string) {
  const cred = await sb.rpc("wa_gw_credencial", { p_numero: numero });
  if (cred.error || !cred.data?.apikey || !cred.data?.telefone) return null;
  const raiz = (base ?? String(cred.data.base_url)).replace(/\/+$/, "");
  const r = await buscarGw(raiz + "/WhatsGw/" + metodo, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ apikey: cred.data.apikey, phone_number: String(cred.data.telefone).replace(/\D/g, ""), ...corpo }),
    signal: AbortSignal.timeout(20000),
  });
  return { r, telefone: String(cred.data.telefone).replace(/\D/g, "") };
}
async function pedirGrupo(numero: string, grupo: string) {
  try { await chamarGw(numero, "GroupMetadata", { data: { groupid: grupo } }); } catch { return; }
}
async function pedirFotos(numero: string) {
  try {
    const pode = await sb.rpc("wa_gw_foto_pedir", { p_numero: numero });
    if (pode.error || pode.data !== true) return;
    const cred = await sb.rpc("wa_gw_credencial", { p_numero: numero });
    if (cred.error || !cred.data?.apikey || !cred.data?.telefone) return;
    const alvo = String(cred.data.base_url).replace(/\/+$/, "") + "/WhatsGw/GetAllChats";
    await buscarGw(alvo, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ apikey: cred.data.apikey, phone_number: String(cred.data.telefone).replace(/\D/g, "") }),
      signal: AbortSignal.timeout(20000),
    });
  } catch { return; }
}
async function guardarFotos(numero: string, eventoId: number | null, corpo: Record<string, unknown>) {
  const fechar = (ok: boolean, erro: string | null) => fecharEvento(eventoId, ok, erro);
  try {
    const lista = Array.isArray(corpo.chats) ? corpo.chats as Record<string, any>[] : [];
    const links = new Map<string, string>();
    for (const c of lista) {
      const tel = String(c?.id ?? "").replace(/\D/g, "");
      const url = String(c?.contact?.profilePicThumbObj?.previewEurl ?? "");
      if (tel && linkPermitido(url)) links.set(tel, url);
    }
    if (!links.size) { await fechar(true, null); return; }
    const alvos = await sb.rpc("wa_gw_foto_alvos", { p_numero: numero, p_telefones: [...links.keys()] });
    if (alvos.error) { await fechar(false, alvos.error.message); return; }
    let feitas = 0, falhas = 0;
    for (const a of (alvos.data as { telefone: string; contato_id: string; conversa_id: string }[]).slice(0, 300)) {
      try {
        const r = await fetch(links.get(a.telefone)!, { redirect: "manual", signal: AbortSignal.timeout(15000) });
        const tipo = (r.headers.get("content-type") ?? "").toLowerCase();
        if (!r.ok || !tipo.startsWith("image/")) { falhas++; continue; }
        const img = new Uint8Array(await r.arrayBuffer());
        if (!img.length || img.length > FOTO_MAX) { falhas++; continue; }
        const caminho = `${a.conversa_id}/perfil.jpg`;
        const up = await sb.storage.from("wa-midia").upload(caminho, img, { contentType: "image/jpeg", upsert: true });
        if (up.error) { falhas++; continue; }
        const s = await sb.rpc("wa_gw_foto_salvar", { p_contato: a.contato_id, p_caminho: caminho });
        if (s.error || s.data !== true) { falhas++; continue; }
        feitas++;
      } catch (_) { falhas++; }
    }
    await fechar(falhas === 0, falhas ? `fotos: ${feitas} guardadas, ${falhas} falharam` : null);
  } catch (e) {
    await fechar(false, String(e).slice(0, 500));
  }
}

async function processarJson(numero: string, eventoId: number | null, bruto: Uint8Array) {
  let corpo: Record<string, any> = {};
  try { corpo = JSON.parse(new TextDecoder().decode(bruto)); } catch { await fecharEvento(eventoId, false, "json invalido"); return; }
  const ev = String(corpo.event ?? "").toLowerCase();
  if (ev === "chats") return guardarFotos(numero, eventoId, corpo);
  if (Array.isArray(corpo.groups) || (ev.includes("group") && (corpo.data?.subject || corpo.data?.name))) {
    const lista = Array.isArray(corpo.groups) ? corpo.groups : [{ id: corpo.data?.id ?? corpo.data?.groupid, name: corpo.data?.subject ?? corpo.data?.name }];
    const r = await sb.rpc("wa_gw_grupos_nomes", { p_numero: numero, p_lista: lista.map((g: any) => ({ id: String(g?.id ?? ""), name: String(g?.name ?? g?.subject ?? "") })) });
    await fecharEvento(eventoId, !r.error, r.error?.message ?? `grupos: ${r.data ?? 0} nomes`);
    return;
  }
  if (ev === "message_replay_done") {
    await fecharEvento(eventoId, true, null);
    await buscarEventos(numero);
    return;
  }
  if (ev === "account_health") {
    const r = await sb.rpc("wa_gw_saude", { p_numero: numero, p_dados: corpo.data ?? {} });
    await fecharEvento(eventoId, r.data === true, r.data === true ? null : "saude sem status");
    if (String(corpo.data?.source ?? "") === "open_check") await buscarEventos(numero);
    return;
  }
  if (ev === "phonestate") {
    const r = await sb.rpc("wa_gw_telefone", { p_numero: numero, p_estado: String(corpo.state ?? ""), p_quando: new Date().toISOString() });
    await fecharEvento(eventoId, r.data === true, r.data === true ? null : "telefone: estado desconhecido");
    if (String(corpo.state ?? "").toLowerCase() === "connected") await buscarEventos(numero);
    return;
  }
  await fecharEvento(eventoId, true, `evento ${ev.slice(0, 40) || "json"} sem uso`);
}

// entrada
let filaGrande: Promise<void> = Promise.resolve();
const rt = (globalThis as unknown as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;

function lerForm(bruto: Uint8Array) {
  let campos = new URLSearchParams();
  let regiao: [number, number] | null = null;
  const achado = acharChave(bruto, "message_body");
  const dec = new TextDecoder();
  if (achado) {
    const [ini, fim] = achado;
    regiao = [ini + "message_body=".length, fim];
    campos = new URLSearchParams(dec.decode(bruto.subarray(0, ini > 0 ? ini - 1 : 0)) + dec.decode(bruto.subarray(fim)));
    const t = (campos.get("message_type") ?? "").trim().toLowerCase();
    if (!MIDIAS.has(TIPOS[t] ?? t) && regiao[1] - regiao[0] <= GRANDE) { campos.set("message_body", textoDe(bruto, regiao[0], regiao[1])); regiao = null; }
  } else {
    campos = new URLSearchParams(dec.decode(bruto));
  }
  return { campos, regiao };
}
const ehCorpoJson = (b: Uint8Array) => {
  let i = 0;
  while (i < b.length && (b[i] === 32 || b[i] === 9 || b[i] === 10 || b[i] === 13)) i++;
  return b[i] === 123;
};

async function executar(numero: string, idEv: number | null, bruto: Uint8Array) {
  const cred = await sb.rpc("wa_gw_credencial", { p_numero: numero });
  const chave = String(cred.data?.apikey ?? "");
  const ej = ehCorpoJson(bruto);
  if (chave && (ej ? chaveDoJson(bruto) : chaveDoForm(bruto)) !== chave) return fecharEvento(idEv, false, "apikey do evento diferente da cadastrada");
  if (ej) return processarJson(numero, idEv, bruto);
  const { campos, regiao } = lerForm(bruto);
  return processar(numero, idEv, campos, bruto, regiao);
}

async function reprocessar(numero: string) {
  const l = await sb.rpc("wa_gw_reprocessar_lista", { p_numero: numero });
  if (l.error || !Array.isArray(l.data)) return;
  for (const e of l.data as { id: number; corpo: string }[]) {
    try { await executar(numero, e.id, new TextEncoder().encode(e.corpo)); } catch (_) { continue; }
  }
}

function ehPequeno(bruto: Uint8Array) {
  if (bruto.length > GRANDE) return false;
  if (ehCorpoJson(bruto)) return true;
  const { regiao } = lerForm(bruto);
  return !regiao;
}

async function receber(numero: string, bruto: Uint8Array, ct: string, nosso: boolean) {
  const rep = await repassar(numero, bruto, ct);
  if (!nosso) return rep;
  const pequeno = ehPequeno(bruto);
  const ev = await sb.from("wa_webhook_evento").insert({
    numero_id: numero, tipo: "whatsgw", bytes_corpo: bruto.length, tinha_midia: !pequeno, id_evento: null,
    corpo: pequeno ? new TextDecoder().decode(bruto) : null,
    repasse_http: rep?.http ?? null, repasse_ms: rep?.ms ?? null, repasse_resposta: rep?.resposta ?? null,
  }).select("id").maybeSingle();
  const idEv = ev.data?.id ?? null;
  const rodar = () => executar(numero, idEv, bruto).then(() => reprocessar(numero));
  let tarefa: Promise<void>;
  if (bruto.length > GRANDE) {
    tarefa = filaGrande.then(rodar);
    filaGrande = tarefa.catch(() => {});
  } else {
    tarefa = rodar();
  }
  if (rt?.waitUntil) rt.waitUntil(tarefa); else await tarefa;
  return rep;
}

async function buscarEventos(numero: string) {
  try {
    const pode = await sb.rpc("wa_gw_eventos_pode", { p_numero: numero });
    if (pode.error || pode.data !== true) return;
    const g = await chamarGw(numero, "GetEvents", {}, "https://pooling.whatsgw.com.br/api");
    if (!g || !g.r.ok) return;
    const j = await g.r.json().catch(() => null);
    const lista: unknown[] = Array.isArray(j) ? j : Array.isArray(j?.events) ? j.events : Array.isArray(j?.data) ? j.data : [];
    for (const item of lista) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const plano = Object.values(o).every((v) => v === null || typeof v !== "object");
      const corpo = plano
        ? new TextEncoder().encode(new URLSearchParams(Object.entries(o).map(([k, v]) => [k, v == null ? "" : String(v)])).toString())
        : new TextEncoder().encode(JSON.stringify(o));
      const meu = String(o.phone_number ?? "").replace(/\D/g, "") === g.telefone;
      await receber(numero, corpo, plano ? "application/x-www-form-urlencoded" : "application/json", meu);
    }
  } catch { return; }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false }, 405);
  const partes = new URL(req.url).pathname.split("/").filter(Boolean);
  const token = partes[partes.length - 1] ?? "";
  const n = await sb.rpc("wa_gw_webhook_numero", { p_token: token });
  if (n.error || !n.data) return json({ ok: false }, 401);
  const bruto = new Uint8Array(await req.arrayBuffer());
  const rep = await receber(n.data as string, bruto, req.headers.get("content-type") ?? "", true);
  if (rep && !rep.ok) return json({ ok: false }, 502);
  return json({ ok: true });
});
