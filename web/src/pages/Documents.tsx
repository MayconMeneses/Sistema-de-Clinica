import { useRef, useState, type FormEvent } from 'react';
import { downloadFile, get, post } from '../api';
import { dateTimeOf } from '../format';
import { Badge, Button, Empty, ErrorBox, Select, Spinner, TextInput, useLoad, useToast } from '../ui';

interface Doc { id: string; title: string; category: Category; fileName: string; mimeType: string; sizeBytes: number; createdAt: string; authorName: string | null; archivedAt: string | null; archiveReason: string | null }
type Category = 'exam' | 'report' | 'consent' | 'identity' | 'other';
const CATEGORY: Record<Category, string> = { exam: 'Exame', report: 'Laudo', consent: 'Termo', identity: 'Documento pessoal', other: 'Outro' };
const MAX = 5 * 1024 * 1024;
const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    r.readAsDataURL(file);
  });
}

export function Documents({ patientId, canWrite }: { patientId: string; canWrite: boolean }) {
  const toast = useToast();
  const [showArchived, setShowArchived] = useState(false);
  const list = useLoad(() => get<{ documents: Doc[] }>(`/api/patients/${patientId}/documents${showArchived ? '?includeArchived=1' : ''}`), [patientId, showArchived]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [f, setF] = useState({ title: '', category: 'exam' as Category });
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!file) { setError('Escolha o arquivo (PDF, PNG, JPG ou WEBP).'); return; }
    if (file.size > MAX) { setError('O arquivo passa de 5 MB.'); return; }
    if (f.title.trim().length < 2) { setError('Dê um título ao documento.'); return; }
    setBusy('send'); setError(null);
    try {
      await post(`/api/patients/${patientId}/documents`, { title: f.title.trim(), category: f.category, fileName: file.name, contentBase64: await toBase64(file) });
      toast('Documento anexado.'); setF({ ...f, title: '' }); setFile(null); if (fileRef.current) fileRef.current.value = ''; list.reload();
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }
  async function archive(d: Doc) {
    const reason = window.prompt(`Por que arquivar "${d.title}"? O arquivo continua guardado, mas sai da lista. (mín. 3 letras)`);
    if (!reason) return;
    setBusy(d.id);
    try { await post(`/api/documents/${d.id}/archive`, { reason }); toast('Documento arquivado.'); list.reload(); }
    catch (err) { toast((err as Error).message, 'bad'); } finally { setBusy(null); }
  }
  async function download(d: Doc) {
    setBusy(d.id);
    try { await downloadFile(`/api/documents/${d.id}/download`, d.fileName); } catch (err) { toast((err as Error).message, 'bad'); } finally { setBusy(null); }
  }

  return (
    <div className="stack">
      {canWrite && (
        <form className="card" onSubmit={send} noValidate>
          <h2>Anexar documento</h2>
          <TextInput label="Título" value={f.title} onChange={(v) => setF({ ...f, title: v })} />
          <Select label="Tipo" value={f.category} onChange={(v) => setF({ ...f, category: v as Category })}>
            {Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <div className="field">
            <label htmlFor="doc-file">Arquivo (PDF, PNG, JPG ou WEBP, até 5 MB)</label>
            <input id="doc-file" ref={fileRef} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>
          {error && <p role="alert" className="error">{error}</p>}
          <Button type="submit" busy={busy === 'send'}>Anexar</Button>
        </form>
      )}
      <div className="row between">
        <h2>Documentos</h2>
        <label className="small"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Mostrar arquivados</label>
      </div>
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.data?.documents.length === 0 && <Empty title="Nenhum documento">Anexe exames, laudos e termos assinados do paciente.</Empty>}
      <ul className="list">
        {list.data?.documents.map((d) => (
          <li key={d.id} className="list-item stack">
            <div className="row between">
              <strong>{d.title}</strong>
              <span className="row">{d.archivedAt && <Badge>Arquivado</Badge>}<Badge tone="info">{CATEGORY[d.category]}</Badge></span>
            </div>
            <span className="small muted">{d.fileName} · {size(d.sizeBytes)} · {dateTimeOf(d.createdAt)}{d.authorName ? ` · ${d.authorName}` : ''}</span>
            {d.archiveReason && <span className="small muted">Motivo do arquivamento: {d.archiveReason}</span>}
            <div className="row">
              <Button variant="secondary" className="btn-sm" busy={busy === d.id} onClick={() => download(d)}>Baixar</Button>
              {canWrite && !d.archivedAt && <Button variant="ghost" className="btn-sm" onClick={() => archive(d)}>Arquivar</Button>}
            </div>
          </li>
        ))}
      </ul>
      <p className="small muted">Cada download fica registrado no histórico de acessos. Documentos não são excluídos, só arquivados com motivo.</p>
    </div>
  );
}
