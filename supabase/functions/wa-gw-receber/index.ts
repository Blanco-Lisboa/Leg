import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

const ESTADOS = new Set(["delivered2server", "delivered2user", "read", "played", "notwa", "notsent"]);
const TIPOS: Record<string, string> = { text: "texto", chat: "texto", image: "imagem", document: "documento", video: "video", audio: "audio", ptt: "audio", sticker: "figurinha" };
const MIDIAS = new Set(["imagem", "documento", "video", "audio", "figurinha"]);
const LIMITE = 110 * 1024 * 1024;

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
const MAPA = (() => { const m = new Int16Array(256).fill(-1); const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; for (let i = 0; i < a.length; i++) m[a.charCodeAt(i)] = i; return m; })();
function hex(c: number) { return c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1; }
function decodar(b: Uint8Array, ini: number, fim: number): Uint8Array {
  const s = new Uint8Array(Math.floor(((fim - ini) * 3) / 4) + 4);
  let n = 0, acc = 0, bits = 0;
  for (let i = ini; i < fim; i++) {
    let c = b[i];
    if (c === 37 && i + 2 < fim) { const a = hex(b[i + 1]), d = hex(b[i + 2]); if (a >= 0 && d >= 0) { c = (a << 4) | d; i += 2; } }
    const v = MAPA[c];
    if (v < 0) continue;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; s[n++] = (acc >> bits) & 255; }
  }
  return s.subarray(0, n);
}
function textoDe(b: Uint8Array, ini: number, fim: number) {
  const cru = new TextDecoder().decode(b.subarray(ini, fim)).replace(/\+/g, " ");
  try { return decodeURIComponent(cru); } catch { return cru; }
}
function instante(v: string | null) {
  const n = Number(String(v ?? "").trim());
  if (!isFinite(n) || n <= 0) return null;
  const ms = n < 1e11 ? n * 1000 : n;
  return ms < 946684800000 || ms > Date.now() + 86400000 ? null : new Date(ms).toISOString();
}
async function sha256(b: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", b))).map((x) => x.toString(16).padStart(2, "0")).join("");
}
const limpar = (v: string) => v.replace(/[^A-Za-z0-9]/g, "").slice(0, 10) || "bin";

