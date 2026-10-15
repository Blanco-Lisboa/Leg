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
async function gateway(base: string, metodo: string, corpo: Record<string, unknown>, formulario = false) {
  const alvo = base.replace(/\/+$/, "") + "/WhatsGw/" + metodo;
  try {
    const form = new URLSearchParams();
    if (formulario) for (const [k, v] of Object.entries(corpo)) form.set(k, String(v));
    const r = await buscarGw(alvo, {
      method: "POST", headers: { "Content-Type": formulario ? "application/x-www-form-urlencoded" : "application/json", Accept: "application/json" },
      body: formulario ? form.toString() : JSON.stringify(corpo), signal: AbortSignal.timeout(20000),
    });
    const t = await r.text();
    let j: Record<string, unknown> | null = null;
    try { j = JSON.parse(t); } catch { j = null; }
    const res = String(j?.result ?? "").toLowerCase();
    const motivo = String(j?.result_message ?? "").toLowerCase();
    if (r.ok && res === "success") return { ok: true, pendente: false };
    if (r.ok && (res.includes("wait result on event") || motivo.includes("wait result on event"))) return { ok: true, pendente: true };
    return { ok: false, erro: String(j?.result_message ?? j?.message ?? `WhatsGW respondeu ${r.status}`).slice(0, 300) };
  } catch (e) {
    const nome = (e as Error)?.name ?? "";
    if (nome === "AbortError" || nome === "TimeoutError") return { ok: false, erro: "O WhatsGW demorou para responder." };
    return { ok: false, erro: "Falha de rede com o WhatsGW." };
  }
}

type Pedido = { acao?: string; conversa_id?: string; mensagem_id?: string; emoji?: string; texto?: string };

// acoes
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, erro: "metodo" }, 405);
  const usuario = createClient(URL_SB, ANON, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } }, auth: { persistSession: false } });
  let p: Pedido;
  try { p = await req.json(); } catch { return json({ ok: false, erro: "corpo invalido" }, 400); }
  if (!p.conversa_id || !p.acao) return json({ ok: false, erro: "falta a conversa" }, 400);
  if (p.acao === "digitando") return json({ ok: true, sem_aviso: true });

  const prep = await usuario.rpc("wa_gw_acao_preparar", {
    p_acao: p.acao, p_conversa: p.conversa_id, p_mensagem: p.mensagem_id ?? null, p_texto: p.texto ?? null,
  });
  if (prep.error) return json({ ok: false, erro: "Não foi possível preparar." }, 400);
  const d = prep.data;
  if (d?.ok !== true) return json(d ?? { ok: false }, 403);

  const fim = async (dados: Record<string, unknown> = {}) => {
    const g = await sb.rpc("wa_gw_acao_resultado", { p_acao: p.acao, p_conversa: p.conversa_id, p_mensagem: p.mensagem_id ?? null, p_dados: dados });
    if (g.error || g.data !== true) throw new Error("registro: " + (g.error?.message ?? "nada mudou"));
  };

  try {
    if (p.acao === "lida") {
      await fim();
      return json({ ok: true, so_no_sistema: true });
    }

    const cred = await sb.rpc("wa_gw_credencial", { p_numero: d.numero_id });
    if (cred.error || !cred.data?.apikey || !cred.data?.telefone) return json({ ok: false, erro: "O WhatsApp da Legalização ainda não foi ligado ao sistema." }, 409);
    const base = String(cred.data.base_url);
    const origem = String(cred.data.telefone).replace(/\D/g, "");
    const bruto = String(d.destino ?? "").replace(/[^\d-]/g, "");
    const destino = d.grupo && !bruto.includes("-") && bruto.length > 18 ? bruto.slice(0, -10) + "-" + bruto.slice(-10) : bruto;
    const envio = (extra: Record<string, unknown>) => ({
      apikey: cred.data.apikey, phone_number: origem, contact_phone_number: destino,
      message_custom_id: crypto.randomUUID(), message_type: "text", check_status: "1", ...(d.grupo ? { message_to_group: 1 } : {}), ...extra,
    });
    let r;

    switch (p.acao) {
      case "reagir": {
        const emoji = String(p.emoji ?? "").trim();
        if ([...emoji].length > 16) return json({ ok: false, erro: "emoji invalido" }, 400);
        r = await gateway(base, "Send", envio({ message_body: emoji || " ", "react.key.id": d.waid }), true);
        if (!r.ok) return json({ ok: false, erro: r.erro }, 422);
        await fim({ emoji });
        return json({ ok: true });
      }
      case "editar": {
        const texto = String(p.texto ?? "");
        r = await gateway(base, "Send", envio({ message_body: texto, edit: { key: { id: d.waid } } }));
        if (!r.ok) return json({ ok: false, erro: r.erro }, 422);
        await fim({ texto });
        return json({ ok: true });
      }
      case "apagar": {
        r = await gateway(base, "DeleteMessage", { apikey: cred.data.apikey, phone_number: origem, message_id: d.id_provedor });
        if (!r.ok) return json({ ok: false, erro: r.erro }, 422);
        if (r.pendente) return json({ ok: true, pendente: true });
        const eu = await usuario.auth.getUser();
        await fim({ por: eu.data.user?.id ?? null });
        return json({ ok: true });
      }
    }
    return json({ ok: false, erro: "acao invalida" }, 400);
  } catch (e) {
    console.error("acao", p.acao, (e as Error).message);
    return json({ ok: false, erro: "falha ao falar com o WhatsGW" }, 502);
  }
});
