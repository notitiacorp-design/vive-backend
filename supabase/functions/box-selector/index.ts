import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const BOTTLENECK_TO_CATEGORY: Record<string, string> = {
  sommeil_profond: 'sleep',
  hrv_faible: 'recovery',
  stress_eleve: 'stress',
  manque_activite: 'fitness',
  fatigue_cognitive: 'focus',
  nutrition_desequilibree: 'nutrition',
  hydratation: 'hydration',
  mobilite: 'mobility',
  immunite: 'immunity',
  energie: 'energy',
}

const CATEGORY_JUSTIFICATIONS: Record<string, string> = {
  sleep: 'optimiser la qualitÃ© de votre sommeil et favoriser une rÃ©cupÃ©ration nocturne profonde',
  recovery: 'amÃ©liorer votre variabilitÃ© cardiaque et accÃ©lÃ©rer votre rÃ©cupÃ©ration physique',
  stress: 'rÃ©duire votre niveau de stress et renforcer votre rÃ©silience mentale',
  fitness: 'augmenter votre niveau d\'activitÃ© physique et amÃ©liorer votre condition gÃ©nÃ©rale',
  focus: 'soutenir vos fonctions cognitives et amÃ©liorer votre concentration',
  nutrition: 'rÃ©Ã©quilibrer votre alimentation et optimiser vos apports nutritionnels',
  hydration: 'amÃ©liorer votre hydratation quotidienne et soutenir vos fonctions vitales',
  mobility: 'amÃ©liorer votre mobilitÃ© articulaire et prÃ©venir les blessures',
  immunity: 'renforcer vos dÃ©fenses immunitaires et protÃ©ger votre santÃ©',
  energy: 'booster votre Ã©nergie naturelle et rÃ©duire la fatigue chronique',
}

