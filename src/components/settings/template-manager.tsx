'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2, Loader2, RefreshCw } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { MessageTemplate } from '@/types';

const CATEGORIES = ['Marketing', 'Utility', 'Authentication'] as const;

const categoryColors: Record<string, string> = {
  Marketing: 'bg-purple-600/20 text-purple-400 border-purple-600/30',
  Utility: 'bg-blue-600/20 text-blue-400 border-blue-600/30',
  Authentication: 'bg-amber-600/20 text-amber-400 border-amber-600/30',
};

const statusColors: Record<string, string> = {
  Draft: 'bg-slate-600/20 text-slate-400 border-slate-600/30',
  Pending: 'bg-yellow-600/20 text-yellow-400 border-yellow-600/30',
  Approved: 'bg-primary/20 text-primary border-primary/30',
  Rejected: 'bg-red-600/20 text-red-400 border-red-600/30',
};

const categoryHelp: Record<(typeof CATEGORIES)[number], string> = {
  Marketing: 'Promociones, ofertas y mensajes comerciales.',
  Utility: 'Confirmaciones, recordatorios y actualizaciones de pedidos.',
  Authentication:
    'Códigos de verificación (OTP). Meta genera el mensaje; solo puedes añadir un pie opcional.',
};

interface TemplateFormData {
  name: string;
  category: MessageTemplate['category'];
  language: string;
  body_text: string;
  header_type: string;
  header_content: string;
  footer_text: string;
}

const emptyForm: TemplateFormData = {
  name: '',
  category: 'Marketing',
  language: 'en_US',
  body_text: '',
  header_type: '',
  header_content: '',
  footer_text: '',
};

const COMMON_LANGUAGE_CODES = [
  'en_US',
  'en_GB',
  'es',
  'es_ES',
  'es_MX',
  'fr',
  'de',
  'it',
  'pt_BR',
  'pt_PT',
];

