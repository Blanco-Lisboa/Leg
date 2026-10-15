import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const CONVERSOR = "https://conversor.it-ia.tec.br/transcrever";
const CHAVE = Deno.env.get("CONVERSOR_BILLY_CHAVE") ?? Deno.env.get("conversor_billy_chave") ?? "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMITE = 25 * 1024 * 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function extensao(mime: string | null, caminho: string): string {
  const m = (mime ?? "").toLowerCase();
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("wav")) return "wav";
  const p = caminho.split("?")[0].split(".").pop() ?? "";
  return /^[a-z0-9]{2,4}$/i.test(p) ? p.toLowerCase() : "ogg";
}

async function salvar(id: string, texto: string | null, erro: string | null) {
  const r = await admin.rpc("wa_midia_transcricao_salvar", { p_midia_id: id, p_texto: texto, p_erro: erro });
  if (r.error) console.error("salvar", r.error.message);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false }, 405);
  const conf = await admin.rpc("wa_transcrever_chave_ok", { p_chave: req.headers.get("x-chave-interna") ?? "" });
  if (conf.error || conf.data !== true) return json({ ok: false }, 401);
  if (!CHAVE) return json({ ok: false, erro: "transcritor sem chave" }, 500);
  let corpo: { midia_id?: string };
  try { corpo = await req.json(); } catch { return json({ ok: false }, 400); }
  const id = String(corpo.midia_id ?? "");
  if (!UUID.test(id)) return json({ ok: false }, 400);

  const m = await admin.from("wa_midia").select("id,tipo,estado,caminho,mimetype,transcricao").eq("id", id).maybeSingle();
  if (m.error || !m.data) return json({ ok: false, erro: "midia nao encontrada" }, 404);
  const md = m.data;
  if (md.tipo !== "audio" || md.estado !== "guardado" || !md.caminho) return json({ ok: false, erro: "nao e audio guardado" }, 409);
  if (md.transcricao) return json({ ok: true, repetida: true });

  let audio: Blob;
  try {
    const d = await admin.storage.from("wa-midia").download(md.caminho);
    if (d.error || !d.data) throw new Error("storage " + (d.error?.message ?? ""));
    audio = d.data;
  } catch (e) {
    await salvar(id, null, "nao baixou o audio: " + String(e));
    return json({ ok: false, erro: "nao baixou o audio" }, 502);
  }
  if (audio.size > LIMITE) {
    await salvar(id, null, "audio acima de 25 MB");
    return json({ ok: false, erro: "audio grande demais" }, 413);
  }

  const form = new FormData();
  form.append("arquivo", new File([audio], "audio." + extensao(md.mimetype, md.caminho), { type: md.mimetype || "audio/ogg" }));
  let texto = "";
  try {
    const r = await fetch(CONVERSOR, { method: "POST", headers: { "x-chave": CHAVE }, body: form, signal: AbortSignal.timeout(120000) });
    const corpoResp = await r.text();
    if (!r.ok) throw new Error("conversor " + r.status + " " + corpoResp.slice(0, 200));
    let j: Record<string, unknown> = {};
    try { j = JSON.parse(corpoResp); } catch { j = { texto: corpoResp }; }
    texto = String(j.texto ?? j.text ?? j.transcricao ?? "").trim();
  } catch (e) {
    await salvar(id, null, String(e));
    return json({ ok: false, erro: "transcritor falhou" }, 502);
  }
  await salvar(id, texto, null);
  return json({ ok: true });
});