// processar
async function processar(numero: string, eventoId: number | null, campos: URLSearchParams, bruto: Uint8Array, regiao: [number, number] | null) {
  const fechar = async (ok: boolean, erro: string | null) => {
    if (eventoId !== null) await sb.from("wa_webhook_evento").update({ processado_ok: ok, processado_em: new Date().toISOString(), erro }).eq("id", eventoId);
  };
  try {
    const estado = (campos.get("message_state") ?? "").trim().toLowerCase();
    const idProvedor = (campos.get("message_id") ?? "").trim();
    const waid = (campos.get("waid") ?? "").trim();
    const quando = instante(campos.get("received_time")) ?? instante(campos.get("event_time"));
    if (ESTADOS.has(estado)) {
      const r = await sb.rpc("wa_gw_status", { p_id_provedor: idProvedor || null, p_waid: waid || null, p_estado: estado, p_quando: quando ?? new Date().toISOString() });
      await fechar(r.data === true, r.data === true ? null : `estado ${estado} sem mensagem`);
      return;
    }
    const tipoBruto = (campos.get("message_type") ?? "").trim().toLowerCase();
    const tipo = TIPOS[tipoBruto] ?? (tipoBruto ? "sistema" : "texto");
    const grupo = (campos.get("group_id") ?? "").replace(/\D/g, "");
    const telefone = grupo || (campos.get("contact_phone_number") ?? "").replace(/\D/g, "");
    if (!telefone) { await fechar(false, "evento sem telefone"); return; }
    const ehMidia = MIDIAS.has(tipo);
    const legenda = campos.get("message_caption") ?? "";
    const evento = campos.get("event") ?? "";
    const r = await sb.rpc("wa_gw_receber", {
      p_numero: numero,
      p: {
        telefone, grupo: !!grupo, nome: campos.get("contact_name") ?? "", tipo,
        direcao: /sent|send|fromme/i.test(evento) ? "saida" : "entrada",
        texto: ehMidia ? "" : (campos.get("message_body") ?? ""), legenda,
        id_whatsapp: waid || null, id_provedor: idProvedor || null, quando,
        autor_grupo: grupo ? (campos.get("contact_name") ?? "") : null,
        mime: campos.get("message_body_mimetype") ?? "", arquivo_nome: campos.get("message_body_filename") ?? "",
      },
    });
    if (r.error) { await fechar(false, r.error.message); return; }
    if (!grupo && !r.data?.repetida && !/sent|send|fromme/i.test(evento)) await pedirFotos(numero);
    const midia = r.data?.midia_id as string | undefined;
    if (!ehMidia || !midia) { await fechar(true, null); return; }
    if (!regiao || regiao[1] <= regiao[0]) {
      await sb.rpc("wa_gw_midia_resultado", { p_midia: midia, p_ok: false, p_caminho: null, p_tamanho: null, p_sha256: null, p_erro: "arquivo chegou vazio" });
      await fechar(false, "midia sem conteudo");
      return;
    }
    if (((regiao[1] - regiao[0]) * 3) / 4 > LIMITE) {
      await sb.rpc("wa_gw_midia_resultado", { p_midia: midia, p_ok: false, p_caminho: null, p_tamanho: null, p_sha256: null, p_erro: "arquivo acima do limite" });
      await fechar(false, "midia acima do limite");
      return;
    }
    const dados = decodar(bruto, regiao[0], regiao[1]);
    const mime = (campos.get("message_body_mimetype") ?? "application/octet-stream").split(";")[0].trim() || "application/octet-stream";
    const ext = limpar((campos.get("message_body_extension") ?? "").replace(/^\./, ""));
    const caminho = `${r.data.conversa_id}/${r.data.mensagem_id}/${midia}.${ext}`;
    const up = await sb.storage.from("wa-midia").upload(caminho, dados, { contentType: mime, upsert: true });
    if (up.error) {
      await sb.rpc("wa_gw_midia_resultado", { p_midia: midia, p_ok: false, p_caminho: null, p_tamanho: null, p_sha256: null, p_erro: up.error.message });
      await fechar(false, "falha ao guardar o arquivo");
      return;
    }
    await sb.rpc("wa_gw_midia_resultado", { p_midia: midia, p_ok: true, p_caminho: caminho, p_tamanho: dados.length, p_sha256: await sha256(dados), p_erro: null });
    await fechar(true, null);
  } catch (e) {
    await fechar(false, String(e).slice(0, 500));
  }
}

