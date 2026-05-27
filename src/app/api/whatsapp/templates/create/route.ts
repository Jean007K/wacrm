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
    const headerType = body.header_type?.trim() || null

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

    // The current UI has no way to provide header content/examples.
    // Fail fast instead of creating a broken template payload in Meta.
    if (headerType && headerType !== 'none') {
      return NextResponse.json(
        {
          error:
            'Header templates are not supported from this form yet. Create this one in Meta Manager or remove the header type.',
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
      header_type: null,
      header_content: null,
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
