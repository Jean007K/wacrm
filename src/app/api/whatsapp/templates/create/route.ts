import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

type TemplateCategory = 'Marketing' | 'Utility' | 'Authentication'

interface CreateTemplateBody {
  name?: string
  category?: TemplateCategory
  language?: string
  body_text?: string
  footer_text?: string | null
  header_type?: string | null
  header_content?: string | null
}

function toMetaCategory(
  category: TemplateCategory | undefined
): 'MARKETING' | 'UTILITY' | 'AUTHENTICATION' {
  switch (category) {
    case 'Utility':
      return 'UTILITY'
    case 'Authentication':
      return 'AUTHENTICATION'
    default:
      return 'MARKETING'
  }
}

function normalizeStatus(
  meta: string
): 'Draft' | 'Pending' | 'Approved' | 'Rejected' {
  switch (meta.toUpperCase()) {
    case 'APPROVED':
      return 'Approved'
    case 'PENDING':
    case 'IN_APPEAL':
    case 'PENDING_DELETION':
      return 'Pending'
    case 'REJECTED':
    case 'DISABLED':
    case 'PAUSED':
      return 'Rejected'
    default:
      return 'Draft'
  }
}

/** Meta template names: lowercase letters, numbers, underscores only. */
function normalizeTemplateName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
}

function extractPositionalParams(text: string): number[] {
  const matches = text.match(/\{\{([1-9][0-9]*)\}\}/g) ?? []
  return Array.from(
    new Set(
      matches
        .map((m) => Number(m.replace('{{', '').replace('}}', '')))
        .filter((n) => Number.isInteger(n) && n > 0)
    )
  ).sort((a, b) => a - b)
}

type MetaComponent =
  | { type: 'HEADER'; format: 'TEXT'; text: string; example?: { header_text: string[] } }
  | {
      type: 'BODY'
      text?: string
      add_security_recommendation?: boolean
      example?: { body_text: string[][] }
    }
  | { type: 'FOOTER'; text: string }
  | {
      type: 'BUTTONS'
      buttons: Array<{ type: 'OTP'; otp_type: 'COPY_CODE' | 'ONE_TAP' }>
    }

function buildMarketingUtilityComponents(
  bodyText: string,
  footerText: string | null,
  headerType: string | null,
  headerContent: string | null
): MetaComponent[] {
  const components: MetaComponent[] = []

  if (headerType === 'text' && headerContent) {
    const header: MetaComponent = {
      type: 'HEADER',
      format: 'TEXT',
      text: headerContent,
    }
    const headerVars = extractPositionalParams(headerContent)
    if (headerVars.length > 0) {
      header.example = {
        header_text: headerVars.map((i) => (i === 1 ? 'Ejemplo' : `valor_${i}`)),
      }
    }
    components.push(header)
  }

  const body: MetaComponent = { type: 'BODY', text: bodyText }
  const bodyVars = extractPositionalParams(bodyText)
  if (bodyVars.length > 0) {
    body.example = {
      body_text: [
        bodyVars.map((i) => (i === 1 ? 'Juan' : i === 2 ? 'Producto' : `valor_${i}`)),
      ],
    }
  }
  components.push(body)

  if (footerText) {
    components.push({ type: 'FOOTER', text: footerText })
  }

  return components
}

