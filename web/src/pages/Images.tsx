import { useRef, useState, type FormEvent } from 'react';
import { downloadFile, get, post } from '../api';
import { Badge, Button, Empty, ErrorBox, Select, Sheet, Spinner, TextInput, useLoad, useToast } from '../ui';

interface Img { id: string; title: string; category: 'xray' | 'photo'; fileName: string; mimeType: string; sizeBytes: number; tooth: string | null; takenOn: string | null; createdAt: string; hasThumbnail: boolean; sharedWithPatient?: boolean; archivedAt: string | null }
const MAX = 5 * 1024 * 1024;
const TEETH = ['11', '12', '13', '14', '15', '16', '17', '18', '21', '22', '23', '24', '25', '26', '27', '28', '31', '32', '33', '34', '35', '36', '37', '38', '41', '42', '43', '44', '45', '46', '47', '48',
  '51', '52', '53', '54', '55', '61', '62', '63', '64', '65', '71', '72', '73', '74', '75', '81', '82', '83', '84', '85'];
const dmy = (ymd: string | null) => (ymd ? ymd.split('-').reverse().join('/') : '');
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

const toBase64 = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
  r.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
  r.readAsDataURL(blob);
});

/** Miniatura JPEG de até 360 px, gerada no navegador: a galeria carrega leve, sem baixar a imagem inteira de cada exame. */
async function makeThumbnail(file: File): Promise<string | undefined> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 360 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale)); canvas.height = Math.max(1, Math.round(bmp.height * scale));
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    for (const q of [0.72, 0.55, 0.4]) {
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', q));
      if (blob && blob.size <= 75 * 1024) return await toBase64(blob);
    }
  } catch { /* formato que o navegador não decodifica: segue sem miniatura */ }
  return undefined;
}

