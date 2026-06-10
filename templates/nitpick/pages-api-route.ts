/**
 * Nitpick — dev-only feedback sink (Next.js Pages Router variant).
 *
 * Use this ONLY if the project uses the Pages Router. Scaffold to: pages/api/nitpick.ts
 * (or src/pages/api/nitpick.ts). For App Router projects, use route.ts instead.
 *
 * Note the bodyParser sizeLimit bump: screenshots easily exceed the 1mb Pages default.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { promises as fs } from 'fs';
import path from 'path';

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };

const DIR = path.join(process.cwd(), '.nitpick');
const DRAFT_DIR = path.join(DIR, '.draft');
const isDev = () => process.env.NODE_ENV !== 'production';
const pad = (n: number) => String(n).padStart(3, '0');
const safeId = (s: unknown): string | null => (typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null);

interface DraftMeta { file: string; route: string | null }

interface Queue {
  items: Array<{ id: string; status: string; comment: string; route: string | null }>;
  nextId: number;
}

async function readQueue(): Promise<Queue> {
  try {
    const raw = await fs.readFile(path.join(DIR, 'queue.json'), 'utf8');
    const q = JSON.parse(raw);
    return {
      items: Array.isArray(q.items) ? q.items : [],
      nextId: typeof q.nextId === 'number' ? q.nextId : 1,
    };
  } catch {
    return { items: [], nextId: 1 };
  }
}

function dataUrlToBuffer(dataUrl: unknown): { buf: Buffer; ext: string } | null {
  if (typeof dataUrl !== 'string') return null;
  const m = /^data:image\/(png|jpeg|jpg|webp|gif);base64,(.*)$/.exec(dataUrl);
  if (!m) return null;
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  return { buf: Buffer.from(m[2], 'base64'), ext };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!isDev()) return res.status(410).send('Nitpick is disabled in production');

  if (req.method === 'GET') {
    return res.status(200).json(await readQueue());
  }
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  const body = req.body ?? {};
  const op = typeof body.op === 'string' ? body.op : 'save';

  // stream a single record-shot into a draft folder
  if (op === 'stage') {
    const draftId = safeId(body.draftId);
    const img = dataUrlToBuffer(body.image);
    if (!draftId || !img) return res.status(400).send('Bad stage request');
    const dir = path.join(DRAFT_DIR, draftId);
    await fs.mkdir(dir, { recursive: true });
    let meta: DraftMeta[] = [];
    try { meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8')); } catch { /* new */ }
    const file = `${pad(meta.length + 1)}.${img.ext}`;
    await fs.writeFile(path.join(dir, file), img.buf);
    meta.push({ file, route: typeof body.route === 'string' ? body.route : null });
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
    return res.status(200).json({ ok: true, index: meta.length });
  }
  if (op === 'discard') {
    const draftId = safeId(body.draftId);
    if (draftId) await fs.rm(path.join(DRAFT_DIR, draftId), { recursive: true, force: true }).catch(() => {});
    return res.status(200).json({ ok: true });
  }

  await fs.mkdir(DIR, { recursive: true });
  const queue = await readQueue();
  const id = pad(queue.nextId);

  let screenshot: string | null = null;
  let referenceImage: string | null = null;

  const shot = dataUrlToBuffer(body.screenshot);
  if (shot) {
    screenshot = `${id}.${shot.ext}`;
    await fs.writeFile(path.join(DIR, screenshot), shot.buf);
  }
  const ref = dataUrlToBuffer(body.referenceImage);
  if (ref) {
    referenceImage = `${id}-ref.${ref.ext}`;
    await fs.writeFile(path.join(DIR, referenceImage), ref.buf);
  }

  // Per-screen record shots → <id>-1.png, <id>-2.png, ...
  const screens: Array<{ route: string | null; file: string }> = [];
  // 1) promote streamed draft shots
  const draftId = safeId(body.draftId);
  if (draftId) {
    const dir = path.join(DRAFT_DIR, draftId);
    try {
      const meta: DraftMeta[] = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
      for (const m of meta) {
        const ext = m.file.split('.').pop() || 'png';
        const dest = `${id}-${screens.length + 1}.${ext}`;
        const src = path.join(dir, m.file);
        try { await fs.rename(src, path.join(DIR, dest)); }
        catch { await fs.writeFile(path.join(DIR, dest), await fs.readFile(src)); }
        screens.push({ route: m.route ?? null, file: dest });
      }
    } catch { /* no draft */ }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  // 2) inline screens (back-compat), numbered after staged
  if (Array.isArray(body.screens)) {
    for (const s of body.screens) {
      const img = dataUrlToBuffer(s && s.image);
      if (!img) continue;
      const file = `${id}-${screens.length + 1}.${img.ext}`;
      await fs.writeFile(path.join(DIR, file), img.buf);
      screens.push({ route: s && typeof s.route === 'string' ? s.route : null, file });
    }
  }

  const record = {
    id,
    status: 'open',
    createdAt: new Date().toISOString(),
    comment: typeof body.comment === 'string' ? body.comment : '',
    route: typeof body.route === 'string' ? body.route : null,
    viewport: body.viewport ?? null,
    captureType: typeof body.captureType === 'string' ? body.captureType : null,
    region: body.region ?? null,
    coordSpace: typeof body.coordSpace === 'string' ? body.coordSpace : null,
    element: body.element ?? null,
    targets: Array.isArray(body.targets) ? body.targets : [],
    annotations: Array.isArray(body.annotations) ? body.annotations : [],
    actions: Array.isArray(body.actions) ? body.actions : [],
    screens,
    screenshot,
    referenceImage,
  };
  await fs.writeFile(path.join(DIR, `${id}.json`), JSON.stringify(record, null, 2));

  queue.items.push({ id, status: 'open', comment: record.comment, route: record.route });
  queue.nextId += 1;
  await fs.writeFile(path.join(DIR, 'queue.json'), JSON.stringify(queue, null, 2));

  return res.status(200).json({ ok: true, id });
}
