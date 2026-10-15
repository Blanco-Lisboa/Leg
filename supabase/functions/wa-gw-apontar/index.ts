import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const CAMPOS_CONFIG = ["description", "use_store", "auto_chats", "auto_groups", "mark_read", "w_event_message", "w_event_message_group", "w_event_status", "w_event_message_out"];
const NOSSO = "ynqcmzukahkmqbvirlkb.supabase.co";

type Cred = { base_url: string; apikey: string; telefone: string };

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
async function gw(cred: Cred, metodo: string, corpo: Record<string, unknown>) {
  const alvo = String(cred.base_url).replace(/\/+$/, "") + "/WhatsGw/" + metodo;
  try {
    const r = await buscarGw(alvo, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ apikey: cred.apikey, ...corpo }), signal: AbortSignal.timeout(20000),
    });
    const t = await r.text();
    let j: Record<string, any> | null = null;
    try { j = JSON.parse(t); } catch { j = null; }
    return { http: r.status, j };
  } catch (e) {
    return { http: 0, j: { result: "fail", result_message: String((e as Error)?.name ?? "rede") } };
  }
}

function descrever(url: string) {
  if (!url) return { definido: false };
  try {
    const u = new URL(url);
    return {
      definido: true, host: u.host, caminho: u.pathname, tem_token: u.searchParams.has("token") || u.pathname.split("/").filter(Boolean).length > 3,
      eh_legado: u.host === "uvmcfnghdsmpzhijqlos.supabase.co" && u.pathname === "/functions/v1/wa-webhook",
      eh_nosso: u.host === NOSSO,
    };
  } catch {
    return { definido: true, invalido: true };
  }
}

async function lerInstancia(cred: Cred, inst: string) {
  const r = await gw(cred, "GetInstance", { w_instancia_id: Number(inst) || inst });
  const d = r.j?.data ?? null;
  const cfg = (d?.config ?? {}) as Record<string, unknown>;
  return { http: r.http, result: String(r.j?.result ?? ""), motivo: String(r.j?.result_message ?? ""), dados: d, config: cfg, webhook: String(cfg.webhook_url ?? "") };
}

async function lerTelefone(cred: Cred, inst: string) {
  const r = await gw(cred, "PhoneList", {});
  const lista = Array.isArray(r.j) ? r.j : [];
  const f = lista.find((x: Record<string, unknown>) => String(x?.phone_number ?? "") === String(cred.telefone ?? "") && String(x?.w_instancia_id ?? "") === String(inst)) ?? null;
  return { http: r.http, achou: !!f, descricao: String(f?.description ?? ""), status: f?.status ?? null, webhook: String(f?.webhook_url ?? "") };
}

async function trocarWebhookTelefone(cred: Cred, inst: string, descricao: string, url: string) {
  return await gw(cred, "PhoneUpdate", { phone_number: String(cred.telefone ?? ""), w_instancia_id: Number(inst) || inst, description: descricao, webhook: { url } });
}

function resumoTel(t: Awaited<ReturnType<typeof lerTelefone>>) {
  return { http: t.http, achou: t.achou, status: t.status, webhook: descrever(t.webhook) };
}

function resumo(l: Awaited<ReturnType<typeof lerInstancia>>) {
  const cfg: Record<string, unknown> = {};
  for (const k of CAMPOS_CONFIG) if (k in l.config) cfg[k] = l.config[k];
  return {
    http: l.http, result: l.result, motivo: l.motivo, status: l.dados?.status ?? null, numero: l.dados?.number ?? null, tipo: l.dados?.type ?? null,
    config: cfg, chaves_config: Object.keys(l.config), webhook: descrever(l.webhook),
  };
}

