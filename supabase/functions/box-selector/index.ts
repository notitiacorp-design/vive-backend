import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MONTH_YEAR_REGEX = /^\d{4}-\d{2}$/

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
  fitness: "augmenter votre niveau d'activitÃ© physique et amÃ©liorer votre condition gÃ©nÃ©rale",
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
  focus: "Ã©largir votre palette d'outils pour la performance mentale",
  nutrition: 'dÃ©couvrir de nouveaux superaliments et complÃ©ments pour enrichir votre alimentation',
  hydration: 'explorer des solutions innovantes pour optimiser votre hydratation',
  mobility: 'dÃ©couvrir de nouvelles pratiques pour la souplesse et la mobilitÃ©',
  immunity: 'explorer de nouvelles pistes pour renforcer votre systÃ¨me immunitaire naturellement',
  energy: "dÃ©couvrir des sources d'Ã©nergie naturelles inÃ©dites pour dynamiser votre quotidien",
}

const DEBUG = Deno.env.get('DEBUG') === 'true'

// Codes SQLSTATE personnalisÃ©s attendus de la RPC PostgreSQL
const PG_RAISE_EXCEPTION_CODE = 'P0001'
const PG_UNIQUE_VIOLATION_CODE = '23505'

// ClÃ©s de message structurÃ© retournÃ©es par la RPC via RAISE EXCEPTION USING HINT
const RPC_ERROR_DUPLICATE_ORDER = 'duplicate_order'
const RPC_ERROR_INSUFFICIENT_STOCK = 'insufficient_stock'

/**
 * Tente de parser le message d'erreur PostgreSQL comme un JSON structurÃ©.
 * La RPC doit Ã©mettre: RAISE EXCEPTION '{"code":"duplicate_order","box_order_id":"..."}' USING ERRCODE = 'P0001';
 */
function parseRpcErrorMessage(message: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(message)
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>
    }
  } catch {
    // message non JSON, ignorer
  }
  return null
}

