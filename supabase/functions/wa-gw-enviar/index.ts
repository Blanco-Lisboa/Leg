import { createClient } from "npm:@supabase/supabase-js@2";

const URL_SB = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const sb = createClient(URL_SB, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const TIPO_GW: Record<string, string> = { texto: "text", imagem: "image", documento: "document", video: "video", audio: "audio" };
const EXT: Record<string, string> = {
  "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "audio/ogg": "ogg", "audio/mpeg": "mp3",
  "audio/mp4": "m4a", "application/zip": "zip", "application/xml": "xml", "text/xml": "xml", "text/plain": "txt",
};
const destinoGw = (d: string, grupo: boolean) => {
  const s = String(d).replace(/[^\d-]/g, "");
  return grupo && !s.includes("-") && s.length > 18 ? s.slice(0, -10) + "-" + s.slice(-10) : s;
};
const comExtensao = (nome: string, mime: string) => {
  const n = (nome || "arquivo").trim() || "arquivo";
  if (/\.[A-Za-z0-9]{1,8}$/.test(n)) return n;
  const e = EXT[mime.split(";")[0].trim().toLowerCase()] ?? mime.split("/")[1]?.replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  return e ? `${n}.${e}` : n;
};

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
// gateway
async function gateway(base: string, corpo: Record<string, unknown>, tempo: number) {
  const alvo = base.replace(/\/+$/, "") + "/WhatsGw/Send";
  const aborto = new AbortController();
  const relogio = setTimeout(() => aborto.abort(), tempo);
  try {
    const r = await buscarGw(alvo, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(corpo), signal: aborto.signal });
    const t = await r.text();
    let j: Record<string, unknown> | null = null;
    try { j = JSON.parse(t); } catch { j = null; }
    const motivo = String(j?.result_message ?? j?.message ?? j?.error ?? "").trim();
    if (!r.ok) return { ok: false, pendente: false, erro: (motivo || `WhatsGW respondeu ${r.status}`).slice(0, 300) };
    const res = String(j?.result ?? "").toLowerCase();
    const id = j?.message_id != null ? String(j.message_id) : null;
    const waid = j?.waid != null ? String(j.waid) : null;
    if (res === "success") return { ok: true, pendente: false, id, waid };
    if (res.includes("wait result on event") || motivo.toLowerCase().includes("wait result on event")) return { ok: false, pendente: true, id, waid };
    return { ok: false, pendente: false, erro: (motivo || String(j?.result ?? t)).slice(0, 300) };
  } catch (e) {
    const nome = (e as Error)?.name ?? "";
    if (nome === "AbortError" || nome === "TimeoutError") return { ok: false, pendente: true, erro: "O WhatsGW demorou para responder; aguarde a confirmação." };
    return { ok: false, pendente: false, erro: "Falha de rede com o WhatsGW." };
  } finally {
    clearTimeout(relogio);
  }
}

// envio
type Dados = { mensagem_id: string; numero_id: string; destino: string; grupo: boolean; arquivo_caminho?: string | null; mime?: string | null; nome?: string | null };
type Conteudo = { id_local: string; tipo: string; texto?: string | null; legenda?: string | null; responder_a?: string | null };

