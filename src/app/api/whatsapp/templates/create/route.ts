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
    const payload = {
      name,
      category: toMetaCategory(body.category),
      language,
      components: [
        ...(headerType === 'text'
          ? [{ type: 'HEADER', format: 'TEXT', text: headerContent }]
          : []),
        { type: 'BODY', text: bodyText },
        ...(footerText ? [{ type: 'FOOTER', text: footerText }] : []),
      ],
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
