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

// gateway
async function gateway(base: string, corpo: Record<string, unknown>, tempo: number) {
  const alvo = base.replace(/^http:\/\//i, "https://").replace(/\/+$/, "") + "/WhatsGw/Send";
  const aborto = new AbortController();
  const relogio = setTimeout(() => aborto.abort(), tempo);
  try {
    const r = await fetch(alvo, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(corpo), signal: aborto.signal });
    const t = await r.text();
    let j: Record<string, unknown> | null = null;
    try { j = JSON.parse(t); } catch { j = null; }
    if (!r.ok) return { ok: false, pendente: false, erro: `WhatsGW respondeu ${r.status}` };
    const res = String(j?.result ?? "").toLowerCase();
    const id = j?.message_id != null ? String(j.message_id) : null;
    const waid = j?.waid != null ? String(j.waid) : null;
    if (res === "success") return { ok: true, pendente: false, id, waid };
    if (res.includes("wait result on event")) return { ok: false, pendente: true, id, waid };
    return { ok: false, pendente: false, erro: String(j?.message ?? j?.error ?? j?.result ?? t).slice(0, 300) };
  } catch (e) {
    const nome = (e as Error)?.name ?? "";
    if (nome === "AbortError" || nome === "TimeoutError") return { ok: false, pendente: true, erro: "O WhatsGW demorou para responder; aguarde a confirmação." };
    return { ok: false, pendente: false, erro: "Falha de rede com o WhatsGW." };
  } finally {
    clearTimeout(relogio);
  }
}

// envio
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, erro: "metodo" }, 405);
  const usuario = createClient(URL_SB, ANON, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } }, auth: { persistSession: false } });
  let p: { conversa_id?: string; id_local?: string; tipo?: string; texto?: string; legenda?: string; arquivo?: { caminho?: string; nome?: string }; responder_a?: string };
  try { p = await req.json(); } catch { return json({ ok: false, erro: "corpo invalido" }, 400); }
  const prep = await usuario.rpc("wa_gw_preparar_envio", {
    p_conversa: p.conversa_id, p_id_local: p.id_local, p_tipo: p.tipo ?? "texto", p_texto: p.texto ?? null,
    p_legenda: p.legenda ?? null, p_arquivo: p.arquivo ?? null, p_responder_a: p.responder_a ?? null,
  });
  if (prep.error) return json({ ok: false, erro: "Não foi possível preparar o envio." }, 400);
  if (prep.data?.ok !== true) return json({ ok: false, erro: prep.data?.erro ?? "Envio recusado." }, 422);
  const d = prep.data;
  const fim = (ok: boolean, pendente: boolean, id: string | null, waid: string | null, erro: string | null) =>
    sb.rpc("wa_gw_resultado", { p_id_local: p.id_local, p_ok: ok, p_pendente: pendente, p_id_provedor: id, p_waid: waid, p_erro: erro });
  const cred = await sb.rpc("wa_gw_credencial", { p_numero: d.numero_id });
  if (cred.error || !cred.data?.apikey || !cred.data?.telefone) {
    await fim(false, false, null, null, "O WhatsApp da Legalização ainda não foi ligado ao sistema.");
    return json({ ok: false, erro: "O WhatsApp da Legalização ainda não foi ligado ao sistema." }, 409);
  }
  const pedido: Record<string, unknown> = {
    apikey: cred.data.apikey, phone_number: String(cred.data.telefone).replace(/\D/g, ""),
    contact_phone_number: String(d.destino).replace(/\D/g, ""), message_type: TIPO_GW[p.tipo ?? "texto"] ?? "text", message_custom_id: p.id_local,
  };
  let tempo = 20000;
  if ((p.tipo ?? "texto") === "texto") {
    pedido.message_body = p.texto;
  } else {
    const sg = await sb.storage.from("wa-midia").createSignedUrl(d.arquivo_caminho, 900);
    if (sg.error || !sg.data?.signedUrl) { await fim(false, false, null, null, "Não foi possível preparar o arquivo."); return json({ ok: false, erro: "Não foi possível preparar o arquivo." }, 500); }
    pedido.message_body = sg.data.signedUrl;
    pedido.download = 1;
    pedido.message_caption = p.legenda ?? "";
    pedido.message_body_mimetype = d.mime ?? "application/octet-stream";
    pedido.message_body_filename = d.nome ?? "arquivo";
    tempo = 120000;
  }
  const r = await gateway(String(cred.data.base_url), pedido, tempo);
  await fim(r.ok, r.pendente, r.id ?? null, r.waid ?? null, r.ok ? null : (r.erro ?? null));
  if (!r.ok && !r.pendente) return json({ ok: false, erro: r.erro ?? "O WhatsGW recusou o envio." }, 502);
  return json({ ok: true, mensagem_id: d.mensagem_id, incerto: r.pendente });
});
