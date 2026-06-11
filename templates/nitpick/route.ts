/**
 * Nitpick — dev-only feedback sink (Next.js App Router).
 *
 * Receives a feedback report from NitpickOverlay and writes it to `.nitpick/` in the project
 * root. Hard-gated to development: in production it returns 410 and writes nothing.
 *
 * Scaffolded to: app/api/nitpick/route.ts  (or src/app/api/nitpick/route.ts)
 */
import { promises as fs } from 'fs';
import path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DIR = path.join(process.cwd(), '.nitpick');

const isDev = () => process.env.NODE_ENV !== 'production';
const pad = (n: number) => String(n).padStart(3, '0');

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

export async function POST(req: Request) {
  if (!isDev()) return new Response('Nitpick is disabled in production', { status: 410 });

  // Guard against runaway payloads that could OOM the dev server.
  const len = Number(req.headers.get('content-length') || 0);
  if (len > 40 * 1024 * 1024) return new Response('Nitpick payload too large', { status: 413 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
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

  // One cropped screenshot per Inspected element → <id>-1.png, <id>-2.png, … (aligned with targets).
  const targets = Array.isArray(body.targets) ? body.targets.map((t: any) => ({ ...t })) : [];
  const targetImagesIn = Array.isArray(body.targetImages) ? body.targetImages : [];
  const targetImages: string[] = [];
  for (let i = 0; i < targets.length; i++) {
    const img = dataUrlToBuffer(targetImagesIn[i]);
    if (!img) continue;
    const file = `${id}-${i + 1}.${img.ext}`;
    await fs.writeFile(path.join(DIR, file), img.buf);
    targets[i].image = file;
    targetImages.push(file);
  }

  const record = {
    id,
    status: 'open',
    createdAt: new Date().toISOString(),
    comment: typeof body.comment === 'string' ? body.comment : '',
    route: typeof body.route === 'string' ? body.route : null,
    viewport: body.viewport ?? null,
    captureType: typeof body.captureType === 'string' ? body.captureType : null,
    coordSpace: typeof body.coordSpace === 'string' ? body.coordSpace : null,
    meta: body.meta ?? null, // "Fix me" diagnostics — the report is about the Nitpick tool itself
    element: targets[0] ?? body.element ?? null,
    targets,
    targetImages,
    annotations: Array.isArray(body.annotations) ? body.annotations : [],
    actions: Array.isArray(body.actions) ? body.actions : [],
    screenshot,
    referenceImage,
  };
  await fs.writeFile(path.join(DIR, `${id}.json`), JSON.stringify(record, null, 2));

  queue.items.push({ id, status: 'open', comment: record.comment, route: record.route });
  queue.nextId += 1;
  await fs.writeFile(path.join(DIR, 'queue.json'), JSON.stringify(queue, null, 2));

  return Response.json({ ok: true, id });
}

export async function GET() {
  if (!isDev()) return new Response('Not found', { status: 404 });
  return Response.json(await readQueue());
}