// fotos
const FOTO_MAX = 5 * 1024 * 1024;
async function pedirFotos(numero: string) {
  try {
    const pode = await sb.rpc("wa_gw_foto_pedir", { p_numero: numero });
    if (pode.error || pode.data !== true) return;
    const cred = await sb.rpc("wa_gw_credencial", { p_numero: numero });
    if (cred.error || !cred.data?.apikey || !cred.data?.telefone) return;
    const alvo = String(cred.data.base_url).replace(/^http:\/\//i, "https://").replace(/\/+$/, "") + "/WhatsGw/GetAllChats";
    await fetch(alvo, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ apikey: cred.data.apikey, phone_number: String(cred.data.telefone).replace(/\D/g, "") }),
      signal: AbortSignal.timeout(20000),
    });
  } catch { return; }
}
async function guardarFotos(numero: string, eventoId: number | null, corpo: Record<string, unknown>) {
  const fechar = async (ok: boolean, erro: string | null) => {
    if (eventoId !== null) await sb.from("wa_webhook_evento").update({ processado_ok: ok, processado_em: new Date().toISOString(), erro }).eq("id", eventoId);
  };
  try {
    const lista = Array.isArray(corpo.chats) ? corpo.chats as Record<string, any>[] : [];
    const links = new Map<string, string>();
    for (const c of lista) {
      const tel = String(c?.id ?? "").replace(/\D/g, "");
      const url = String(c?.contact?.profilePicThumbObj?.previewEurl ?? "");
      if (tel && /^https:\/\//i.test(url)) links.set(tel, url);
    }
    if (!links.size) { await fechar(true, null); return; }
    const alvos = await sb.rpc("wa_gw_foto_alvos", { p_numero: numero, p_telefones: [...links.keys()] });
    if (alvos.error) { await fechar(false, alvos.error.message); return; }
    let feitas = 0, falhas = 0;
    for (const a of (alvos.data as { telefone: string; contato_id: string; conversa_id: string }[]).slice(0, 300)) {
      try {
        const r = await fetch(links.get(a.telefone)!, { signal: AbortSignal.timeout(15000) });
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

// entrada
Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false }, 405);
  const partes = new URL(req.url).pathname.split("/").filter(Boolean);
  const token = partes[partes.length - 1] ?? "";
  const n = await sb.rpc("wa_gw_webhook_numero", { p_token: token });
  if (n.error || !n.data) return json({ ok: false }, 401);
  const numero = n.data as string;
  const bruto = new Uint8Array(await req.arrayBuffer());
  const rt = (globalThis as unknown as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
  let i0 = 0;
  while (i0 < bruto.length && (bruto[i0] === 32 || bruto[i0] === 9 || bruto[i0] === 10 || bruto[i0] === 13)) i0++;
  if (bruto[i0] === 123) {
    let corpo: Record<string, unknown> = {};
    try { corpo = JSON.parse(new TextDecoder().decode(bruto)); } catch { corpo = {}; }
    const tipoEv = String(corpo.event ?? "");
    const evj = await sb.from("wa_webhook_evento").insert({ numero_id: numero, tipo: "whatsgw", bytes_corpo: bruto.length, tinha_midia: false, id_evento: null }).select("id").maybeSingle();
    const idEv = evj.data?.id ?? null;
    const tarefaJson = tipoEv === "chats"
      ? guardarFotos(numero, idEv, corpo)
      : (idEv !== null ? sb.from("wa_webhook_evento").update({ processado_ok: true, processado_em: new Date().toISOString(), erro: `evento ${tipoEv.slice(0, 40) || "json"} sem uso` }).eq("id", idEv).then(() => {}) : Promise.resolve());
    if (rt?.waitUntil) rt.waitUntil(tarefaJson); else await tarefaJson;
    return json({ ok: true });
  }
  let campos = new URLSearchParams();
  let regiao: [number, number] | null = null;
  const achado = acharChave(bruto, "message_body");
  const dec = new TextDecoder();
  if (achado) {
    const [ini, fim] = achado;
    regiao = [ini + "message_body=".length, fim];
    campos = new URLSearchParams(dec.decode(bruto.subarray(0, ini > 0 ? ini - 1 : 0)) + dec.decode(bruto.subarray(fim)));
    const t = (campos.get("message_type") ?? "").trim().toLowerCase();
    if (!MIDIAS.has(TIPOS[t] ?? t) && regiao[1] - regiao[0] <= 1048576) { campos.set("message_body", textoDe(bruto, regiao[0], regiao[1])); regiao = null; }
  } else {
    campos = new URLSearchParams(dec.decode(bruto));
  }
  const ev = await sb.from("wa_webhook_evento").insert({ numero_id: numero, tipo: "whatsgw", bytes_corpo: bruto.length, tinha_midia: !!regiao, id_evento: null }).select("id").maybeSingle();
  const tarefa = processar(numero, ev.data?.id ?? null, campos, bruto, regiao);
  if (rt?.waitUntil) rt.waitUntil(tarefa); else await tarefa;
  return json({ ok: true });
});