export function TemplateManager() {
  const supabase = createClient();
  const { user, loading: authLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [form, setForm] = useState<TemplateFormData>(emptyForm);

  const isAuth = form.category === 'Authentication';

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }
    fetchTemplates(user.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user?.id]);

  async function fetchTemplates(userId: string) {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('message_templates')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setTemplates(data || []);
    } catch (err) {
      console.error('Failed to fetch templates:', err);
      toast.error('No se pudieron cargar las plantillas');
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!form.name.trim()) {
      toast.error('El nombre es obligatorio');
      return;
    }
    if (!isAuth && !form.body_text.trim()) {
      toast.error('El mensaje del cuerpo es obligatorio');
      return;
    }
    if (!isAuth && form.header_type === 'text' && !form.header_content.trim()) {
      toast.error('Escribe el encabezado o elige "Sin encabezado"');
      return;
    }

    try {
      setSaving(true);
      if (!user) {
        toast.error('Sesión no válida');
        return;
      }

      const payload = {
        name: form.name.trim(),
        category: form.category,
        language: form.language.trim() || 'en_US',
        body_text: isAuth ? '' : form.body_text.trim(),
        header_type:
          isAuth || !form.header_type || form.header_type === 'none'
            ? null
            : form.header_type,
        header_content:
          !isAuth && form.header_type === 'text'
            ? form.header_content.trim()
            : null,
        footer_text: form.footer_text.trim() || null,
      };

      const res = await fetch('/api/whatsapp/templates/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const raw = await res.text();
      let data: { error?: string; template?: { status?: string } } = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error(
          data?.error ||
            `El servidor no respondió correctamente (HTTP ${res.status}).`,
        );
      }
      if (!res.ok) {
        throw new Error(data?.error || `Error al crear (HTTP ${res.status})`);
      }

      toast.success(
        `Plantilla enviada a Meta (${data?.template?.status || 'Pending'}). Meta debe aprobarla antes de usarla.`,
      );
      setDialogOpen(false);
      setForm(emptyForm);
      await fetchTemplates(user.id);
    } catch (err) {
      console.error('Save error:', err);
      toast.error(
        err instanceof Error ? err.message : 'No se pudo crear la plantilla',
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleSyncFromMeta() {
    if (!user) return;
    setSyncing(true);
    try {
      const res = await fetch('/api/whatsapp/templates/sync', {
        method: 'POST',
      });
      const raw = await res.text();
      let data: {
        error?: string;
        total?: number;
        inserted?: number;
        updated?: number;
        errors?: Array<{ name: string; language: string; message: string }>;
        truncated?: boolean;
      } = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error(`Error del servidor (HTTP ${res.status})`);
      }
      if (!res.ok) {
        throw new Error(data?.error || `Sync failed (HTTP ${res.status})`);
      }
      toast.success(
        `Sincronizadas ${data.total} plantilla${data.total === 1 ? '' : 's'} desde Meta` +
          (data.inserted || data.updated
            ? ` (${data.inserted} nuevas, ${data.updated} actualizadas)`
            : ''),
      );
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        const preview = data.errors
          .slice(0, 3)
          .map((e) => `${e.name} (${e.language})`);
        const suffix =
          data.errors.length > 3 ? `, +${data.errors.length - 3} más` : '';
        toast.error(`Falló sincronizar: ${preview.join(', ')}${suffix}`);
      }
      if (data.truncated) {
        toast.warning('Hay más plantillas en Meta; sincroniza de nuevo si falta alguna.');
      }
      await fetchTemplates(user.id);
    } catch (err) {
      console.error('Template sync error:', err);
      toast.error(
        err instanceof Error ? err.message : 'No se pudo sincronizar',
      );
    } finally {
      setSyncing(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      const { error } = await supabase
        .from('message_templates')
        .delete()
        .eq('id', id);

      if (error) throw error;
      toast.success('Plantilla eliminada de la lista local');
      setTemplates((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      console.error('Delete error:', err);
      toast.error('No se pudo eliminar');
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-4 mt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-white">Plantillas de mensaje</h2>
          <p className="text-sm text-slate-400">
            Crea plantillas de Marketing, Utilidad o Autenticación. Meta las revisa
            y aprueba antes de poder enviarlas.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={handleSyncFromMeta}
            disabled={syncing}
            className="border-slate-700 bg-transparent text-slate-300 hover:bg-slate-800"
          >
            <RefreshCw className={`size-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Sincronizando…' : 'Sincronizar desde Meta'}
          </Button>
          <Button
            onClick={() => {
              setForm(emptyForm);
              setDialogOpen(true);
            }}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            <Plus className="size-4" />
            Nueva plantilla
          </Button>
        </div>
      </div>

      {templates.length === 0 ? (
        <Card className="bg-slate-900 border-slate-700 ring-0 ring-transparent">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-slate-400 text-sm">Aún no hay plantillas.</p>
            <p className="text-slate-500 text-xs mt-1">
              Crea una o sincroniza las aprobadas desde Meta.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {templates.map((template) => (
            <Card
              key={template.id}
              className="bg-slate-900 border-slate-700 ring-0 ring-transparent"
            >
              <CardContent className="flex items-start justify-between pt-4">
                <div className="space-y-2 min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-medium text-white">{template.name}</h3>
                    <Badge
                      className={`text-xs border ${categoryColors[template.category] || ''}`}
                    >
                      {template.category}
                    </Badge>
                    <Badge
                      className={`text-xs border ${statusColors[template.status || 'Draft'] || ''}`}
                    >
                      {template.status || 'Draft'}
                    </Badge>
                    {template.language && (
                      <span className="text-xs text-slate-500 uppercase">
                        {template.language}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-slate-400 line-clamp-2">
                    {template.body_text}
                  </p>
                  {template.footer_text && (
                    <p className="text-xs text-slate-500 italic">
                      {template.footer_text}
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDelete(template.id)}
                  className="text-slate-400 hover:text-red-400 hover:bg-red-950/30 shrink-0 ml-2"
                >
                  <Trash2 className="size-4" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="bg-slate-900 border-slate-700 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-white">Nueva plantilla</DialogTitle>
            <DialogDescription className="text-slate-400">
              Se envía a Meta para revisión. El nombre solo puede usar minúsculas,
              números y guiones bajos.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="text-slate-300">Nombre</Label>
              <Input
                placeholder="ej: confirmacion_pedido"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-slate-300">Categoría</Label>
                <Select
                  value={form.category}
                  onValueChange={(val) => {
                    const cat = val as MessageTemplate['category'];
                    setForm({
                      ...form,
                      category: cat,
                      header_type: cat === 'Authentication' ? '' : form.header_type,
                      header_content:
                        cat === 'Authentication' ? '' : form.header_content,
                    });
                  }}
                >
                  <SelectTrigger className="w-full bg-slate-800 border-slate-700 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-slate-700">
                    {CATEGORIES.map((cat) => (
                      <SelectItem
                        key={cat}
                        value={cat}
                        className="text-white focus:bg-slate-700 focus:text-white"
                      >
                        {cat}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-slate-500">
                  {categoryHelp[form.category as (typeof CATEGORIES)[number]]}
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-slate-300">Idioma</Label>
                <Input
                  list="template-language-codes"
                  placeholder="es_MX"
                  value={form.language}
                  onChange={(e) => setForm({ ...form, language: e.target.value })}
                  className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
                />
                <datalist id="template-language-codes">
                  {COMMON_LANGUAGE_CODES.map((code) => (
                    <option key={code} value={code} />
                  ))}
                </datalist>
              </div>
            </div>

            {!isAuth && (
              <div className="space-y-2">
                <Label className="text-slate-300">Encabezado (opcional)</Label>
                <Select
                  value={form.header_type || 'none'}
                  onValueChange={(val) => {
                    const v = val ?? 'none';
                    setForm({
                      ...form,
                      header_type: v === 'none' ? '' : v,
                      header_content: v === 'text' ? form.header_content : '',
                    });
                  }}
                >
                  <SelectTrigger className="w-full bg-slate-800 border-slate-700 text-white">
                    <SelectValue placeholder="Sin encabezado" />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-slate-700">
                    <SelectItem
                      value="none"
                      className="text-white focus:bg-slate-700 focus:text-white"
                    >
                      Sin encabezado
                    </SelectItem>
                    <SelectItem
                      value="text"
                      className="text-white focus:bg-slate-700 focus:text-white"
                    >
                      Texto
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {!isAuth && form.header_type === 'text' && (
              <div className="space-y-2">
                <Label className="text-slate-300">Texto del encabezado</Label>
                <Input
                  placeholder="Título corto"
                  value={form.header_content}
                  onChange={(e) =>
                    setForm({ ...form, header_content: e.target.value })
                  }
                  className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
                />
              </div>
            )}

            {!isAuth && (
              <div className="space-y-2">
                <Label className="text-slate-300">Mensaje</Label>
                <Textarea
                  placeholder="Hola {{1}}, tu pedido {{2}} está listo."
                  value={form.body_text}
                  onChange={(e) => setForm({ ...form, body_text: e.target.value })}
                  rows={4}
                  className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 resize-none"
                />
                <p className="text-[11px] text-slate-500">
                  Variables: {'{{1}}'}, {'{{2}}'}, etc. Meta pide ejemplos al crear;
                  nosotros los rellenamos automáticamente.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label className="text-slate-300">
                {isAuth ? 'Pie de página (opcional)' : 'Pie de página (opcional)'}
              </Label>
              <Input
                placeholder={
                  isAuth
                    ? 'Ej: Este código caduca en 10 minutos.'
                    : 'Texto pequeño al final'
                }
                value={form.footer_text}
                onChange={(e) => setForm({ ...form, footer_text: e.target.value })}
                className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
              />
            </div>
          </div>

          <DialogFooter className="bg-slate-900 border-slate-700">
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              className="border-slate-700 text-slate-300 hover:bg-slate-800"
            >
              Cancelar
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Enviando a Meta…
                </>
              ) : (
                'Crear plantilla'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
