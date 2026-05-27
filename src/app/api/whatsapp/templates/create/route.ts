import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

type TemplateCategory = 'Marketing' | 'Utility' | 'Authentication'

interface CreateTemplateBody {
  template_type?: 'standard' | 'call_permission_request'
  name?: string
  category?: TemplateCategory
  language?: string
  body_text?: string
  footer_text?: string | null
  header_type?: string | null
  header_content?: string | null
}

type ParameterFormat = 'named' | 'positional'

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

function extractNamedParams(text: string): string[] {
  const matches = text.match(/\{\{([a-z_][a-z0-9_]*)\}\}/g) ?? []
  return Array.from(
    new Set(
      matches
        .map((m) => m.replace('{{', '').replace('}}', ''))
        .filter(Boolean)
    )
  )
}

function extractPositionalParams(text: string): number[] {
  const matches = text.match(/\{\{([1-9][0-9]*)\}\}/g) ?? []
  return Array.from(
    new Set(
      matches
        .map((m) => Number(m.replace('{{', '').replace('}}')))
        .filter((n) => Number.isInteger(n) && n > 0)
    )
  ).sort((a, b) => a - b)
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
    const name = body.name?.trim()
    const templateType = body.template_type || 'standard'
    const language = body.language?.trim() || 'en_US'
    const bodyText = body.body_text?.trim()
    const footerText = body.footer_text?.trim() || null
    const headerTypeRaw = body.header_type?.trim() || null
    const headerType = headerTypeRaw === 'none' ? null : headerTypeRaw
    const headerContent = body.header_content?.trim() || null

    if (!name) {
      return NextResponse.json(
        { error: 'Template name is required' },
        { status: 400 }
      )
    }
    if (!bodyText) {
      return NextResponse.json(
        { error: 'Body text is required' },
        { status: 400 }
      )
    }

    // This form currently supports only TEXT headers. Media headers require
    // additional sample data / media handles that are not captured here.
    if (headerType && headerType !== 'text') {
      return NextResponse.json(
        {
          error:
            'Only text headers are supported from this form right now. For image/video/document headers, create the template in Meta Manager.',
        },
        { status: 400 }
      )
    }
    if (headerType === 'text' && !headerContent) {
      return NextResponse.json(
        { error: 'Header text is required when header type is text.' },
        { status: 400 }
      )
    }
    if (templateType === 'call_permission_request') {
      if (body.category === 'Authentication') {
        return NextResponse.json(
          {
            error:
              'Call permission request templates only support MARKETING or UTILITY categories.',
          },
          { status: 400 }
        )
      }
      if (headerType || footerText) {
        return NextResponse.json(
          {
            error:
              'Call permission request templates cannot include header/footer from this form.',
          },
          { status: 400 }
        )
      }
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
            'WhatsApp not configured. Connect your WhatsApp account in Settings first.',
        },
        { status: 400 }
      )
    }
    if (!config.waba_id) {
      return NextResponse.json(
        {
          error:
            'WABA ID missing. Re-connect your WhatsApp account in Settings.',
        },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)
    const namedParams = extractNamedParams(bodyText)
    const positionalParams = extractPositionalParams(bodyText)
    if (namedParams.length > 0 && positionalParams.length > 0) {
      return NextResponse.json(
        {
          error:
            'Template body cannot mix named and positional variables. Use either {{name}} or {{1}} format, not both.',
        },
        { status: 400 }
      )
    }

    let parameterFormat: ParameterFormat | null = null
    if (namedParams.length > 0) parameterFormat = 'named'
    if (positionalParams.length > 0) parameterFormat = 'positional'

    const bodyComponent: {
      type: 'BODY'
      text: string
      example?:
        | {
            body_text_named_params: Array<{
              param_name: string
              example: string
            }>
          }
        | {
            body_text: string[][]
          }
    } = { type: 'BODY', text: bodyText }

    if (parameterFormat === 'named') {
      bodyComponent.example = {
        body_text_named_params: namedParams.map((p) => ({
          param_name: p,
          example: p === 'first_name' ? 'Pablo' : `example_${p}`,
        })),
      }
    } else if (parameterFormat === 'positional') {
      if (templateType === 'call_permission_request') {
        return NextResponse.json(
          {
            error:
              'Call permission request templates require named parameters (e.g. {{first_name}}), not positional {{1}}.',
          },
          { status: 400 }
        )
      }
      bodyComponent.example = {
        body_text: [
          positionalParams.map((idx) =>
            idx === 1 ? 'Pablo' : `example_${idx}`
          ),
        ],
      }
    }

    const payload: {
      name: string
      category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION'
      language: string
      parameter_format?: ParameterFormat
      components: Array<
        | { type: 'header'; format: 'TEXT'; text: string }
        | { type: 'body'; text: string; example?: typeof bodyComponent.example }
        | { type: 'footer'; text: string }
        | { type: 'call_permission_request' }
      >
    } = {
      name,
      category: toMetaCategory(body.category),
      language,
      components: [
        ...(templateType === 'standard' && headerType === 'text'
          ? [{ type: 'header', format: 'TEXT', text: headerContent }]
          : []),
        {
          type: 'body',
          text: bodyComponent.text,
          ...(bodyComponent.example ? { example: bodyComponent.example } : {}),
        },
        ...(templateType === 'call_permission_request'
          ? [{ type: 'call_permission_request' as const }]
          : []),
        ...(templateType === 'standard' && footerText
          ? [{ type: 'footer' as const, text: footerText }]
          : []),
      ],
    }
    if (templateType === 'call_permission_request') {
      payload.parameter_format = 'named'
    } else if (parameterFormat) {
      payload.parameter_format = parameterFormat
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

    if (!metaRes.ok) {
      let message = `Meta API error: ${metaRes.status}`
      try {
        const err = await metaRes.json()
        if (err?.error?.message) message = err.error.message
      } catch {
        // no-op
      }
      return NextResponse.json({ error: message }, { status: 502 })
    }

    const metaBody = (await metaRes.json()) as {
      id?: string
      status?: string
      category?: string
      name?: string
      language?: string
    }

    const status = normalizeStatus(metaBody.status || 'PENDING')

    const row = {
      user_id: user.id,
      name,
      category: body.category || 'Marketing',
      language,
      body_text: bodyText,
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
        id: metaBody.id || null,
        name,
        language,
        status,
      },
    })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to create template',
      },
      { status: 500 }
    )
  }
}