const MYSTERY_JUSTIFICATIONS: Record<string, string> = {
  sleep: 'dÃ©couvrir de nouvelles approches pour enrichir vos rituels de sommeil',
  recovery: 'explorer des techniques de rÃ©cupÃ©ration complÃ©mentaires Ã  votre routine',
  stress: 'expÃ©rimenter de nouvelles pratiques de gestion du stress et de pleine conscience',
  fitness: 'surprendre votre corps avec une nouvelle discipline sportive ou de bien-Ãªtre',
  focus: 'Ã©largir votre palette d\'outils pour la performance mentale',
  nutrition: 'dÃ©couvrir de nouveaux superaliments et complÃ©ments pour enrichir votre alimentation',
  hydration: 'explorer des solutions innovantes pour optimiser votre hydratation',
  mobility: 'dÃ©couvrir de nouvelles pratiques pour la souplesse et la mobilitÃ©',
  immunity: 'explorer de nouvelles pistes pour renforcer votre systÃ¨me immunitaire naturellement',
  energy: 'dÃ©couvrir des sources d\'Ã©nergie naturelles inÃ©dites pour dynamiser votre quotidien',
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Missing Supabase environment variables')
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })

    let body: { user_id?: string; month_year?: string }
    try {
      body = await req.json()
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { user_id, month_year } = body

    if (!user_id || typeof user_id !== 'string') {
      return new Response(
        JSON.stringify({ error: 'user_id is required and must be a string' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!month_year || typeof month_year !== 'string') {
      return new Response(
        JSON.stringify({ error: 'month_year is required (format: YYYY-MM)' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const monthYearRegex = /^\d{4}-\d{2}$/
    if (!monthYearRegex.test(month_year)) {
      return new Response(
        JSON.stringify({ error: 'month_year must be in format YYYY-MM (e.g. 2025-03)' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Step 1: Fetch user profile and jarvis_state
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, full_name, email, jarvis_state')
      .eq('id', user_id)
      .single()

    if (profileError || !profile) {
      return new Response(
        JSON.stringify({ error: 'User not found', details: profileError?.message }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const jarvisState = profile.jarvis_state as {
      bottleneck?: string
      context?: Record<string, unknown>
    } | null

    const currentBottleneck = jarvisState?.bottleneck || null
    const currentContext = jarvisState?.context || {}

    // Check if a box order already exists for this month
    const { data: existingOrder } = await supabase
      .from('box_orders')
      .select('id')
      .eq('user_id', user_id)
      .eq('month_year', month_year)
      .single()

    if (existingOrder) {
      return new Response(
        JSON.stringify({
          error: `A box order already exists for ${month_year}`,
          box_order_id: existingOrder.id,
        }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Step 2: Fetch past box_orders to get previously sent module IDs
    const { data: pastOrders, error: pastOrdersError } = await supabase
      .from('box_orders')
      .select('hero_module_id, mystery_module_id')
      .eq('user_id', user_id)
      .not('status', 'eq', 'cancelled')

    if (pastOrdersError) {
      console.error('Error fetching past orders:', pastOrdersError)
    }

    const previouslyUsedModuleIds = new Set<string>()
    if (pastOrders) {
      for (const order of pastOrders) {
        if (order.hero_module_id) previouslyUsedModuleIds.add(order.hero_module_id)
        if (order.mystery_module_id) previouslyUsedModuleIds.add(order.mystery_module_id)
      }
    }

    // Step 3: Fetch available modules (active=true, stock > 0)
    const { data: availableModules, error: modulesError } = await supabase
      .from('modules')
      .select('*')
      .eq('active', true)
      .gt('stock', 0)
      .order('relevance_score', { ascending: false })

    if (modulesError) {
      return new Response(
        JSON.stringify({ error: 'Failed to fetch modules', details: modulesError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!availableModules || availableModules.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No modules available in stock' }),
        { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Filter out previously used modules
    const freshModules = availableModules.filter(
      (m: Record<string, unknown>) => !previouslyUsedModuleIds.has(m.id as string)
    )

    if (freshModules.length < 2) {
      // If not enough fresh modules, allow reuse with lower priority
      console.warn(
        `Only ${freshModules.length} fresh modules available for user ${user_id}. May reuse previous modules.`
      )
    }

    const modulesPool = freshModules.length >= 2 ? freshModules : availableModules

    // Step 4: Select hero_module based on bottleneck
    let heroModule: Record<string, unknown> | null = null
    let heroCategory: string | null = null

    if (currentBottleneck && BOTTLENECK_TO_CATEGORY[currentBottleneck]) {
      const targetCategory = BOTTLENECK_TO_CATEGORY[currentBottleneck]
      heroCategory = targetCategory

      // Find best match in target category from fresh modules
      const categoryModules = modulesPool.filter(
        (m: Record<string, unknown>) => m.category === targetCategory
      )

      if (categoryModules.length > 0) {
        // Already sorted by relevance_score descending
        heroModule = categoryModules[0] as Record<string, unknown>
      }
    }

    // Fallback: if no module found for bottleneck category, pick the highest relevance module overall
    if (!heroModule) {
      heroModule = modulesPool[0] as Record<string, unknown> || null
      heroCategory = heroModule ? (heroModule.category as string) : null
    }

    if (!heroModule) {
      return new Response(
        JSON.stringify({ error: 'Could not select a hero module: no suitable modules available' }),
        { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Step 5: Select mystery_module (different category from hero, not previously sent)
    const mysteryPool = modulesPool.filter(
      (m: Record<string, unknown>) =>
        m.id !== heroModule!.id &&
        m.category !== heroCategory
    )

    let mysteryModule: Record<string, unknown> | null = null

    if (mysteryPool.length > 0) {
      // Add element of surprise: shuffle among top candidates
      const topCandidates = mysteryPool.slice(0, Math.min(5, mysteryPool.length))
      const randomIndex = Math.floor(Math.random() * topCandidates.length)
      mysteryModule = topCandidates[randomIndex] as Record<string, unknown>
    } else {
      // Fallback: different module from hero, any category
      const anyOtherModules = modulesPool.filter(
        (m: Record<string, unknown>) => m.id !== heroModule!.id
      )
      if (anyOtherModules.length > 0) {
        const topCandidates = anyOtherModules.slice(0, Math.min(5, anyOtherModules.length))
        const randomIndex = Math.floor(Math.random() * topCandidates.length)
        mysteryModule = topCandidates[randomIndex] as Record<string, unknown>
      }
    }

    if (!mysteryModule) {
      return new Response(
        JSON.stringify({
          error: 'Could not select a mystery module: insufficient distinct modules available',
        }),
        { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Build justifications in French
    const heroJustification = buildHeroJustification(
      heroModule,
      currentBottleneck,
      heroCategory,
      currentContext
    )
    const mysteryJustification = buildMysteryJustification(mysteryModule)

    // Step 6: Create box_order with status 'pending', mode 'validation'
    const { data: boxOrder, error: boxOrderError } = await supabase
      .from('box_orders')
      .insert({
        user_id,
        month_year,
        hero_module_id: heroModule.id,
        mystery_module_id: mysteryModule.id,
        status: 'pending',
        mode: 'validation',
        hero_justification: heroJustification,
        mystery_justification: mysteryJustification,
        selection_context: {
          bottleneck: currentBottleneck,
          context: currentContext,
          selected_at: new Date().toISOString(),
          hero_category: heroCategory,
          mystery_category: mysteryModule.category,
          fresh_modules_count: freshModules.length,
          total_available: availableModules.length,
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (boxOrderError || !boxOrder) {
      return new Response(
        JSON.stringify({
          error: 'Failed to create box order',
          details: boxOrderError?.message,
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Step 7: Decrement stock for selected modules
    const { error: heroStockError } = await supabase
      .from('modules')
      .update({
        stock: (heroModule.stock as number) - 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', heroModule.id)

    if (heroStockError) {
      console.error('Failed to decrement hero module stock:', heroStockError)
      // Attempt rollback of box order
      await supabase.from('box_orders').delete().eq('id', boxOrder.id)
      return new Response(
        JSON.stringify({
          error: 'Failed to reserve hero module stock',
          details: heroStockError.message,
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { error: mysteryStockError } = await supabase
      .from('modules')
      .update({
        stock: (mysteryModule.stock as number) - 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', mysteryModule.id)

    if (mysteryStockError) {
      console.error('Failed to decrement mystery module stock:', mysteryStockError)
      // Attempt partial rollback: restore hero stock and delete box order
      await supabase
        .from('modules')
        .update({ stock: heroModule.stock, updated_at: new Date().toISOString() })
        .eq('id', heroModule.id)
      await supabase.from('box_orders').delete().eq('id', boxOrder.id)
      return new Response(
        JSON.stringify({
          error: 'Failed to reserve mystery module stock',
          details: mysteryStockError.message,
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Step 8: Return selection with justification
    const response = {
      box_order_id: boxOrder.id,
      month_year,
      status: 'pending',
      mode: 'validation',
      hero: {
        module: {
          id: heroModule.id,
          name: heroModule.name,
          category: heroModule.category,
          description: heroModule.description,
          brand: heroModule.brand,
          price: heroModule.price,
          image_url: heroModule.image_url,
          relevance_score: heroModule.relevance_score,
        },
        justification: heroJustification,
        bottleneck_matched: currentBottleneck,
        category: heroCategory,
      },
      mystery: {
        module: {
          id: mysteryModule.id,
          name: mysteryModule.name,
          category: mysteryModule.category,
          description: mysteryModule.description,
          brand: mysteryModule.brand,
          price: mysteryModule.price,
          image_url: mysteryModule.image_url,
          relevance_score: mysteryModule.relevance_score,
        },
        justification: mysteryJustification,
        category: mysteryModule.category,
      },
      selection_metadata: {
        bottleneck: currentBottleneck,
        previously_used_count: previouslyUsedModuleIds.size,
        fresh_modules_available: freshModules.length,
        total_modules_available: availableModules.length,
        selected_at: new Date().toISOString(),
      },
    }

    return new Response(JSON.stringify(response), {
      status: 201,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Unexpected error in box-selector:', error)
    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

function buildHeroJustification(
  module: Record<string, unknown>,
  bottleneck: string | null,
  category: string | null,
  context: Record<string, unknown>
): string {
  const moduleName = module.name as string
  const moduleCategory = category || (module.category as string)

  let bottleneckPhrase = ''
  if (bottleneck) {
    const bottleneckLabels: Record<string, string> = {
      sommeil_profond: 'votre sommeil profond insuffisant',
      hrv_faible: 'votre variabilitÃ© cardiaque basse',
      stress_eleve: 'votre niveau de stress Ã©levÃ©',
      manque_activite: 'votre manque d\'activitÃ© physique',
      fatigue_cognitive: 'votre fatigue cognitive',
      nutrition_desequilibree: 'votre alimentation dÃ©sÃ©quilibrÃ©e',
      hydratation: 'votre hydratation insuffisante',
      mobilite: 'vos problÃ¨mes de mobilitÃ©',
      immunite: 'la fragilitÃ© de votre immunitÃ©',
      energie: 'votre manque d\'Ã©nergie',
    }
    const label = bottleneckLabels[bottleneck] || 'votre principal frein de performance'
    bottleneckPhrase = `En analysant vos donnÃ©es Jarvis, nous avons identifiÃ© ${label} comme votre frein prioritaire ce mois-ci. `
  } else {
    bottleneckPhrase = 'Sur la base de votre profil de bien-Ãªtre actuel, '
  }

  const categoryGoal =
    CATEGORY_JUSTIFICATIONS[moduleCategory] ||
    'amÃ©liorer votre bien-Ãªtre global et votre performance quotidienne'

  const contextHints = buildContextHints(context, moduleCategory)

  return (
    `${bottleneckPhrase}nous avons sÃ©lectionnÃ© **${moduleName}** comme votre module hÃ©ros du mois pour ${categoryGoal}.` +
    (contextHints ? ` ${contextHints}` : '') +
    ' Ce module a Ã©tÃ© spÃ©cialement choisi pour rÃ©pondre Ã  vos besoins actuels et maximiser votre progression vers vos objectifs de santÃ©.'
  )
}

function buildMysteryJustification(module: Record<string, unknown>): string {
  const moduleName = module.name as string
  const moduleCategory = module.category as string

  const categoryGoal =
    MYSTERY_JUSTIFICATIONS[moduleCategory] ||
    'explorer de nouvelles dimensions de votre bien-Ãªtre'

  const surpriseIntros = [
    'Pour ce mois-ci, votre module mystÃ¨re vous invite Ã ',
    'La sÃ©lection surprise de ce mois vous propose de',
    'Nous avons choisi de vous faire',
    'Votre boÃ®te mystÃ¨re vous rÃ©serve une dÃ©couverte pour',
  ]

  const randomIntro = surpriseIntros[Math.floor(Math.random() * surpriseIntros.length)]

  return (
    `${randomIntro} ${categoryGoal} avec **${moduleName}**. ` +
    `Ce module mystÃ¨re a Ã©tÃ© sÃ©lectionnÃ© pour Ã©largir votre expÃ©rience bien-Ãªtre au-delÃ  de vos habitudes et vous faire dÃ©couvrir de nouvelles approches pour optimiser votre vitalitÃ©.`
  )
}

function buildContextHints(
  context: Record<string, unknown>,
  category: string
): string {
  const hints: string[] = []

  if (context.avg_sleep_hours && category === 'sleep') {
    const hours = context.avg_sleep_hours as number
    if (hours < 7) {
      hints.push(`Avec une moyenne de ${hours.toFixed(1)}h de sommeil par nuit, ce module est particuliÃ¨rement adaptÃ© Ã  votre situation.`)
    }
  }

  if (context.avg_hrv && category === 'recovery') {
    const hrv = context.avg_hrv as number
    if (hrv < 50) {
      hints.push(`Votre HRV moyen de ${hrv.toFixed(0)}ms indique un besoin de rÃ©cupÃ©ration accru.`)
    }
  }

  if (context.stress_score && category === 'stress') {
    const score = context.stress_score as number
    if (score > 7) {
      hints.push(`Votre score de stress de ${score}/10 confirme l\'urgence d\'agir sur cet aspect.`)
    }
  }

  if (context.weekly_activity_minutes && category === 'fitness') {
    const minutes = context.weekly_activity_minutes as number
    if (minutes < 150) {
      hints.push(`Avec ${minutes} minutes d\'activitÃ© hebdomadaire, ce module vous aidera Ã  atteindre les recommandations OMS.`)
    }
  }

  return hints.join(' ')
}