export function Images({ patientId, canWrite, canShare }: { patientId: string; canWrite: boolean; canShare: boolean }) {
  const toast = useToast();
  const [tooth, setTooth] = useState('');
  const list = useLoad(() => get<{ documents: Img[] }>(`/api/patients/${patientId}/documents?kind=images${tooth ? `&tooth=${tooth}` : ''}`), [patientId, tooth]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [f, setF] = useState({ title: '', category: 'xray' as 'xray' | 'photo', tooth: '', takenOn: today() });
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const imgs = list.data?.documents ?? [];

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!file) { setError('Escolha a imagem (PNG, JPG ou WEBP, até 5 MB).'); return; }
    if (file.size > MAX) { setError('A imagem passa de 5 MB.'); return; }
    if (f.title.trim().length < 2) { setError('Dê um título à imagem.'); return; }
    setBusy('send'); setError(null);
    try {
      const thumbnailBase64 = await makeThumbnail(file);
      await post(`/api/patients/${patientId}/documents`, { title: f.title.trim(), category: f.category, fileName: file.name, contentBase64: await toBase64(file), tooth: f.tooth || undefined, takenOn: f.takenOn || undefined, thumbnailBase64 });
      toast('Imagem anexada.'); setF({ ...f, title: '' }); setFile(null); if (fileRef.current) fileRef.current.value = ''; list.reload();
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }
  async function archive(d: Img) {
    const reason = window.prompt(`Por que arquivar "${d.title}"? A imagem continua guardada, mas sai da galeria. (mín. 3 letras)`);
    if (!reason) return;
    setBusy(d.id);
    try { await post(`/api/documents/${d.id}/archive`, { reason }); toast('Imagem arquivada.'); setViewing(null); list.reload(); } catch (err) { toast((err as Error).message, 'bad'); } finally { setBusy(null); }
  }
  async function share(d: Img) {
    setBusy(d.id);
    try { await post(`/api/documents/${d.id}/share`, { shared: !d.sharedWithPatient }); toast(d.sharedWithPatient ? 'Imagem retirada do portal.' : 'Imagem liberada no portal do paciente.'); list.reload(); } catch (err) { toast((err as Error).message, 'bad'); } finally { setBusy(null); }
  }
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2)));
  const cur = viewing !== null ? imgs[viewing] : null;
  const pair = picked.map((id) => imgs.find((i) => i.id === id)).filter((x): x is Img => !!x).sort((a, b) => (a.takenOn ?? a.createdAt).localeCompare(b.takenOn ?? b.createdAt));
  const label = (d: Img) => `${d.category === 'xray' ? 'Radiografia' : 'Foto'}${d.tooth ? ` · dente ${d.tooth}` : ''}${d.takenOn ? ` · ${dmy(d.takenOn)}` : ''}`;

  return (
    <div className="stack">
      {canWrite && (
        <form className="card" onSubmit={send} noValidate>
          <h2>Anexar imagem</h2>
          <TextInput label="Título" value={f.title} onChange={(v) => setF({ ...f, title: v })} />
          <div className="grid2">
            <Select label="Tipo" value={f.category} onChange={(v) => setF({ ...f, category: v as 'xray' | 'photo' })}><option value="xray">Radiografia</option><option value="photo">Foto clínica</option></Select>
            <Select label="Dente (opcional)" value={f.tooth} onChange={(v) => setF({ ...f, tooth: v })}><option value="">Boca toda / não se aplica</option>{TEETH.map((t) => <option key={t} value={t}>{t}</option>)}</Select>
          </div>
          <TextInput label="Data do exame" type="date" value={f.takenOn} onChange={(v) => setF({ ...f, takenOn: v })} />
          <div className="field">
            <label htmlFor="img-file">Imagem (PNG, JPG ou WEBP, até 5 MB)</label>
            <input id="img-file" ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>
          {error && <p role="alert" className="error">{error}</p>}
          <Button type="submit" busy={busy === 'send'}>Anexar imagem</Button>
        </form>
      )}

      <div className="row between">
        <h2>Galeria</h2>
        <span className="row">
          {picked.length === 2 && <Button className="btn-sm" onClick={() => setComparing(true)}>Comparar as 2</Button>}
          <Select label="Dente" value={tooth} onChange={setTooth}><option value="">Todos</option>{TEETH.map((t) => <option key={t} value={t}>{t}</option>)}</Select>
        </span>
      </div>
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.data && imgs.length === 0 && <Empty title="Nenhuma imagem">Anexe radiografias e fotos clínicas do paciente{tooth ? ` do dente ${tooth}` : ''}.</Empty>}
      <ul className="gallery">
        {imgs.map((d, i) => (
          <li key={d.id} className="gallery-item">
            <button type="button" className="gallery-thumb" onClick={() => setViewing(i)} aria-label={`Abrir ${d.title}`}>
              {d.hasThumbnail ? <img src={`/api/documents/${d.id}/thumb`} alt="" loading="lazy" width={160} height={120} /> : <span aria-hidden="true">🖼</span>}
            </button>
            <strong className="small">{d.title}</strong>
            <span className="small muted">{label(d)}</span>
            <label className="check small"><input type="checkbox" checked={picked.includes(d.id)} onChange={() => toggle(d.id)} /> Comparar</label>
          </li>
        ))}
      </ul>
      {picked.length === 1 && <p className="small muted">Marque mais uma imagem para comparar lado a lado.</p>}

      <Sheet open={cur !== null && cur !== undefined} title={cur?.title ?? ''} onClose={() => setViewing(null)}>
        {cur && (
          <div className="stack">
            <p className="small muted">{label(cur)} · {cur.fileName}</p>
            <img className="viewer-img" src={`/api/documents/${cur.id}/image`} alt={cur.title} />
            <div className="row">
              <Button variant="secondary" className="btn-sm" disabled={viewing === 0} onClick={() => setViewing((v) => (v ?? 1) - 1)}>← Anterior</Button>
              <Button variant="secondary" className="btn-sm" disabled={viewing === imgs.length - 1} onClick={() => setViewing((v) => (v ?? 0) + 1)}>Próxima →</Button>
              <Button variant="secondary" className="btn-sm" onClick={() => { void downloadFile(`/api/documents/${cur.id}/download`, cur.fileName).catch((e) => toast((e as Error).message, 'bad')); }}>Baixar</Button>
            </div>
            <div className="row">
              {cur.sharedWithPatient && <Badge tone="ok">No portal</Badge>}
              {canWrite && canShare && <Button variant="ghost" className="btn-sm" busy={busy === cur.id} onClick={() => share(cur)}>{cur.sharedWithPatient ? 'Tirar do portal' : 'Liberar no portal'}</Button>}
              {canWrite && <Button variant="ghost" className="btn-sm" onClick={() => archive(cur)}>Arquivar</Button>}
            </div>
          </div>
        )}
      </Sheet>

      <Sheet open={comparing && pair.length === 2} title="Comparação" onClose={() => setComparing(false)}>
        <div className="compare">
          {pair.map((d, i) => (
            <figure key={d.id}>
              <figcaption className="small"><strong>{i === 0 ? 'Antes' : 'Depois'}</strong> · {d.title}<br /><span className="muted">{label(d)}</span></figcaption>
              <img className="viewer-img" src={`/api/documents/${d.id}/image`} alt={d.title} />
            </figure>
          ))}
        </div>
      </Sheet>
    </div>
  );
}