/** Meta AUTHENTICATION templates: OTP copy-code (verification codes). */
function buildAuthenticationComponents(footerText: string | null): MetaComponent[] {
  const components: MetaComponent[] = [
    { type: 'BODY', add_security_recommendation: true },
  ]
  if (footerText) {
    components.push({ type: 'FOOTER', text: footerText })
  }
  components.push({
    type: 'BUTTONS',
    buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }],
  })
  return components
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = (await request.json()) as CreateTemplateBody
    const name = normalizeTemplateName(body.name || '')
    const category = body.category || 'Marketing'
    const metaCategory = toMetaCategory(category)
    const language = body.language?.trim() || 'es'
    const bodyText = body.body_text?.trim() || ''
    const footerText = body.footer_text?.trim() || null
    const headerTypeRaw = body.header_type?.trim() || null
    const headerType = headerTypeRaw === 'none' ? null : headerTypeRaw
    const headerContent = body.header_content?.trim() || null

    if (!name) {
      return NextResponse.json(
        {
          error:
            'Nombre inválido. Usa solo letras minúsculas, números y guiones bajos (ej: confirmacion_pedido).',
        },
        { status: 400 }
      )
    }

    if (metaCategory !== 'AUTHENTICATION' && !bodyText) {
      return NextResponse.json(
        { error: 'El texto del cuerpo es obligatorio.' },
        { status: 400 }
      )
    }

    if (headerType && headerType !== 'text') {
      return NextResponse.json(
        {
          error:
            'Solo se admite encabezado de texto aquí. Para imagen/video/documento, créala en Meta Business Suite.',
        },
        { status: 400 }
      )
    }

    if (headerType === 'text' && !headerContent) {
      return NextResponse.json(
        { error: 'Escribe el texto del encabezado o elige "Sin encabezado".' },
        { status: 400 }
      )
    }

    if (metaCategory === 'AUTHENTICATION' && (headerType || headerContent)) {
      return NextResponse.json(
        {
          error:
            'Las plantillas de autenticación (código OTP) no llevan encabezado. Meta las genera automáticamente.',
        },
        { status: 400 }
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('waba_id, access_token')
      .eq('user_id', user.id)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        {
          error:
            'WhatsApp no está configurado. Conéctalo primero en Ajustes → WhatsApp.',
        },
        { status: 400 }
      )
    }
    if (!config.waba_id) {
      return NextResponse.json(
        {
          error: 'Falta el WABA ID. Vuelve a conectar WhatsApp en Ajustes.',
        },
        { status: 400 }
      )
    }

    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch {
      return NextResponse.json(
        { error: 'Token de WhatsApp inválido. Reconecta tu cuenta en Ajustes.' },
        { status: 400 }
      )
    }

    const components =
      metaCategory === 'AUTHENTICATION'
        ? buildAuthenticationComponents(footerText)
        : buildMarketingUtilityComponents(
            bodyText,
            footerText,
            headerType,
            headerContent
          )

    const payload = {
      name,
      category: metaCategory,
      language,
      components,
    }

    const metaRes = await fetch(
      `${META_API_BASE}/${config.waba_id}/message_templates`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }
    )

    const metaRaw = await metaRes.text()
    let metaJson: {
      id?: string
      status?: string
      error?: { message?: string; error_user_msg?: string }
    } = {}
    try {
      metaJson = metaRaw ? JSON.parse(metaRaw) : {}
    } catch {
      return NextResponse.json(
        {
          error: `Meta respondió sin JSON (HTTP ${metaRes.status}). Revisa el token y permisos de plantillas.`,
        },
        { status: 502 }
      )
    }

    if (!metaRes.ok) {
      const message =
        metaJson.error?.error_user_msg ||
        metaJson.error?.message ||
        `Error de Meta (HTTP ${metaRes.status})`
      return NextResponse.json({ error: message }, { status: 502 })
    }

    const status = normalizeStatus(metaJson.status || 'PENDING')
    const storedBody =
      metaCategory === 'AUTHENTICATION'
        ? 'Código de verificación (OTP)'
        : bodyText

    const row = {
      user_id: user.id,
      name,
      category,
      language,
      body_text: storedBody,
      header_type: headerType,
      header_content: headerType === 'text' ? headerContent : null,
      footer_text: footerText,
      status,
      updated_at: new Date().toISOString(),
    }

    const { data: existing, error: lookupErr } = await supabase
      .from('message_templates')
      .select('id')
      .eq('user_id', user.id)
      .eq('name', name)
      .eq('language', language)
      .maybeSingle()

    if (lookupErr) {
      return NextResponse.json({ error: lookupErr.message }, { status: 500 })
    }

    if (existing?.id) {
      const { error: updErr } = await supabase
        .from('message_templates')
        .update(row)
        .eq('id', existing.id)
      if (updErr) {
        return NextResponse.json({ error: updErr.message }, { status: 500 })
      }
    } else {
      const { error: insErr } = await supabase
        .from('message_templates')
        .insert(row)
      if (insErr) {
        return NextResponse.json({ error: insErr.message }, { status: 500 })
      }
    }

    return NextResponse.json({
      success: true,
      template: {
        id: metaJson.id || null,
        name,
        language,
        status,
      },
    })
  } catch (error) {
    console.error('Create template error:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'No se pudo crear la plantilla',
      },
      { status: 500 }
    )
  }
}