// acoes
Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false }, 405);
  const ok = await sb.rpc("wa_gw_admin_chave_ok", { p_chave: req.headers.get("x-chave") ?? "" });
  if (ok.error || ok.data !== true) return json({ ok: false }, 401);
  let p: { acao?: string; numero_id?: string };
  try { p = await req.json(); } catch { return json({ ok: false, erro: "corpo" }, 400); }
  if (!p.numero_id) return json({ ok: false, erro: "numero" }, 400);
  const num = await sb.from("wa_numero").select("identificador, telefone, provedor").eq("id", p.numero_id).maybeSingle();
  if (num.error || !num.data || num.data.provedor !== "whatsgw") return json({ ok: false, erro: "numero nao e WhatsGW" }, 400);
  const inst = String(num.data.identificador ?? "");
  const c = await sb.rpc("wa_gw_credencial", { p_numero: p.numero_id });
  if (c.error || !c.data?.apikey) return json({ ok: false, erro: "sem a chave wa_gw_apikey no cofre" }, 409);
  const cred = c.data as Cred;

  if (p.acao === "ler") {
    const l = await lerInstancia(cred, inst);
    const t = await lerTelefone(cred, inst);
    let guardado = false;
    const d = descrever(t.webhook) as Record<string, unknown>;
    if (d.definido && !d.eh_nosso && !d.invalido) {
      const g = await sb.rpc("wa_gw_webhook_antigo_guardar", { p_numero: p.numero_id, p_url: t.webhook });
      guardado = g.data === true;
    }
    return json({ ok: l.result === "success" && t.achou, instancia: resumo(l), telefone: resumoTel(t), antigo_guardado: guardado });
  }

  if (p.acao === "apontar") {
    const l = await lerTelefone(cred, inst);
    if (!l.achou) return json({ ok: false, erro: "telefone nao encontrado no PhoneList; nada foi trocado", telefone: resumoTel(l) }, 502);
    const d = descrever(l.webhook) as Record<string, unknown>;
    if (d.eh_nosso) return json({ ok: true, ja_apontado: true, telefone: resumoTel(l) });
    if (!d.definido || d.invalido) return json({ ok: false, erro: "webhook atual vazio ou invalido; sem destino para o repasse; nada foi trocado" }, 409);
    const g = await sb.rpc("wa_gw_webhook_antigo_guardar", { p_numero: p.numero_id, p_url: l.webhook });
    if (g.data !== true) return json({ ok: false, erro: "nao guardou o webhook antigo; nada foi trocado" }, 500);
    const lg = await sb.rpc("wa_gw_repasse_ligar", { p_numero: p.numero_id, p_ligar: true });
    if (lg.data !== true) return json({ ok: false, erro: "nao ligou o repasse; nada foi trocado" }, 500);
    const v = await sb.rpc("wa_gw_preparar_virada", { p_numero: p.numero_id });
    const nosso = String(v.data?.webhook ?? "");
    if (!nosso) return json({ ok: false, erro: "sem endereco nosso" }, 500);
    const marco = new Date().toISOString();
    const teste = await fetch(nosso, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "history_progress", apikey: cred.apikey, phone_number: String(cred.telefone ?? ""), w_instancia_id: Number(inst) || inst, data: { progress: 0, isLatest: false, done: false, teste_repasse: true } }),
      signal: AbortSignal.timeout(30000),
    }).then((r) => r.status).catch(() => 0);
    const ev = await sb.from("wa_webhook_evento").select("repasse_http, repasse_resposta").eq("numero_id", p.numero_id).gte("recebido_em", marco)
      .order("id", { ascending: false }).limit(1).maybeSingle();
    const http = Number(ev.data?.repasse_http ?? 0);
    const resp = String(ev.data?.repasse_resposta ?? "");
    if (teste !== 200 || http < 200 || http > 299 || !/"recebido"\s*:\s*true/.test(resp)) {
      await sb.rpc("wa_gw_repasse_ligar", { p_numero: p.numero_id, p_ligar: false });
      return json({ ok: false, erro: "teste do repasse para o Tauri falhou; nada foi trocado", teste_http: teste, repasse_http: http, repasse_resposta: resp }, 502);
    }
    await sb.rpc("wa_gw_repasse_testado", { p_numero: p.numero_id });
    const t = await trocarWebhookTelefone(cred, inst, l.descricao, nosso);
    const depois = await lerTelefone(cred, inst);
    if (depois.webhook !== nosso) {
      const volta = await trocarWebhookTelefone(cred, inst, l.descricao, l.webhook);
      const conf = await lerTelefone(cred, inst);
      return json({
        ok: false, erro: "o WhatsGW nao gravou o endereco novo; voltei o antigo",
        troca: { http: t.http, result: t.j?.result, motivo: t.j?.result_message }, volta: { http: volta.http, result: volta.j?.result },
        antigo_de_volta: conf.webhook === l.webhook,
      }, 502);
    }
    await sb.rpc("wa_gw_virada_marcar", { p_numero: p.numero_id, p_ligada: true });
    return json({ ok: true, teste_repasse: { http, resposta: resp }, telefone: resumoTel(depois) });
  }

  if (p.acao === "voltar") {
    const a = await sb.rpc("wa_gw_webhook_antigo", { p_numero: p.numero_id });
    const antigo = String(a.data ?? "");
    if (!antigo) return json({ ok: false, erro: "sem webhook antigo guardado" }, 409);
    const l = await lerTelefone(cred, inst);
    if (!l.achou) return json({ ok: false, erro: "telefone nao encontrado no PhoneList", telefone: resumoTel(l) }, 502);
    const t = await trocarWebhookTelefone(cred, inst, l.descricao, antigo);
    const depois = await lerTelefone(cred, inst);
    const voltou = depois.webhook === antigo;
    if (voltou) await sb.rpc("wa_gw_virada_marcar", { p_numero: p.numero_id, p_ligada: false });
    return json({ ok: voltou, troca: { http: t.http, result: t.j?.result, motivo: t.j?.result_message }, telefone: resumoTel(depois) }, voltou ? 200 : 502);
  }

  return json({ ok: false, erro: "acao" }, 400);
});