async function enviar(d: Dados, c: Conteudo) {
  const fim = async (ok: boolean, pendente: boolean, id: string | null, waid: string | null, erro: string | null) => {
    const g = await sb.rpc("wa_gw_resultado", { p_id_local: c.id_local, p_ok: ok, p_pendente: pendente, p_id_provedor: id, p_waid: waid, p_erro: erro });
    if (g.error || g.data !== true) console.error("resultado nao gravado", c.id_local, g.error?.message ?? "0 linhas");
  };
  const cred = await sb.rpc("wa_gw_credencial", { p_numero: d.numero_id });
  if (cred.error || !cred.data?.apikey || !cred.data?.telefone) {
    await fim(false, false, null, null, "O WhatsApp da Legalização ainda não foi ligado ao sistema.");
    return json({ ok: false, erro: "O WhatsApp da Legalização ainda não foi ligado ao sistema." }, 409);
  }
  const tipo = c.tipo || "texto";
  const pedido: Record<string, unknown> = {
    apikey: cred.data.apikey, phone_number: String(cred.data.telefone).replace(/\D/g, ""),
    contact_phone_number: destinoGw(String(d.destino), !!d.grupo), message_type: TIPO_GW[tipo] ?? "text", message_custom_id: c.id_local, check_status: "1",
  };
  if (d.grupo) pedido.message_to_group = 1;
  const citada = String(c.responder_a ?? "").trim();
  if (citada && !citada.startsWith("imp:")) pedido.quoted = { key: { id: citada } };
  let tempo = 20000;
  if (tipo === "texto") {
    pedido.message_body = c.texto ?? "";
    if (/https?:\/\/\S+/i.test(String(c.texto ?? ""))) pedido.preview_url = true;
  } else {
    const sg = await sb.storage.from("wa-midia").createSignedUrl(String(d.arquivo_caminho ?? ""), 900);
    if (sg.error || !sg.data?.signedUrl) { await fim(false, false, null, null, "Não foi possível preparar o arquivo."); return json({ ok: false, erro: "Não foi possível preparar o arquivo." }, 500); }
    pedido.message_body = sg.data.signedUrl;
    pedido.download = 1;
    pedido.message_caption = c.legenda ?? "";
    const mime = String(d.mime ?? "application/octet-stream");
    pedido.message_body_mimetype = mime;
    pedido.message_body_filename = comExtensao(String(d.nome ?? "arquivo"), mime);
    if (tipo === "audio") {
      delete pedido.message_caption;
      if (/ogg|opus/i.test(mime)) {
        pedido.message_type = "ptt";
        pedido.message_body_mimetype = "audio/ogg; codecs=opus";
        pedido.message_body_filename = String(pedido.message_body_filename).replace(/\.[A-Za-z0-9]{1,8}$/, "") + ".ogg";
      } else {
        pedido.message_type = "document";
      }
    }
    tempo = 120000;
  }
  const r = await gateway(String(cred.data.base_url), pedido, tempo);
  await fim(r.ok, r.pendente, r.id ?? null, r.waid ?? null, r.ok ? null : (r.erro ?? null));
  if (!r.ok && !r.pendente && /saldo/i.test(String(r.erro ?? ""))) {
    await sb.rpc("wa_gw_alertar", { p_numero: d.numero_id, p_tipo: "saldo", p_texto: "O WhatsGW recusou envio por saldo: " + String(r.erro).slice(0, 200), p_dados: null });
  }
  if (!r.ok && !r.pendente) return json({ ok: false, erro: r.erro ?? "O WhatsGW recusou o envio." }, 502);
  return json({ ok: true, mensagem_id: d.mensagem_id, incerto: r.pendente });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, erro: "metodo" }, 405);
  let p: { conversa_id?: string; id_local?: string; tipo?: string; texto?: string; legenda?: string; arquivo?: { caminho?: string; nome?: string }; responder_a?: string; fila_mensagem_id?: string };
  try { p = await req.json(); } catch { return json({ ok: false, erro: "corpo invalido" }, 400); }

  if (p.fila_mensagem_id) {
    const k = await sb.rpc("wa_gw_admin_chave_ok", { p_chave: req.headers.get("x-chave") ?? "" });
    if (k.error || k.data !== true) return json({ ok: false }, 401);
    const f = await sb.rpc("wa_gw_fila_dados", { p_msg: p.fila_mensagem_id });
    if (f.error || f.data?.ok !== true) return json({ ok: false, erro: f.data?.erro ?? "fila" }, 409);
    return await enviar(f.data as Dados, f.data as Conteudo);
  }

  const usuario = createClient(URL_SB, ANON, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } }, auth: { persistSession: false } });
  const prep = await usuario.rpc("wa_gw_preparar_envio", {
    p_conversa: p.conversa_id, p_id_local: p.id_local, p_tipo: p.tipo ?? "texto", p_texto: p.texto ?? null,
    p_legenda: p.legenda ?? null, p_arquivo: p.arquivo ?? null, p_responder_a: p.responder_a ?? null,
  });
  if (prep.error) return json({ ok: false, erro: "Não foi possível preparar o envio." }, 400);
  if (prep.data?.ok !== true) return json({ ok: false, erro: prep.data?.erro ?? "Envio recusado." }, 422);
  if (prep.data.na_fila === true) return json({ ok: true, mensagem_id: prep.data.mensagem_id, na_fila: true });
  return await enviar(prep.data as Dados, { id_local: String(p.id_local), tipo: p.tipo ?? "texto", texto: p.texto ?? null, legenda: p.legenda ?? null, responder_a: p.responder_a ?? null });
});