function errorResponse(
  message: string,
  status: number,
  internalDetails?: unknown
): Response {
  if (internalDetails) {
    console.error(`[box-selector] ${message}:`, internalDetails)
  }
  const body: Record<string, unknown> = { error: message }
  if (DEBUG && internalDetails) {
    body.details = internalDetails instanceof Error
      ? internalDetails.message
      : String(internalDetails)
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405)
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Missing Supabase environment variables')
    }

    // --- Authentification et autorisation ---
    const authHeader = req.headers.get('authorization')
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return errorResponse('Missing or invalid authorization header', 401)
    }
    const callerJwt = authHeader.replace('Bearer ', '').trim()

    // Client authentifiÃ© pour vÃ©rifier l'identitÃ© du caller
    const supabaseAuth = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data: callerData, error: callerError } = await supabaseAuth.auth.getUser(callerJwt)
    if (callerError || !callerData?.user) {
      return errorResponse('Unauthorized: invalid token', 401, callerError)
    }

    const callerUser = callerData.user
    const isAdmin =
      callerUser.app_metadata?.role === 'admin' ||
      callerUser.app_metadata?.claims_admin === true

    // Client service role pour les opÃ©rations DB
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    // --- Parse body ---
    let body: { user_id?: string; month_year?: string }
    try {
      body = await req.json()
    } catch {
      return errorResponse('Invalid JSON body', 400)
    }

    const { user_id, month_year } = body

    if (!user_id || typeof user_id !== 'string') {
      return errorResponse('user_id is required and must be a string', 400)
    }

    if (!UUID_REGEX.test(user_id)) {
      return errorResponse('user_id must be a valid UUID', 400)
    }

    // VÃ©rifier que le caller est bien l'utilisateur concernÃ© ou un admin
    if (!isAdmin && callerUser.id !== user_id) {
      return errorResponse('Forbidden: you can only create box orders for your own account', 403)
    }

    if (!month_year || typeof month_year !== 'string') {
      return errorResponse('month_year is required (format: YYYY-MM)', 400)
    }

    if (!MONTH_YEAR_REGEX.test(month_year)) {
      return errorResponse('month_year must be in format YYYY-MM (e.g. 2025-03)', 400)
    }

    const monthNum = parseInt(month_year.split('-')[1], 10)
    const yearNum = parseInt(month_year.split('-')[0], 10)
    if (monthNum < 1 || monthNum > 12 || yearNum < 2020) {
      return errorResponse('month_year contains an invalid month or year value', 400)
    }

    // --- Step 1: Fetch user profile and jarvis_state ---
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, full_name, email, jarvis_state')
      .eq('id', user_id)
      .single()

    if (profileError || !profile) {
      return errorResponse('User not found', 404, profileError)
    }

    const jarvisState = profile.jarvis_state as {
      bottleneck?: string
      context?: Record<string, unknown>
    } | null

    const currentBottleneck = jarvisState?.bottleneck || null
    const currentContext = jarvisState?.context || {}

    // --- Step 2: Fetch past box_orders to get previously sent module IDs ---
    const { data: pastOrders, error: pastOrdersError } = await supabase
      .from('box_orders')
      .select('hero_module_id, mystery_module_id')
      .eq('user_id', user_id)
      .not('status', 'eq', 'cancelled')

    if (pastOrdersError) {
      console.error('[box-selector] Error fetching past orders:', pastOrdersError)
    }

    const previouslyUsedModuleIds = new Set<string>()
    if (pastOrders) {
      for (const order of pastOrders) {
        if (order.hero_module_id) previouslyUsedModuleIds.add(order.hero_module_id)
        if (order.mystery_module_id) previouslyUsedModuleIds.add(order.mystery_module_id)
      }
    }

    // --- Step 3: Fetch available modules (active=true, stock > 0) avec colonnes explicites ---
    const { data: availableModules, error: modulesError } = await supabase
      .from('modules')
      .select('id, name, category, description, brand, price, image_url, relevance_score, stock, active')
      .eq('active', true)
      .gt('stock', 0)
      .order('relevance_score', { ascending: false })

    if (modulesError) {
      return errorResponse('Failed to fetch modules', 500, modulesError)
    }

    if (!availableModules || availableModules.length === 0) {
      return errorResponse('No modules available in stock', 422)
    }

    // Filter out previously used modules
    const freshModules = availableModules.filter(
      (m: Record<string, unknown>) => !previouslyUsedModuleIds.has(m.id as string)
    )

    if (freshModules.length < 2) {
      console.warn(
        `[box-selector] Only ${freshModules.length} fresh modules available for user ${user_id}. May reuse previous modules.`
      )
    }

    const modulesPool = freshModules.length >= 2 ? freshModules : availableModules

    // --- Step 4: Select hero_module based on bottleneck ---
    let heroModule: Record<string, unknown> | null = null
    let heroCategory: string | null = null

    if (currentBottleneck && BOTTLENECK_TO_CATEGORY[currentBottleneck]) {
      const targetCategory = BOTTLENECK_TO_CATEGORY[currentBottleneck]
      heroCategory = targetCategory

      const categoryModules = modulesPool.filter(
        (m: Record<string, unknown>) => m.category === targetCategory
      )

      if (categoryModules.length > 0) {
        heroModule = categoryModules[0] as Record<string, unknown>
      }
    }

    // Fallback: pick highest relevance module overall
    if (!heroModule) {
      heroModule = modulesPool[0] as Record<string, unknown> || null
      heroCategory = heroModule ? (heroModule.category as string) : null
    }

    if (!heroModule) {
      return errorResponse('Could not select a hero module: no suitable modules available', 422)
    }

    // --- Step 5: Select mystery_module (different category from hero) ---
    const mysteryPool = modulesPool.filter(
      (m: Record<string, unknown>) =>
        m.id !== heroModule!.id &&
        m.category !== heroCategory
    )

    let mysteryModule: Record<string, unknown> | null = null

    if (mysteryPool.length > 0) {
      const topCandidates = mysteryPool.slice(0, Math.min(5, mysteryPool.length))
      const randomIndex = Math.floor(Math.random() * topCandidates.length)
      mysteryModule = topCandidates[randomIndex] as Record<string, unknown>
    } else {
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
      return errorResponse(
        'Could not select a mystery module: insufficient distinct modules available',
        422
      )
    }

    // Build justifications
    const heroJustification = buildHeroJustification(
      heroModule,
      currentBottleneck,
      heroCategory,
      currentContext
    )
    const mysteryJustification = buildMysteryJustification(mysteryModule)

    const selectionContext = {
      bottleneck: currentBottleneck,
      context: currentContext,
      selected_at: new Date().toISOString(),
      hero_category: heroCategory,
      mystery_category: mysteryModule.category,
      fresh_modules_count: freshModules.length,
      total_available: availableModules.length,
    }

    // --- Step 6 + 7: OpÃ©ration atomique via RPC PostgreSQL ---
    // La RPC `create_box_order_atomic` doit:
    //   1. InsÃ©rer la box_order
    //      - En cas de doublon: RAISE EXCEPTION '{"code":"duplicate_order","box_order_id":"<existing_id>"}' USING ERRCODE = 'P0001';
    //   2. DÃ©crÃ©menter le stock hÃ©ros (UPDATE ... WHERE id = ? AND stock > 0)
    //   3. DÃ©crÃ©menter le stock mystÃ¨re (UPDATE ... WHERE id = ? AND stock > 0)
    //      - En cas de stock insuffisant: RAISE EXCEPTION '{"code":"insufficient_stock","module_id":"<id>"}' USING ERRCODE = 'P0001';
    //   4. Retourner { box_order_id } en cas de succÃ¨s
    const { data: rpcResult, error: rpcError } = await supabase.rpc(
      'create_box_order_atomic',
      {
        p_user_id: user_id,
        p_month_year: month_year,
        p_hero_module_id: heroModule.id as string,
        p_mystery_module_id: mysteryModule.id as string,
        p_hero_justification: heroJustification,
        p_mystery_justification: mysteryJustification,
        p_selection_context: selectionContext,
      }
    )

    if (rpcError) {
      // Tentative de parsing du message d'erreur structurÃ© Ã©mis par la RPC
      const structuredError = parseRpcErrorMessage(rpcError.message ?? '')
      const errorCode = structuredError?.code as string | undefined

      // Cas 1: Erreur P0001 avec code structurÃ© 'duplicate_order'
      // La RPC retourne directement l'ID de la commande existante dans le message structurÃ©
      if (
        rpcError.code === PG_RAISE_EXCEPTION_CODE &&
        errorCode === RPC_ERROR_DUPLICATE_ORDER
      ) {
        const existingOrderId = (structuredError?.box_order_id as string) ?? null
        return new Response(
          JSON.stringify({
            error: `A box order already exists for ${month_year}`,
            box_order_id: existingOrderId,
          }),
          { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Cas 2: Violation d'unicitÃ© PostgreSQL native (23505) comme filet de sÃ©curitÃ©
      // Dans ce cas, on ne dispose pas de l'ID existant sans requÃªte supplÃ©mentaire,
      // mais on Ã©vite de faire une requÃªte non atomique; on retourne null pour box_order_id.
      if (rpcError.code === PG_UNIQUE_VIOLATION_CODE) {
        return new Response(
          JSON.stringify({
            error: `A box order already exists for ${month_year}`,
            box_order_id: null,
          }),
          { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Cas 3: Stock insuffisant dÃ©tectÃ© via code SQLSTATE P0001 + code structurÃ©
      if (
        rpcError.code === PG_RAISE_EXCEPTION_CODE &&
        errorCode === RPC_ERROR_INSUFFICIENT_STOCK
      ) {
        return errorResponse('One or more selected modules are out of stock', 422, rpcError)
      }

      return errorResponse('Failed to create box order', 500, rpcError)
    }

    if (!rpcResult || !rpcResult.box_order_id) {
      return errorResponse('Failed to create box order: no ID returned', 500)
    }

    const boxOrderId: string = rpcResult.box_order_id

    // --- Step 8: Return selection ---
    const response = {
      box_order_id: boxOrderId,
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
    console.error('[box-selector] Unexpected error:', error)
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
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
      manque_activite: "votre manque d'activitÃ© physique",
      fatigue_cognitive: 'votre fatigue cognitive',
      nutrition_desequilibree: 'votre alimentation dÃ©sÃ©quilibrÃ©e',
      hydratation: 'votre hydratation insuffisante',
      mobilite: 'vos problÃ¨mes de mobilitÃ©',
      immunite: 'la fragilitÃ© de votre immunitÃ©',
      energie: "votre manque d'Ã©nergie",
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
      hints.push(
        `Avec une moyenne de ${hours.toFixed(1)}h de sommeil par nuit, ce module est particuliÃ¨rement adaptÃ© Ã  votre situation.`
      )
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
      hints.push(`Votre score de stress de ${score}/10 confirme l'urgence d'agir sur cet aspect.`)
    }
  }

  if (context.weekly_activity_minutes && category === 'fitness') {
    const minutes = context.weekly_activity_minutes as number
    if (minutes < 150) {
      hints.push(
        `Avec ${minutes} minutes d'activitÃ© hebdomadaire, ce module vous aidera Ã  atteindre les recommandations OMS.`
      )
    }
  }

  return hints.join(' ')
}
